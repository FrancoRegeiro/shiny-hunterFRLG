import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs/promises';
import { HuntState, HuntStatus, FrameSource, InputController, ButtonSequence, SequenceStep, GBAButton } from '../types';
import { config } from '../config';
import { logger } from '../logger';
import { detectShiny } from '../detection/shiny-detector';
import { detectScreen } from '../detection/screen-detector';
import { getSequences } from './sequences';

export class HuntEngine extends EventEmitter {
  private state: HuntState = 'IDLE';
  private encounters = 0;
  private startedAt: number | null = null;
  private running = false;
  private frameSource: FrameSource;
  private input: InputController;
  private target: string;
  private game: string;
  private saveSlot: number;

  constructor(frameSource: FrameSource, input: InputController) {
    super();
    this.frameSource = frameSource;
    this.input = input;
    this.target = config.hunt.target;
    this.game = config.hunt.game;
    this.saveSlot = config.hunt.saveStateSlot;
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
    this.state = 'LOAD_STATE';

    this.emit('started', this.getStatus());

    // Enable turbo if configured
    if (config.hunt.turboEnabled) {
      await this.input.setTurbo(true);
    }

    // Main loop
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Hunt engine error in state ${this.state}: ${msg}`);
        // On error, try to reset and continue
        this.state = 'LOAD_STATE';
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
      case 'LOAD_STATE':
        await this.doLoadState();
        break;
      case 'WAIT_SETTLE':
        await this.doWaitSettle();
        break;
      case 'PICK_STARTER':
        await this.doPickStarter();
        break;
      case 'OPEN_PARTY':
        await this.doOpenParty();
        break;
      case 'CAPTURE_AND_DETECT':
        await this.doCaptureAndDetect();
        break;
      case 'SHINY_FOUND':
        await this.doShinyFound();
        break;
      case 'RESET':
        this.state = 'LOAD_STATE';
        break;
      case 'IDLE':
        await this.wait(100);
        break;
    }
  }

  private async doLoadState(): Promise<void> {
    await this.input.loadState(this.saveSlot);
    this.state = 'WAIT_SETTLE';
  }

  private async doWaitSettle(): Promise<void> {
    await this.wait(500);
    this.state = 'PICK_STARTER';
  }

  private async doPickStarter(): Promise<void> {
    const seqs = getSequences(this.game, this.target);
    await this.executeSequence(seqs.pick);
    this.state = 'OPEN_PARTY';
  }

  private async doOpenParty(): Promise<void> {
    const seqs = getSequences(this.game, this.target);
    await this.executeSequence(seqs.summary);
    // Wait a moment for the summary screen to fully render
    await this.wait(300);
    this.state = 'CAPTURE_AND_DETECT';
  }

  private async doCaptureAndDetect(): Promise<void> {
    this.encounters++;

    // Capture the frame
    const frame = await this.frameSource.captureFrame();

    // Verify we're on the summary screen
    const screen = await detectScreen(frame);
    if (screen.screen !== 'summary' && screen.confidence > 0.6) {
      logger.warn(`Expected summary screen, got: ${screen.screen} (conf: ${screen.confidence})`);
      // Try waiting and re-capturing
      await this.wait(500);
      const retryFrame = await this.frameSource.captureFrame();
      const retryScreen = await detectScreen(retryFrame);
      if (retryScreen.screen !== 'summary') {
        logger.warn(`Still not on summary screen after retry. Resetting.`);
        this.state = 'RESET';
        return;
      }
      // Use the retry frame for detection
      return this.runDetection(retryFrame);
    }

    await this.runDetection(frame);
  }

  private async runDetection(frame: Buffer): Promise<void> {
    const result = await detectShiny(frame, this.target, this.game);

    if (result.isShiny) {
      logger.info(`*** SHINY ${this.target.toUpperCase()} FOUND! *** Encounter #${this.encounters}`);
      logger.info(`Detection: ${result.debugInfo}`);

      // Save screenshot
      const screenshotPath = path.join(
        process.cwd(),
        config.paths.screenshots,
        `shiny-${this.target}-${Date.now()}.png`
      );
      await fs.writeFile(screenshotPath, frame);

      this.emit('shiny', {
        pokemon: this.target,
        encounters: this.encounters,
        elapsedSeconds: this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0,
        screenshotPath,
        detection: result,
      });

      this.state = 'SHINY_FOUND';
    } else {
      // Log progress periodically
      if (this.encounters % 10 === 0) {
        const status = this.getStatus();
        logger.info(
          `Encounter #${this.encounters} — ${status.encountersPerHour}/hr — ${result.debugInfo}`
        );
      }

      // Emit milestone events
      if (this.encounters % config.hunt.milestoneInterval === 0) {
        this.emit('milestone', this.getStatus());
      }

      this.state = 'RESET';
    }
  }

  private async doShinyFound(): Promise<void> {
    // Disable turbo
    await this.input.setTurbo(false);
    // Save state in a different slot so we don't overwrite
    await this.input.saveState(this.saveSlot + 1);
    logger.info(`Shiny saved to state slot ${this.saveSlot + 1}`);
    this.stop();
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
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
