import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs/promises';
import { HuntStatus, FrameSource, InputController, GBAButton, ButtonSequence } from '../types';
import { config } from '../config';
import { logger } from '../logger';
import { detectShiny } from '../detection/shiny-detector';
import { extractSummaryInfo } from '../detection/summary-info';
import { getStaticSequences } from './sequences';

/**
 * Static encounter shiny hunt engine.
 *
 * Used for: fossil revival (Cinnabar Lab), gift Pokemon, casino prizes, etc.
 *
 * Flow:
 * 1. Game is pre-saved in front of the NPC who gives the Pokemon
 * 2. Soft reset
 * 3. Load save → interact with NPC (mash A through dialogue) → receive Pokemon
 * 4. Open summary → check if shiny
 * 5. If not shiny → soft reset and repeat
 *
 * The received Pokemon goes into the party. PARTY_SLOT config determines
 * which slot to check in the summary (default: 2, since most setups have
 * 1 Pokemon + the new one).
 */

type StaticHuntState =
  | 'IDLE'
  | 'SOFT_RESET'
  | 'WAIT_BOOT'
  | 'TITLE_AND_LOAD'
  | 'INTERACT'
  | 'OPEN_SUMMARY'
  | 'READ_RESULT'
  | 'SHINY_FOUND'
  | 'RESET';

export class StaticHuntEngine extends EventEmitter {
  private state: StaticHuntState = 'IDLE';
  private attempts = 0;
  private startedAt: number | null = null;
  private running = false;
  private frameSource: FrameSource;
  private input: InputController;
  private target: string;
  private game: string;
  private partySlot: number; // 1-based slot of the received Pokemon

  // Encounter log for dashboard
  public encounterLog: Array<{
    attempt: number;
    time: number;
    nature: string;
    gender: string;
    isShiny: boolean;
    detectionDebug: string;
  }> = [];

  constructor(frameSource: FrameSource, input: InputController) {
    super();
    this.frameSource = frameSource;
    this.input = input;
    this.target = config.hunt.target;
    this.game = config.hunt.game;
    this.partySlot = parseInt(process.env.PARTY_SLOT || '2', 10);
  }

