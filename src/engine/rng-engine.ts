import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs/promises';
import { HuntStatus, FrameSource, InputController } from '../types';
import { config } from '../config';
import { logger } from '../logger';
import { detectShiny } from '../detection/shiny-detector';
import { extractSummaryInfo } from '../detection/summary-info';
import { getSequences } from './sequences';
import {
  FRLG_ADDRESSES,
  NATURE_NAMES,
  nextSeed,
  findNextShinyFrame,
  ShinySearchResult,
} from './rng';
import { EmulatorInput } from '../drivers/emulator-input';
import { exitSummaryAndSave } from './save-game';

type RngState =
  | 'IDLE'
  | 'SOFT_RESET'
  | 'WAIT_BOOT'
  | 'TITLE_SCREEN'
  | 'LOAD_SAVE'
  | 'READ_IDS'
  | 'WAIT_OVERWORLD'
  | 'NAVIGATE_TO_STARTER'
  | 'READ_SEED'
  | 'WAIT_FOR_SHINY_FRAME'
  | 'PICK_STARTER'
  | 'OPEN_SUMMARY'
  | 'VERIFY_SHINY'
  | 'SHINY_FOUND'
  | 'RESET';

export class RngEngine extends EventEmitter {
  private state: RngState = 'IDLE';
  private attempts = 0;
  private startedAt: number | null = null;
  private running = false;
  private frameSource: FrameSource;
  private input: EmulatorInput;
  private target: string;
  private game: string;

  // RNG state
  private tid = 0;
  private sid = 0;
  private idsKnown = false;
  private targetNature?: number;

