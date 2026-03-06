import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs/promises';
import { HuntState, HuntStatus, FrameSource, InputController, ButtonSequence, SequenceStep } from '../types';
import { config } from '../config';
import { logger } from '../logger';
import { detectShiny } from '../detection/shiny-detector';
import { extractSummaryInfo } from '../detection/summary-info';
import { getSequences } from './sequences';
import { exitSummaryAndSave } from './save-game';

export class HuntEngine extends EventEmitter {
  private state: HuntState = 'IDLE';
  private encounters = 0;
  private startedAt: number | null = null;
  private running = false;
  private frameSource: FrameSource;
  private input: InputController;
  private target: string;
  private game: string;

  constructor(frameSource: FrameSource, input: InputController) {
    super();
    this.frameSource = frameSource;
    this.input = input;
    this.target = config.hunt.target;
    this.game = config.hunt.game;
  }

  getStatus(): HuntStatus {
    const now = Date.now();
    const elapsed = this.startedAt ? (now - this.startedAt) / 1000 : 0;
    const rate = elapsed > 0 ? (this.encounters / elapsed) * 3600 : 0;

    return {
      state: this.state,
      encounters: this.encounters,
      target: this.target,
      game: this.game,
      startedAt: this.startedAt,
      elapsedSeconds: elapsed,
      encountersPerHour: Math.round(rate),
      running: this.running,
    };
  }