  getStatus(): HuntStatus {
    const now = Date.now();
    const elapsed = this.startedAt ? (now - this.startedAt) / 1000 : 0;
    return {
      state: this.state as any,
      encounters: this.attempts,
      target: this.target,
      game: this.game,
      startedAt: this.startedAt,
      elapsedSeconds: elapsed,
      encountersPerHour: elapsed > 0 ? Math.round((this.attempts / elapsed) * 3600) : 0,
      running: this.running,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;

    logger.info(`[Static Hunt] Starting: ${this.target} in ${this.game}`);
    logger.info(`[Static Hunt] Party slot: ${this.partySlot} (set PARTY_SLOT env to change)`);
    logger.info('[Static Hunt] Shiny detection: summary screen border color');

    this.running = true;
    this.attempts = 0;
    this.startedAt = Date.now();
    this.state = 'SOFT_RESET';
    this.emit('started', this.getStatus());

    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[Static Hunt] Error in state ${this.state}: ${msg}`);
        this.state = 'SOFT_RESET';
        await this.wait(1000);
      }
    }
  }

  stop(): void {
    logger.info(`[Static Hunt] Stopping after ${this.attempts} attempts`);
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
        // Wait for BIOS + Game Freak logo
        await this.wait(config.env === 'switch' ? 6000 : 4500);
        this.state = 'TITLE_AND_LOAD';
        break;

      case 'TITLE_AND_LOAD':
        await this.titleAndLoad();
        break;

      case 'INTERACT':
        await this.interactWithNPC();
        break;

      case 'OPEN_SUMMARY':
        await this.openSummary();
        break;

      case 'READ_RESULT':
        await this.readAndProcess();
        break;

      case 'SHINY_FOUND':
        logger.info('[Static Hunt] *** SHINY FOUND! ***');
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

  /**
   * Mash through title screen and load save.
   */
  private async titleAndLoad(): Promise<void> {
    const seqs = getStaticSequences(this.game, this.target);

    // Title screen
    await this.executeSequence(seqs.title);

    // Load save
    await this.executeSequence(seqs.loadSave);

    // Mash through recap dialogue (generous A pressing)
    for (let i = 0; i < 12 && this.running; i++) {
      await this.input.pressButton('A', 50);
      await this.wait(300);
    }
    await this.wait(500);

    logger.info('[Static Hunt] Save loaded, ready to interact');
    this.state = 'INTERACT';
  }

  /**
   * Interact with the NPC to receive the Pokemon.
   */
  private async interactWithNPC(): Promise<void> {
    const seqs = getStaticSequences(this.game, this.target);
    await this.executeSequence(seqs.interact);
    logger.info('[Static Hunt] Interaction complete, opening summary');
    this.state = 'OPEN_SUMMARY';
  }

  /**
   * Open the party menu and navigate to the correct slot for summary.
   */
  private async openSummary(): Promise<void> {
    // START → POKéMON
    await this.input.pressButton('START', 50);
    await this.wait(400);
    await this.input.pressButton('A', 50);
    await this.wait(600);

    // Navigate DOWN to the correct party slot
    // Slot 1 = no DOWN presses, Slot 2 = 1 DOWN, etc.
    for (let i = 1; i < this.partySlot; i++) {
      await this.input.pressButton('DOWN', 50);
      await this.wait(200);
    }

    // Select the Pokemon
    await this.input.pressButton('A', 50);
    await this.wait(400);

    // SUMMARY option
    await this.input.pressButton('A', 50);
    await this.wait(500);

    // Safety A + wait for summary screen render
    await this.input.pressButton('A', 50);
    await this.wait(1300);

    this.state = 'READ_RESULT';
  }

  /**
   * Read the summary screen and check for shiny.
   */
  private async readAndProcess(): Promise<void> {
    this.attempts++;

    const frame = await this.frameSource.captureFrame();
    const detection = await detectShiny(frame, this.target, this.game);

    // Save encounter screenshot (non-blocking)
    try {
      const debugPath = path.join(
        process.cwd(), config.paths.screenshots,
        `static-${this.target}-${this.attempts}-${Date.now()}.png`
      );
      fs.writeFile(debugPath, frame).catch(() => {});
    } catch { /* ignore */ }

    // Extract nature + gender from summary
    let nature: string | null = null;
    let gender: 'male' | 'female' | 'unknown' = 'unknown';
    if (detection.debugInfo !== 'not on summary screen') {
      try {
        const info = await extractSummaryInfo(frame, { skipTID: true });
        nature = info.nature;
        gender = info.gender;
      } catch { /* ignore */ }
    }

    const logLine = `[Static Hunt] Attempt #${this.attempts} | ` +
      `${detection.isShiny ? '*** SHINY! ***' : 'normal'} | ` +
      `Nature: ${nature ?? '?'} | Gender: ${gender} | ` +
      `${detection.debugInfo}`;
    logger.info(logLine);

    // Log encounter
    this.encounterLog.push({
      attempt: this.attempts,
      time: Date.now(),
      nature: nature ?? '?',
      gender,
      isShiny: detection.isShiny,
      detectionDebug: detection.debugInfo ?? '',
    });
    if (this.encounterLog.length > 200) this.encounterLog.shift();

    if (detection.isShiny) {
      const screenshotPath = path.join(
        process.cwd(), config.paths.screenshots,
        `static-shiny-${this.target}-${Date.now()}.png`
      );
      await fs.writeFile(screenshotPath, frame);

      this.emit('shiny', {
        pokemon: this.target,
        encounters: this.attempts,
        elapsedSeconds: this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0,
        screenshotPath,
        nature: nature ?? '?',
        gender,
      });

      this.state = 'SHINY_FOUND';
      return;
    }

    // Emit milestone every 100 encounters
    if (this.attempts % 100 === 0) {
      this.emit('milestone', this.getStatus());
    }

    this.state = 'RESET';
  }

  private async executeSequence(sequence: ButtonSequence): Promise<void> {
    for (const step of sequence) {
      if (!this.running) return;
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
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