  constructor(frameSource: FrameSource, input: EmulatorInput) {
    super();
    this.frameSource = frameSource;
    this.input = input;
    this.target = config.hunt.target;
    this.game = config.hunt.game;
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
      encountersPerHour: 0,
      running: this.running,
    };
  }

  setTargetNature(nature: string): void {
    const idx = NATURE_NAMES.findIndex(n => n.toLowerCase() === nature.toLowerCase());
    if (idx >= 0) {
      this.targetNature = idx;
      logger.info(`RNG: targeting ${NATURE_NAMES[idx]} nature`);
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    logger.info(`[RNG] Starting RNG manipulation: ${this.target} in ${this.game}`);
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
        logger.error(`[RNG] Error in state ${this.state}: ${msg}`);
        this.state = 'SOFT_RESET';
        await this.wait(1000);
      }
    }
  }

  stop(): void {
    logger.info(`[RNG] Stopping after ${this.attempts} attempts`);
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
        // BIOS + Game Freak logo ~4.5s
        await this.wait(4500);
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
        // Mash A through recap dialogue
        for (let i = 0; i < 8; i++) {
          if (!this.running) return;
          await this.input.pressButton('A', 50);
          await this.wait(250);
        }
        await this.wait(400);
        // Read TID/SID after save is fully loaded into memory
        this.state = this.idsKnown ? 'NAVIGATE_TO_STARTER' : 'READ_IDS';
        break;

      case 'READ_IDS':
        await this.readTrainerIds();
        this.state = 'NAVIGATE_TO_STARTER';
        break;

      case 'NAVIGATE_TO_STARTER':
        // Walk to pokeball and advance dialogue to "Do you want [Pokemon]?" prompt
        // Stop just BEFORE pressing A on "Yes" — PID is generated on that press
        await this.navigateToStarterPrompt();
        this.state = 'READ_SEED';
        break;

      case 'READ_SEED':
        await this.readSeedAndFindShiny();
        break;

      case 'WAIT_FOR_SHINY_FRAME':
        // This state is handled inside readSeedAndFindShiny
        break;

      case 'PICK_STARTER':
        // Press A on "Yes" to generate PID on target frame, then handle nickname + rival
        await this.confirmStarterAndFinish();
        this.state = 'OPEN_SUMMARY';
        break;

      case 'OPEN_SUMMARY':
        await this.executeSequence(getSequences(this.game, this.target).summary);
        await this.wait(300);
        this.state = 'VERIFY_SHINY';
        break;

      case 'VERIFY_SHINY':
        await this.verifyShiny();
        break;

      case 'SHINY_FOUND':
        await this.handleShinyFound();
        break;

      case 'RESET':
        this.state = 'SOFT_RESET';
        break;

      case 'IDLE':
        await this.wait(100);
        break;
    }
  }

  private async readTrainerIds(): Promise<void> {
    try {
      // FRLG uses DMA-protected pointers — read the save block pointer, then add offset
      const saveBlockPtr = await this.input.readMemory(FRLG_ADDRESSES.saveBlockPointer, 4);
      logger.info(`[RNG] Save block pointer: 0x${(saveBlockPtr >>> 0).toString(16).padStart(8, '0')}`);

      if (saveBlockPtr === 0) {
        logger.warn(`[RNG] Save block pointer is null — save not loaded yet`);
        this.idsKnown = false;
        return;
      }

      // Read TID and SID from the save block
      this.tid = await this.input.readMemory(saveBlockPtr + FRLG_ADDRESSES.tidOffset, 2);
      this.sid = await this.input.readMemory(saveBlockPtr + FRLG_ADDRESSES.sidOffset, 2);
      this.idsKnown = true;

      logger.info(`[RNG] TID: ${this.tid} (0x${this.tid.toString(16).padStart(4, '0')})`);
      logger.info(`[RNG] SID: ${this.sid} (0x${this.sid.toString(16).padStart(4, '0')})`);
    } catch (err) {
      logger.error(`[RNG] Failed to read TID/SID: ${err}`);
      this.idsKnown = false;
    }
  }

  private async readSeedAndFindShiny(): Promise<void> {
    this.attempts++;

    // Read current RNG seed — we're sitting at the "Yes/No" prompt right now
    const seed = await this.input.readMemory(FRLG_ADDRESSES.rngSeed, 4);
    logger.info(`[RNG] Attempt #${this.attempts} | Seed: 0x${(seed >>> 0).toString(16).padStart(8, '0')} | TID: ${this.tid} SID: ${this.sid}`);

    // Search for next shiny frame
    // A_PRESS_OVERHEAD: frames consumed between pressing A and PID generation
    // Calibrated from 4 data points: consistently 3-4 frames.
    // Using 4 — better to press 1 frame early than late.
    const A_PRESS_OVERHEAD = 4;
    const result = findNextShinyFrame(seed, this.tid, this.sid, 100000, this.targetNature);

    if (!result) {
      logger.info(`[RNG] No shiny frame found within 100k frames. Resetting.`);
      this.state = 'RESET';
      return;
    }

    const nature = NATURE_NAMES[result.result.nature];
    const ivStr = `HP:${result.ivs.hp} Atk:${result.ivs.atk} Def:${result.ivs.def} SpA:${result.ivs.spa} SpD:${result.ivs.spd} Spe:${result.ivs.spe}`;
    logger.info(`[RNG] SHINY FRAME FOUND at offset +${result.frameOffset}!`);
    logger.info(`[RNG] Nature: ${nature} | PID: 0x${(result.result.pid >>> 0).toString(16).padStart(8, '0')} | IVs: ${ivStr}`);

    if (result.frameOffset > 5000) {
      logger.info(`[RNG] Frame too far (${result.frameOffset}). Resetting for closer seed.`);
      this.state = 'RESET';
      return;
    }

    // Target: we need the RNG to be at (shinyFrame - A_PRESS_OVERHEAD) when we press A
    const targetFrame = result.frameOffset - A_PRESS_OVERHEAD;

    // Phase 1: Bulk wait — get close to the target using timer
    const bulkFrames = Math.max(0, targetFrame - 60); // stop 60 frames (~1s) early
    if (bulkFrames > 0) {
      const bulkMs = Math.round(bulkFrames * 16.7);
      logger.info(`[RNG] Phase 1: Bulk waiting ${bulkFrames} frames (~${(bulkMs / 1000).toFixed(1)}s)...`);
      await this.waitWithKeepalive(bulkMs);
    }

    // Phase 2: Precision approach — poll seed and micro-wait until we're within range
    let currentSeed = await this.input.readMemory(FRLG_ADDRESSES.rngSeed, 4);
    let currentFrame = this.countFramesBetween(seed, currentSeed);
    logger.info(`[RNG] Phase 2: Current frame ${currentFrame}, target ${targetFrame} (need to advance ${targetFrame - currentFrame} more)`);

    // Poll until we're at or past (targetFrame - 1) to account for seed-read latency
    // Reading the seed itself takes ~1-2 frames of round-trip time
    const SEED_READ_LATENCY = 1;
    const pressAt = targetFrame - SEED_READ_LATENCY;

    const MAX_POLLS = 200;
    for (let poll = 0; poll < MAX_POLLS && this.running; poll++) {
      if (currentFrame >= pressAt) break;

      const remaining = pressAt - currentFrame;
      // Wait proportionally to remaining frames, but at least 16ms
      const waitMs = Math.max(16, Math.round(remaining * 16.0));
      await this.wait(Math.min(waitMs, 500)); // cap at 500ms per poll

      currentSeed = await this.input.readMemory(FRLG_ADDRESSES.rngSeed, 4);
      currentFrame = this.countFramesBetween(seed, currentSeed);
    }

    logger.info(`[RNG] Pressing A at frame ${currentFrame} (target was ${targetFrame}, shiny at ${result.frameOffset})`);

    // Now press A on "Yes" — PID is generated ~A_PRESS_OVERHEAD frames after this
    this.state = 'PICK_STARTER';
  }

  private async navigateToStarterPrompt(): Promise<void> {
    // From overworld (standing in Oak's lab near pokeballs):
    // A#1 → interact → "Ah! CHARMANDER is your choice. You should raise it patiently."
    // A#2 → "So, MISH, you're claiming the FIRE POKEMON CHARMANDER?" [YES / NO]
    // STOP HERE — the next A press on "Yes" generates the starter PID
    await this.input.pressButton('A', 50);
    await this.wait(1500);
    await this.input.pressButton('A', 50);
    await this.wait(1500);
    // Now sitting at "Yes / No" confirmation prompt
    logger.info('[RNG] At starter confirmation prompt — reading seed');
  }

  private async confirmStarterAndFinish(): Promise<void> {
    // Press A on "Yes" — this generates the starter PID on the current RNG frame
    // Post-confirm flow (from debug screenshots):
    // A#3: "This POKEMON is really quite energetic!"
    // A#4: "MISH received the CHARMANDER from PROF. OAK!"
    // A#5: Still showing (fanfare)
    // A#6: "Do you want to give a nickname?" YES/NO
    await this.input.pressButton('A', 50);
    await this.wait(1200);

    // Mash A through receive text
    for (let i = 0; i < 3 && this.running; i++) {
      await this.input.pressButton('A', 50);
      await this.wait(1200);
    }

    // Now at nickname prompt — decline with B
    await this.wait(500);
    for (let i = 0; i < 3 && this.running; i++) {
      await this.input.pressButton('B', 50);
      await this.wait(400);
    }

    // Rival dialogue + rival picks their Pokemon
    for (let i = 0; i < 5 && this.running; i++) {
      await this.input.pressButton('A', 50);
      await this.wait(200);
    }
    await this.wait(1500);
    for (let i = 0; i < 8 && this.running; i++) {
      await this.input.pressButton('A', 50);
      await this.wait(200);
    }
    await this.wait(200);
  }

  private async verifyShiny(): Promise<void> {
    const frame = await this.frameSource.captureFrame();
    const detection = await detectShiny(frame, this.target, this.game);

    let natureGender = '';
    if (detection.debugInfo !== 'not on summary screen') {
      try {
        const summaryInfo = await extractSummaryInfo(frame);
        const genderStr = summaryInfo.gender === 'male' ? '♂' : summaryInfo.gender === 'female' ? '♀' : '?';
        natureGender = ` | ${summaryInfo.nature ?? 'nature?'} ${genderStr}`;
      } catch { /* ignore */ }
    }

    logger.info(`[RNG] Verification: ${detection.isShiny ? 'SHINY!' : 'not shiny'} | ${detection.debugInfo}${natureGender}`);

    if (detection.isShiny) {
      // Save screenshot
      const screenshotPath = path.join(
        process.cwd(), config.paths.screenshots,
        `rng-shiny-${this.target}-${Date.now()}.png`
      );
      await fs.writeFile(screenshotPath, frame);

      this.emit('shiny', {
        pokemon: this.target,
        encounters: this.attempts,
        elapsedSeconds: this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0,
        screenshotPath,
        detection,
      });

      this.state = 'SHINY_FOUND';
    } else {
      logger.info(`[RNG] Missed the shiny frame. Will retry with new seed.`);
      this.state = 'RESET';
    }
  }

  private async handleShinyFound(): Promise<void> {
    logger.info('[RNG] SHINY FOUND! Exiting summary and saving game...');
    await exitSummaryAndSave(this.input);
    logger.info('[RNG] Game saved with shiny! Stopping.');
    this.stop();
  }

  private async executeSequence(sequence: any[]): Promise<void> {
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

  private countFramesBetween(seedA: number, seedB: number): number {
    // Walk forward from seedA to find seedB (up to 200k frames)
    let s = seedA;
    for (let i = 0; i < 200000; i++) {
      if ((s >>> 0) === (seedB >>> 0)) return i;
      s = nextSeed(s);
    }
    return -1; // not found
  }

  private async waitWithKeepalive(ms: number): Promise<void> {
    // Wait in 10s chunks, reading the seed each time to keep the TCP connection alive
    const CHUNK = 10000;
    let remaining = ms;
    while (remaining > CHUNK && this.running) {
      await this.wait(CHUNK);
      remaining -= CHUNK;
      // Ping the bridge by reading seed (keeps TCP alive, also lets us verify seed is advancing)
      try {
        await this.input.readMemory(FRLG_ADDRESSES.rngSeed, 4);
      } catch { /* ignore keepalive failures */ }
    }
    if (remaining > 0 && this.running) {
      await this.wait(remaining);
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