  async start(): Promise<void> {
    if (this.running) {
      logger.warn('Hunt already running');
      return;
    }

    logger.info(`Starting shiny hunt: ${this.target} in ${this.game}`);
    this.running = true;
    this.encounters = 0;
    this.startedAt = Date.now();
    this.state = 'SOFT_RESET';

    this.emit('started', this.getStatus());

    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Hunt engine error in state ${this.state}: ${msg}`);
        this.state = 'SOFT_RESET';
        await this.wait(1000);
      }
    }
  }

  stop(): void {
    logger.info(`Stopping hunt after ${this.encounters} encounters`);
    this.running = false;
    this.state = 'IDLE';
    this.emit('stopped', this.getStatus());
  }

  private async tick(): Promise<void> {
    switch (this.state) {
      case 'SOFT_RESET':
        await this.input.softReset();
        this.state = 'WAIT_BOOT';
        break;
      case 'WAIT_BOOT':
        // GBA BIOS ~1.5s + Game Freak logo ~3s = 4.5s (unskippable)
        // Random 0-500ms varies RNG frame count for different Pokemon
        await this.wait(4500 + Math.floor(Math.random() * 500));
        this.state = 'TITLE_SCREEN';
        break;
      case 'TITLE_SCREEN':
        await this.executeSequence(getSequences(this.game, this.target).title);
        this.state = 'LOAD_SAVE';
        break;
      case 'LOAD_SAVE':
        await this.executeSequence(getSequences(this.game, this.target).loadSave);
        this.state = 'WAIT_OVERWORLD';
        break;
      case 'WAIT_OVERWORLD':
        // "Previously on your quest..." recap — varies in length, mash enough A presses
        for (let i = 0; i < 8; i++) {
          if (!this.running) return;
          await this.input.pressButton('A', 50);
          await this.wait(250);
        }
        await this.wait(400);
        this.state = 'PICK_STARTER';
        break;
      case 'PICK_STARTER':
        await this.executeSequence(getSequences(this.game, this.target).pick);
        this.state = 'OPEN_SUMMARY';
        break;
      case 'OPEN_SUMMARY':
        await this.executeSequence(getSequences(this.game, this.target).summary);
        await this.wait(300);
        this.state = 'CAPTURE_AND_DETECT';
        break;
      case 'CAPTURE_AND_DETECT':
        await this.doCaptureAndDetect();
        break;
      case 'SHINY_FOUND':
        logger.info('Shiny found! Exiting summary and saving game...');
        await exitSummaryAndSave(this.input);
        logger.info('Game saved with shiny! Stopping hunt — DO NOT RESET.');
        this.stop();
        break;
      case 'RESET':
        this.state = 'SOFT_RESET';
        break;
      case 'IDLE':
        await this.wait(100);
        break;
    }
  }

  private async doCaptureAndDetect(): Promise<void> {
    this.encounters++;

    // Try up to 3 times to land on the summary screen
    let frame: Buffer | null = null;
    let result = await this.captureAndDetectOnce();

    if (!result.detected) {
      // Save debug frame to see what screen we're on
      try {
        const debugPath = path.join(process.cwd(), config.paths.screenshots, `debug-miss-e${this.encounters}.png`);
        await fs.writeFile(debugPath, result.frame);
        logger.info(`Saved debug frame: ${debugPath}`);
      } catch { /* ignore */ }

      // Not on summary — try pressing B to exit wrong screen, then A to re-navigate
      for (let retry = 0; retry < 4 && this.running; retry++) {
        logger.info(`Retry ${retry + 1}: not on summary screen, pressing B...`);
        await this.input.pressButton('B', 50);
        await this.wait(400);
        result = await this.captureAndDetectOnce();
        if (result.detected) {
          logger.info(`Retry ${retry + 1}: found summary screen!`);
          break;
        }
      }
    }

    frame = result.frame;
    const detection = result.result;

    // Extract nature and gender from summary screen
    let natureGender = '';
    if (detection.debugInfo !== 'not on summary screen') {
      try {
        const summaryInfo = await extractSummaryInfo(frame!);
        const genderStr = summaryInfo.gender === 'male' ? '♂' : summaryInfo.gender === 'female' ? '♀' : '?';
        natureGender = ` | ${summaryInfo.nature ?? 'nature?'} ${genderStr}`;
      } catch { /* OCR failure is non-critical */ }
    }

    // Log encounter to Lua bridge log
    this.input.logEncounter?.(this.encounters, detection.isShiny, this.target, (detection.debugInfo ?? '') + natureGender);

    // False positive guard: too few pixels = wrong screen
    if (detection.isShiny && detection.totalSampled < 50) {
      logger.warn(`False positive — ${detection.totalSampled} pixels, wrong screen. Resetting.`);
      this.state = 'RESET';
      return;
    }

    const status = this.getStatus();
    logger.info(
      `[Encounter #${this.encounters}] ${detection.isShiny ? 'SHINY!' : 'normal'} | ` +
      `${status.encountersPerHour}/hr | ${detection.debugInfo}${natureGender}`
    );

    if (detection.isShiny) {
      logger.info(`*** SHINY ${this.target.toUpperCase()} FOUND! *** Encounter #${this.encounters}`);
      logger.info(`Detection: ${detection.debugInfo}`);

      const screenshotPath = path.join(
        process.cwd(), config.paths.screenshots,
        `shiny-${this.target}-${Date.now()}.png`
      );
      await fs.writeFile(screenshotPath, frame!);

      this.emit('shiny', {
        pokemon: this.target,
        encounters: this.encounters,
        elapsedSeconds: this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0,
        screenshotPath,
        detection,
      });

      this.state = 'SHINY_FOUND';
    } else {
      if (this.encounters % config.hunt.milestoneInterval === 0) {
        this.emit('milestone', this.getStatus());
      }

      this.state = 'RESET';
    }
  }

  private async captureAndDetectOnce(): Promise<{
    detected: boolean;
    frame: Buffer;
    result: Awaited<ReturnType<typeof detectShiny>>;
  }> {
    const frame = await this.frameSource.captureFrame();
    const result = await detectShiny(frame, this.target, this.game);
    const detected = result.debugInfo !== 'not on summary screen';
    return { detected, frame, result };
  }

  private async executeSequence(sequence: ButtonSequence): Promise<void> {
    for (const step of sequence) {
      if (!this.running) return;
      await this.executeStep(step);
    }
  }

  private async executeStep(step: SequenceStep): Promise<void> {
    switch (step.action) {
      case 'press':
        await this.input.pressButtons(step.keys, step.holdMs);
        break;
      case 'wait':
        await this.wait(step.ms);
        break;
      case 'mashA':
        for (let i = 0; i < step.count && this.running; i++) {
          await this.input.pressButton('A', 50);
          await this.wait(step.intervalMs);
        }
        break;
      case 'mashB':
        for (let i = 0; i < step.count && this.running; i++) {
          await this.input.pressButton('B', 50);
          await this.wait(step.intervalMs);
        }
        break;
      case 'screenshot':
        await this.debugScreenshot(step.label);
        break;
    }
  }

  private async debugScreenshot(_phase: string): Promise<void> {
    // Disabled for production
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
