import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs/promises';
import { HuntStatus, FrameSource, InputController } from '../types';
import { config } from '../config';
import { logger } from '../logger';
import { detectShiny } from '../detection/shiny-detector';
import { extractSummaryInfo } from '../detection/summary-info';
import { extractStats } from '../detection/stats-ocr';
import { getSequences } from './sequences';
import { exitSummaryAndSave } from './save-game';
import {
  NATURE_NAMES,
  FRLG_ADDRESSES,
  IVs,
  advanceSeed,
  nextSeed,
  generateMethod1,
  isShinyPID,
  generateIVs,
} from './rng';
import { computeIVRanges, ivsMatchRanges } from './iv-calc';
import { getRemainingCount } from './sid-deduction';
import {
  CalibrationState,
  loadCalibration,
  saveCalibration,
  setTID,
  setSID,
  addObservation,
  addPIDObservation,
  selectTarget,
  getTargetBootTiming,
  getCalibrationBootTiming,
  updateTimingOffset,
  skipToMultiSID,
  recordAdvanceHit,
} from './calibration';
import {
  SeedScheduleEntry,
  computeAndLogMultiSIDTargets,
} from './multi-sid-target';
import { seedToBootTimingMs, bootTimingToSeed } from './seed-table';

type SwitchRngState =
  | 'IDLE'
  | 'SOFT_RESET'
  | 'WAIT_BOOT'
  | 'TIMED_TITLE_PRESS'
  | 'LOAD_SAVE'
  | 'WAIT_OVERWORLD'
  | 'NAVIGATE_TO_STARTER'
  | 'PICK_STARTER'
  | 'OPEN_SUMMARY'
  | 'READ_RESULT'
  | 'SHINY_FOUND'
  | 'RESET';

const CALIBRATION_RUNS_NEEDED = 8;

export class SwitchRngEngine extends EventEmitter {
  private state: SwitchRngState = 'IDLE';
  private attempts = 0;
  private startedAt: number | null = null;
  private running = false;
  private frameSource: FrameSource;
  private input: InputController;
  private target: string;
  private game: string;

  private cal: CalibrationState = {
    phase: 'TID_ENTRY',
    tid: null,
    sid: null,
    sidCandidates: [],
    observations: [],
    pidObservations: [],
    biosOffsetMs: 4500,
    advanceWindow: { min: 1050, max: 1250 },
    timingOffsetMs: 0,
    advanceHits: [],
    advanceWindowLocked: false,
    shinyTarget: null,
    allShinyTargets: [],
  };
  private bootTimestamp = 0;
  // Carry summary info from page 1 to page 2
  private lastSummaryNature: string | null = null;
  private lastSummaryNatureIdx = -1;
  private lastSummaryTid: number | null = null;
  private lastSummaryIsShiny = false;
  // Multi-SID targeting state
  private seedSchedule: SeedScheduleEntry[] = [];
  private scheduleIndex = 0;
  private lastScheduleSIDCount = 0;
  private lastTargetedEntry: SeedScheduleEntry | null = null;
  private aPressTimestamp = 0;  // when the timed A press actually happened
  private timingDeltas: number[] = [];  // seed timing errors for auto-calibration
  // Encounter log for dashboard
  public encounterLog: Array<{
    attempt: number;
    time: number;
    nature: string;
    gender: string;
    stats: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number } | null;
    pidMatches: number;
    uniquePID: string | null;
    targetSeed: string;
    targetSIDs: number;
    isShiny: boolean;
    // Frame analysis data
    detectionDebug: string;
    timingMs: number;
    seedDelta: number | null;
    ocrMs: number;
  }> = [];

  constructor(frameSource: FrameSource, input: InputController) {
    super();
    this.frameSource = frameSource;
    this.input = input;
    this.target = config.hunt.target;
    this.game = config.hunt.game;
    // Load calibration eagerly so API calls work before start()
    loadCalibration().then(cal => { this.cal = cal; });
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

  getCalibrationState(): CalibrationState {
    return this.cal;
  }

  getSeedSchedule(): SeedScheduleEntry[] {
    return this.seedSchedule;
  }

  getScheduleSIDCount(): number {
    return this.lastScheduleSIDCount;
  }

  // API: set TID for SID deduction
  async setTID(tid: number): Promise<void> {
    this.cal = setTID(this.cal, tid);
    await saveCalibration(this.cal);
  }

  // API: manually set SID if known
  async setSID(sid: number): Promise<void> {
    this.cal = setSID(this.cal, sid);
    await saveCalibration(this.cal);
  }

  // API: select a shiny target by index
  async selectTarget(index: number): Promise<void> {
    this.cal = selectTarget(this.cal, index);
    await saveCalibration(this.cal);
  }

  // API: skip SID deduction and use multi-SID targeting
  async skipSIDDeduction(): Promise<{ seedCount: number; topSeedSIDs: number }> {
    this.cal = skipToMultiSID(this.cal);
    await saveCalibration(this.cal);

    // Compute seed schedule — filter to seeds that beat standard odds
    const { schedule } = await computeAndLogMultiSIDTargets(
      this.cal.tid!, this.cal.sidCandidates, this.cal.advanceWindow, this.cal.biosOffsetMs,
    );
    const activeSIDCount = this.cal.sidCandidates.filter(s => !s.eliminated).length;
    const minCoverage = Math.ceil(activeSIDCount * 201 / 8192);
    this.seedSchedule = schedule.filter(e => e.sidCount >= minCoverage);
    this.scheduleIndex = 0;
    this.lastScheduleSIDCount = activeSIDCount;

    return {
      seedCount: this.seedSchedule.length,
      topSeedSIDs: this.seedSchedule.length > 0 ? this.seedSchedule[0].sidCount : 0,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.cal = await loadCalibration();

    logger.info(`[Switch RNG] Starting: ${this.target} in ${this.game}`);
    logger.info(`[Switch RNG] Calibration phase: ${this.cal.phase}`);

    if (this.cal.tid !== null) {
      logger.info(`[Switch RNG] TID: ${this.cal.tid} (0x${this.cal.tid.toString(16).padStart(4, '0')})`);
    }
    if (this.cal.sid !== null) {
      logger.info(`[Switch RNG] SID: ${this.cal.sid} (0x${this.cal.sid.toString(16).padStart(4, '0')})`);
    }
    if (this.cal.shinyTarget) {
      logger.info(`[Switch RNG] Target: seed 0x${this.cal.shinyTarget.initialSeed.toString(16).padStart(4, '0')} adv ${this.cal.shinyTarget.advance} ${this.cal.shinyTarget.nature}`);
    }

    if (this.cal.phase === 'TID_ENTRY') {
      logger.warn('[Switch RNG] TID not set. Set via API: POST /api/rng/tid {"tid": 12345}');
      logger.info('[Switch RNG] Will run in standard reset mode until TID is provided.');
    }

    // Pre-compute seed schedule for multi-SID mode — filter to seeds that beat 1/8192
    if (this.cal.phase === 'MULTI_SID_TARGETING' && this.seedSchedule.length === 0) {
      logger.info('[Switch RNG] Computing multi-SID seed schedule...');
      const { schedule } = await computeAndLogMultiSIDTargets(
        this.cal.tid!, this.cal.sidCandidates, this.cal.advanceWindow, this.cal.biosOffsetMs,
      );
      const activeSIDCount = this.cal.sidCandidates.filter(s => !s.eliminated).length;
      const minCoverage = Math.ceil(activeSIDCount * 201 / 8192);
      this.seedSchedule = schedule.filter(e => e.sidCount >= minCoverage);
      logger.info(`[Switch RNG] Schedule: ${this.seedSchedule.length}/${schedule.length} seeds with ≥${minCoverage} SID coverage`);
    }

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
        logger.error(`[Switch RNG] Error in state ${this.state}: ${msg}`);
        this.state = 'SOFT_RESET';
        await this.wait(1000);
      }
    }
  }

  stop(): void {
    logger.info(`[Switch RNG] Stopping after ${this.attempts} attempts`);
    this.running = false;
    this.state = 'IDLE';
    this.emit('stopped', this.getStatus());
  }

  private async tick(): Promise<void> {
    switch (this.state) {
      case 'SOFT_RESET':
        await this.input.softReset();
        this.bootTimestamp = Date.now();
        this.state = 'WAIT_BOOT';
        break;

      case 'WAIT_BOOT':
        // Wait for BIOS + Game Freak logo.
        // DO NOT press A here — it could accidentally hit the title screen
        // and bypass our timed press, giving us a random seed.
        await this.wait(config.env === 'switch' ? 6000 : 4500);
        this.state = 'TIMED_TITLE_PRESS';
        break;

      case 'TIMED_TITLE_PRESS':
        await this.timedTitlePress();
        this.state = 'LOAD_SAVE';
        break;

      case 'LOAD_SAVE':
        if (this.cal.phase === 'TID_ENTRY') {
          // Standard title sequence already handled title + CONTINUE menu.
          // Use standard loadSave + overworld recap flow (8xA matches hunt-engine).
          await this.executeSequence(getSequences(this.game, this.target).loadSave);
          for (let i = 0; i < 8 && this.running; i++) {
            await this.input.pressButton('A', 50);
            await this.wait(250);
          }
          await this.wait(400);
        } else {
          // Timed title press only sent 2 A's — need to mash through
          // remaining title, CONTINUE, and recap dialogue.
          await this.mashToOverworld();
        }
        this.state = 'NAVIGATE_TO_STARTER';
        break;

      case 'NAVIGATE_TO_STARTER':
        // From overworld: interact with pokeball → dialogue → YES/NO prompt
        // The exact number of A presses depends on where mashToOverworld left us.
        // We press A with screenshots to detect the YES/NO prompt, or just use
        // the pick sequence which handles the full dialogue through nickname.
        await this.executeSequence(getSequences(this.game, this.target).pick);
        this.state = 'OPEN_SUMMARY';
        break;

      case 'OPEN_SUMMARY':
        await this.executeSequence(getSequences(this.game, this.target).summary);
        await this.wait(300);
        this.state = 'READ_RESULT';
        break;

      case 'READ_RESULT':
        await this.readAndProcess();
        break;


      case 'SHINY_FOUND':
        logger.info('[Switch RNG] SHINY FOUND! Saving game...');
        if (this.cal.sid !== null) {
          logger.info(`[Switch RNG] Confirmed SID: ${this.cal.sid} (0x${this.cal.sid.toString(16).padStart(4, '0')})`);
          logger.info(`[Switch RNG] TID: ${this.cal.tid} | SID: ${this.cal.sid}`);
        }
        await exitSummaryAndSave(this.input);
        logger.info('[Switch RNG] Game saved! Stopping.');
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
   * Press A at the title screen with precision timing.
   * The exact moment determines the Timer1 value = initial PRNG seed.
   */
  private async timedTitlePress(): Promise<void> {
    const phase = this.cal.phase;
    let targetTimingMs: number;

    if (phase === 'TID_ENTRY') {
      // No calibration yet — use standard title screen sequence
      await this.executeSequence(getSequences(this.game, this.target).title);
      return;
    }

    if (phase === 'SID_DEDUCTION') {
      // Vary timing systematically to sample different seeds
      targetTimingMs = getCalibrationBootTiming(this.cal, this.attempts);
      logger.info(`[Switch RNG] Calibration run ${this.attempts + 1}: target boot timing = ${targetTimingMs}ms`);
    } else if (phase === 'MULTI_SID_TARGETING') {
      // Build schedule if not yet loaded (first run only).
      // Don't rebuild on SID elimination — the schedule is 99%+ valid with 1 fewer SID.
      // Rebuild happens on next server restart when the cache file is stale.
      if (this.seedSchedule.length === 0) {
        const activeSIDCount = this.cal.sidCandidates.filter(s => !s.eliminated).length;
        const { schedule } = await computeAndLogMultiSIDTargets(
          this.cal.tid!, this.cal.sidCandidates, this.cal.advanceWindow, this.cal.biosOffsetMs,
        );
        // Only keep seeds that beat standard 1/8192 odds.
        // Breakeven: sidCount/activeSIDs * 1/201 > 1/8192 → sidCount > activeSIDs*201/8192
        const minCoverage = Math.ceil(activeSIDCount * 201 / 8192);
        this.seedSchedule = schedule.filter(e => e.sidCount >= minCoverage);
        this.lastScheduleSIDCount = activeSIDCount;
        logger.info(`[Switch RNG] Schedule: ${this.seedSchedule.length}/${schedule.length} seeds with ≥${minCoverage} SID coverage (of ${activeSIDCount} active)`);
      }

      if (this.seedSchedule.length > 0) {
        const entry = this.seedSchedule[this.scheduleIndex];
        this.lastTargetedEntry = entry;
        targetTimingMs = entry.targetBootTimingMs + this.cal.timingOffsetMs;
        logger.info(`[Switch RNG] Multi-SID target: seed 0x${entry.initialSeed.toString(16).padStart(4, '0')} timing=${targetTimingMs.toFixed(0)}ms (covers ${entry.sidCount} SIDs) [${this.scheduleIndex + 1}/${this.seedSchedule.length}]`);
        this.scheduleIndex = (this.scheduleIndex + 1) % this.seedSchedule.length;
      } else {
        logger.warn('[Switch RNG] No multi-SID targets found — all SIDs eliminated? Consider recalibrating.');
        await this.executeSequence(getSequences(this.game, this.target).title);
        return;
      }
    } else {
      // We have a target seed — compute exact timing
      const timing = getTargetBootTiming(this.cal);
      if (timing === null) {
        logger.warn('[Switch RNG] No target timing set, using default');
        await this.executeSequence(getSequences(this.game, this.target).title);
        return;
      }
      targetTimingMs = timing;
      logger.info(`[Switch RNG] Targeting seed with boot timing = ${targetTimingMs}ms`);
    }

    // Wait until the target timing relative to boot
    const elapsed = Date.now() - this.bootTimestamp;
    const remaining = targetTimingMs - elapsed;

    if (remaining > 0) {
      // Use high-precision timing for the final approach
      if (remaining > 100) {
        await this.wait(remaining - 50); // get close with setTimeout
      }
      // Busy-wait for final precision (sub-ms accuracy)
      const targetTime = this.bootTimestamp + targetTimingMs;
      while (Date.now() < targetTime) {
        // spin
      }
    }

    // Press A exactly now — record the actual timestamp for seed identification
    this.aPressTimestamp = Date.now();
    await this.input.pressButton('A', 50);
    await this.wait(200);
    // Press A again to dismiss any remaining title elements
    await this.input.pressButton('A', 50);
    await this.wait(500);
  }

  /**
   * Mash through everything from title screen to overworld.
   * After the timed title A press, we still need to navigate through:
   * - Remaining title screen elements
   * - CONTINUE menu
   * - "Previously on your quest..." recap dialogue
   * - Overworld load
   * We use generous A mashing — extra A's on the overworld are harmless
   * (they just make the player interact with whatever's in front).
   */
  private async mashToOverworld(): Promise<void> {
    // Mash A+START to get through title remnants and CONTINUE menu
    for (let i = 0; i < 6 && this.running; i++) {
      await this.input.pressButton('A', 50);
      await this.wait(400);
    }
    await this.input.pressButton('START', 50);
    await this.wait(300);
    await this.input.pressButton('A', 50);
    await this.wait(300);
    await this.input.pressButton('A', 50);
    await this.wait(2000); // wait for save load

    // Mash through recap dialogue (12 presses, generous)
    for (let i = 0; i < 12 && this.running; i++) {
      await this.input.pressButton('A', 50);
      await this.wait(300);
    }
    await this.wait(500);
    logger.info('[Switch RNG] Should be at overworld now');
  }

  private async readAndProcess(): Promise<void> {
    this.attempts++;

    const frame = await this.frameSource.captureFrame();
    const ocrStart = Date.now();
    const detection = await detectShiny(frame, this.target, this.game);

    // Save encounter frame (non-blocking — don't hold up the pipeline)
    try {
      const debugPath = path.join(
        process.cwd(), config.paths.screenshots,
        `encounter-${this.attempts}-${Date.now()}.png`
      );
      fs.writeFile(debugPath, frame).catch(() => {});
    } catch { /* ignore */ }

    // Extract nature + TID + gender from summary screen
    let nature: string | null = null;
    let natureIdx = -1;
    let tid: number | null = null;
    let gender: 'male' | 'female' | 'unknown' = 'unknown';
    if (detection.debugInfo !== 'not on summary screen') {
      try {
        const info = await extractSummaryInfo(frame, { skipTID: this.cal.tid !== null });
        nature = info.nature;
        tid = info.tid ?? this.cal.tid;
        gender = info.gender;
        natureIdx = nature
          ? NATURE_NAMES.findIndex(n => n.toLowerCase() === nature!.toLowerCase())
          : -1;
      } catch { /* ignore */ }
    }

    // Auto-detect TID from summary screen if not set yet
    if (tid !== null && this.cal.tid === null) {
      logger.info(`[Switch RNG] Auto-detected TID from summary: ${tid}`);
      this.cal = setTID(this.cal, tid);
      await saveCalibration(this.cal);
    }

    const bootTimingMs = Date.now() - this.bootTimestamp;
    const logLine = `[Switch RNG] Attempt #${this.attempts} | ` +
      `${detection.isShiny ? 'SHINY!' : 'normal'} | ` +
      `Nature: ${nature ?? '?'}${tid !== null ? ` | TID: ${tid}` : ''} | Phase: ${this.cal.phase} | ` +
      `${detection.debugInfo}`;
    logger.info(logLine);

    // Log encounter to dedicated file
    this.input.logEncounter?.(this.attempts, detection.isShiny, this.target,
      `${nature ?? '?'} | ${detection.debugInfo}`);

    // Check for shiny
    if (detection.isShiny) {
      const screenshotPath = path.join(
        process.cwd(), config.paths.screenshots,
        `switch-rng-shiny-${this.target}-${Date.now()}.png`
      );
      await fs.writeFile(screenshotPath, frame);

      // Attempt to deduce SID from the shiny observation
      let deducedSID: number | null = null;
      if (this.cal.tid !== null && natureIdx >= 0) {
        deducedSID = await this.deduceSIDFromShiny(natureIdx, bootTimingMs);
      }

      // Log with SID info
      const sidInfo = deducedSID !== null
        ? `TID=${this.cal.tid} SID=${deducedSID} (0x${deducedSID.toString(16).padStart(4, '0')})`
        : `TID=${this.cal.tid} SID=unknown`;
      this.input.logEncounter?.(this.attempts, true, this.target,
        `SHINY! ${nature ?? '?'} | ${sidInfo} | ${detection.debugInfo}`);

      const activeSIDs = this.cal.sidCandidates.filter(s => !s.eliminated).length;
      const targetEntry = this.lastTargetedEntry;
      this.emit('shiny', {
        pokemon: this.target,
        encounters: this.attempts,
        elapsedSeconds: this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0,
        screenshotPath,
        detection,
        deducedSID,
        nature: nature ?? '?',
        gender,
        tid: this.cal.tid,
        activeSIDs,
        eliminatedSIDs: this.cal.sidCandidates.length - activeSIDs,
        pidObservations: this.cal.pidObservations.length,
        advanceHits: this.cal.advanceHits.length,
        advanceWindow: this.cal.advanceWindow,
        targetSeed: targetEntry ? `0x${targetEntry.initialSeed.toString(16).padStart(4, '0')}` : '?',
        targetSIDs: targetEntry?.sidCount ?? 0,
      });

      this.state = 'SHINY_FOUND';
      return;
    }

    // Store summary info for stats page reading
    this.lastSummaryNature = nature;
    this.lastSummaryNatureIdx = natureIdx;
    this.lastSummaryTid = tid;
    this.lastSummaryIsShiny = detection.isShiny;

    // Read stats from summary page 2 for PID identification + SID elimination
    let lastStats: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number } | null = null;
    let lastPidMatches = -1;
    let lastUniquePID: string | null = null;
    let lastSeedDelta: number | null = null;
    if (this.cal.phase === 'MULTI_SID_TARGETING' && nature && natureIdx >= 0) {
      const result = await this.readStatsAndIdentifyPID(natureIdx, nature, gender);
      if (result) {
        lastStats = result.stats;
        lastPidMatches = result.pidMatches;
        lastUniquePID = result.uniquePID;
        lastSeedDelta = result.seedDelta;
      }
    }

    const ocrMs = Date.now() - ocrStart;

    // Log encounter for dashboard
    const entry = this.lastTargetedEntry;
    this.encounterLog.push({
      attempt: this.attempts,
      time: Date.now(),
      nature: nature ?? '?',
      gender,
      stats: lastStats,
      pidMatches: lastPidMatches,
      uniquePID: lastUniquePID,
      targetSeed: entry ? `0x${entry.initialSeed.toString(16).padStart(4, '0')}` : '?',
      targetSIDs: entry?.sidCount ?? 0,
      isShiny: detection.isShiny,
      detectionDebug: detection.debugInfo ?? '',
      timingMs: this.aPressTimestamp > 0 ? this.aPressTimestamp - this.bootTimestamp : 0,
      seedDelta: lastSeedDelta,
      ocrMs,
    });
    // Keep last 100 encounters
    if (this.encounterLog.length > 100) this.encounterLog.shift();

    // In SID_DEDUCTION phase: Lv5 stats don't provide enough IV precision
    // for PID-based SID deduction. Suggest multi-SID targeting instead.
    if (this.cal.phase === 'SID_DEDUCTION' && this.attempts === 1) {
      logger.info('[Switch RNG] SID deduction from Lv5 stats is impractical (IV ranges too wide).');
      logger.info('[Switch RNG] Options:');
      logger.info('[Switch RNG]   1. Skip SID deduction → multi-SID targeting: POST /api/rng/skip-sid');
      logger.info('[Switch RNG]   2. Set SID manually if known: POST /api/rng/sid {"sid": 12345}');
      logger.info('[Switch RNG]   3. Continue soft-resetting (standard 1/8192 odds)');
    }

    // Process observation based on calibration phase (nature-only for non-SID phases)
    if (nature && natureIdx >= 0) {
      await this.processObservation(natureIdx, nature, bootTimingMs, detection.isShiny);
    }

    this.state = 'RESET';
  }

  /**
   * Deduce SID when a shiny is found.
   *
   * We know:
   *   - TID (from summary OCR)
   *   - The Pokemon IS shiny → (TID ^ SID ^ pidH ^ pidL) < 8
   *   - The observed nature → PID % 25
   *   - Approximately which seed was targeted (from boot timing)
   *
   * Strategy:
   *   1. Search the seed window + advance range for Method 1 results matching the nature
   *   2. For each match, check which SID candidates would make it shiny
   *   3. Cross-reference: the true SID must appear in ALL candidate lists
   *   4. With tight timing, usually narrows to 1 SID
   */
  private async deduceSIDFromShiny(
    natureIdx: number,
    bootTimingMs: number,
  ): Promise<number | null> {
    const tid = this.cal.tid!;
    const activeSIDs = this.cal.sidCandidates.filter(s => !s.eliminated).map(s => s.sid);

    if (activeSIDs.length === 0) return null;

    // If we were targeting a specific seed (multi-SID or known target),
    // use a very tight window around it for precise SID deduction.
    let seedMin: number;
    let seedMax: number;

    const targetedEntry = this.lastTargetedEntry;

    // ±10 seeds ≈ ±610ms tolerance (seed changes every ~61µs at 16384 Hz)
    // This accounts for system scheduling jitter on Switch NSO
    const SEED_TOLERANCE = 10;

    if (targetedEntry) {
      // We know the exact seed we targeted
      const targetSeed = targetedEntry.initialSeed;
      seedMin = Math.max(0, targetSeed - SEED_TOLERANCE);
      seedMax = Math.min(0xFFFF, targetSeed + SEED_TOLERANCE);
      logger.info(`[Switch RNG] Using targeted seed 0x${targetSeed.toString(16).padStart(4, '0')} ±${SEED_TOLERANCE} for SID deduction`);
    } else if (this.cal.shinyTarget) {
      // Known target seed
      const targetSeed = this.cal.shinyTarget.initialSeed;
      seedMin = Math.max(0, targetSeed - SEED_TOLERANCE);
      seedMax = Math.min(0xFFFF, targetSeed + SEED_TOLERANCE);
      logger.info(`[Switch RNG] Using target seed 0x${targetSeed.toString(16).padStart(4, '0')} ±${SEED_TOLERANCE} for SID deduction`);
    } else {
      // No targeted seed — estimate from boot timing (wider window)
      const seedEstimate = Math.round(
        ((bootTimingMs - this.cal.biosOffsetMs) / 1000) * 16384
      ) & 0xFFFF;
      seedMin = Math.max(0, seedEstimate - 32);
      seedMax = Math.min(0xFFFF, seedEstimate + 32);
      logger.info(`[Switch RNG] Estimating seed from timing: 0x${seedEstimate.toString(16)} ±32`);
    }
    const advMin = this.cal.advanceWindow.min;
    const advMax = this.cal.advanceWindow.max;

    logger.info(`[Switch RNG] Deducing SID from shiny: nature=${NATURE_NAMES[natureIdx]}, seed range [0x${seedMin.toString(16)}-0x${seedMax.toString(16)}], advances [${advMin}-${advMax}]`);

    // Find all PIDs matching nature in the seed window that would be shiny for ANY candidate SID
    const shinyPIDs: Array<{
      pid: number;
      pidHigh: number;
      pidLow: number;
      matchingSIDs: number[];
      seed: number;
      advance: number;
    }> = [];

    for (let initSeed = seedMin; initSeed <= seedMax; initSeed++) {
      let seed = advanceSeed(initSeed, advMin);

      for (let adv = advMin; adv <= advMax; adv++) {
        const result = generateMethod1(seed, adv);

        if (result.nature === natureIdx) {
          // Check which SIDs make this PID shiny
          const matchingSIDs: number[] = [];
          for (const sid of activeSIDs) {
            if (isShinyPID(tid, sid, result.pidHigh, result.pidLow)) {
              matchingSIDs.push(sid);
            }
          }

          if (matchingSIDs.length > 0) {
            shinyPIDs.push({
              pid: result.pid,
              pidHigh: result.pidHigh,
              pidLow: result.pidLow,
              matchingSIDs,
              seed: initSeed,
              advance: adv,
            });
          }
        }

        seed = nextSeed(seed);
      }
    }

    logger.info(`[Switch RNG] Found ${shinyPIDs.length} shiny PID candidates matching ${NATURE_NAMES[natureIdx]} nature`);

    if (shinyPIDs.length === 0) {
      logger.warn('[Switch RNG] No matching shiny PIDs found in search window — timing may be off');
      // Fallback: brute-force check all SIDs with XOR formula
      // Even without knowing the PID, a shiny tells us (TID ^ SID ^ pidH ^ pidL) < 8
      // We can't narrow further without the PID.
      return null;
    }

    // Count how often each SID appears across all candidate PIDs
    const sidCounts = new Map<number, number>();
    for (const entry of shinyPIDs) {
      for (const sid of entry.matchingSIDs) {
        sidCounts.set(sid, (sidCounts.get(sid) || 0) + 1);
      }
    }

    // Sort SIDs by frequency
    const sorted = Array.from(sidCounts.entries()).sort((a, b) => b[1] - a[1]);

    logger.info(`[Switch RNG] SID candidates from shiny observation:`);
    for (const [sid, count] of sorted.slice(0, 10)) {
      logger.info(`  SID ${sid} (0x${sid.toString(16).padStart(4, '0')}): matches ${count}/${shinyPIDs.length} PIDs`);
    }

    // If one SID matches significantly more PIDs, it's likely correct
    if (sorted.length === 1) {
      const deducedSID = sorted[0][0];
      logger.info(`[Switch RNG] *** SID CONFIRMED: ${deducedSID} (0x${deducedSID.toString(16).padStart(4, '0')}) — only possible SID ***`);
      this.cal = setSID(this.cal, deducedSID);
      await saveCalibration(this.cal);
      return deducedSID;
    }

    if (sorted.length > 1 && sorted[0][1] > sorted[1][1] * 2) {
      // Top SID has >2x the matches of the runner-up — high confidence
      const deducedSID = sorted[0][0];
      logger.info(`[Switch RNG] *** SID LIKELY: ${deducedSID} (0x${deducedSID.toString(16).padStart(4, '0')}) — ${sorted[0][1]} matches vs ${sorted[1][1]} for runner-up ***`);
      this.cal = setSID(this.cal, deducedSID);
      await saveCalibration(this.cal);
      return deducedSID;
    }

    // Multiple SIDs with similar match counts — can't be sure
    // But we can narrow it to the top candidates
    if (sorted.length <= 8) {
      // Shiny narrows SID to ~8 values — this is expected behavior
      const topSID = sorted[0][0];
      logger.info(`[Switch RNG] SID narrowed to ${sorted.length} candidates. Most likely: ${topSID} (0x${topSID.toString(16).padStart(4, '0')})`);
      logger.info('[Switch RNG] These SIDs will be saved for future reference.');

      // Store all viable SIDs — eliminate the rest
      const viableSIDs = new Set(sorted.map(([sid]) => sid));
      for (const score of this.cal.sidCandidates) {
        if (!viableSIDs.has(score.sid)) {
          score.eliminated = true;
        }
      }
      const remaining = this.cal.sidCandidates.filter(s => !s.eliminated).length;
      logger.info(`[Switch RNG] Narrowed from ${activeSIDs.length} to ${remaining} SID candidates`);
      await saveCalibration(this.cal);

      return topSID; // return best guess
    }

    logger.info(`[Switch RNG] ${sorted.length} candidate SIDs — too many to narrow definitively`);
    return null;
  }

  /**
   * Try to read SID from emulator memory.
   * Returns null if not available (e.g., real Switch hardware).
   */
  private async readSIDFromMemory(): Promise<number | null> {
    try {
      const inputAny = this.input as any;
      if (typeof inputAny.readMemory !== 'function') return null;

      const saveBlockPtr = await inputAny.readMemory(FRLG_ADDRESSES.saveBlockPointer, 4);
      const sid = await inputAny.readMemory(saveBlockPtr + FRLG_ADDRESSES.sidOffset, 2);
      return sid;
    } catch (err) {
      logger.warn(`[Switch RNG] Could not read SID from memory: ${err}`);
      return null;
    }
  }

  /**
   * EON Timer-style seed identification from observed nature.
   *
   * After each encounter in MULTI_SID_TARGETING mode, we know:
   *   - Which seed we targeted (from schedule)
   *   - The observed nature (from summary OCR)
   *   - The actual time the A press was sent (aPressTimestamp)
   *
   * We search seeds near the target for advances that produce the observed nature.
   * Nature alone can't uniquely identify the seed (each seed has ~8 matching advances
   * out of 200), but the timing delta from boot→A press gives the seed estimate.
   * Combined, these narrow down which seed we actually hit.
   */
  private async identifySeedFromNature(
    natureIdx: number,
    natureName: string,
    _bootTimingMs: number,
  ): Promise<void> {
    // Get the seed we just targeted
    if (!this.lastTargetedEntry) return;
    const targetSeed = this.lastTargetedEntry.initialSeed;

    // Use the actual A press timing (relative to boot) to estimate real seed
    const aPressMs = this.aPressTimestamp > 0
      ? this.aPressTimestamp - this.bootTimestamp
      : 0;

    const advMin = this.cal.advanceWindow.min;
    const advMax = this.cal.advanceWindow.max;
    const SEARCH_RADIUS = 15; // ±15 seeds

    // Find all (seed, advance) pairs in the window that match the observed nature
    const candidates: Array<{ delta: number; seed: number; advance: number }> = [];

    for (let delta = -SEARCH_RADIUS; delta <= SEARCH_RADIUS; delta++) {
      const initSeed = (targetSeed + delta + 0x10000) & 0xFFFF;
      let seed = advanceSeed(initSeed, advMin);

      for (let adv = advMin; adv <= advMax; adv++) {
        const result = generateMethod1(seed, adv);
        if (result.nature === natureIdx) {
          candidates.push({ delta, seed: initSeed, advance: adv });
        }
        seed = nextSeed(seed);
      }
    }

    // Estimate which seed we actually hit from A press timing
    let estimatedDelta = 0;
    if (aPressMs > 0) {
      const estimatedSeed = bootTimingToSeed(aPressMs, this.cal.biosOffsetMs);
      estimatedDelta = ((estimatedSeed - targetSeed + 0x8000) & 0xFFFF) - 0x8000;
    }

    // Log the observation with timing info
    const targetTimingMs = seedToBootTimingMs(targetSeed, this.cal.biosOffsetMs);
    const timingDeltaMs = aPressMs > 0 ? aPressMs - targetTimingMs : 0;

    // Find candidates closest to estimated delta
    const closestCandidates = candidates
      .filter(c => Math.abs(c.delta - estimatedDelta) <= 3)
      .slice(0, 5);

    logger.info(
      `[Switch RNG] Seed ID: targeted 0x${targetSeed.toString(16).padStart(4, '0')}, ` +
      `nature=${natureName}, A press=${aPressMs.toFixed(0)}ms, ` +
      `timing delta=${timingDeltaMs.toFixed(0)}ms (≈${estimatedDelta >= 0 ? '+' : ''}${estimatedDelta} seeds), ` +
      `${candidates.length} nature matches in window, ${closestCandidates.length} near estimated seed`
    );

    if (closestCandidates.length > 0) {
      for (const c of closestCandidates) {
        logger.info(`  candidate: seed 0x${c.seed.toString(16).padStart(4, '0')} (delta ${c.delta >= 0 ? '+' : ''}${c.delta}) adv ${c.advance}`);
      }
    }

    // Store observation
    this.cal = addObservation(this.cal, {
      attempt: this.attempts,
      bootTimingMs: aPressMs,
      observedNature: natureName,
      observedNatureIdx: natureIdx,
      timestamp: Date.now(),
    });
    await saveCalibration(this.cal);
  }

  /**
   * Navigate to summary page 2, read stats via OCR, and attempt PID identification.
   *
   * With nature + Lv5 stats + known target seed, we search the PRNG state space
   * for Method 1 results that match both the nature and the IV ranges derived from stats.
   * A unique match gives us the exact PID, enabling:
   *   1. SID elimination (non-shiny PID eliminates SIDs where it would be shiny)
   *   2. Precise timing calibration (identified seed vs targeted seed → timing error)
   */
  // Gen 3 gender thresholds: PID & 0xFF < threshold → female
  private static readonly GENDER_THRESHOLDS: Record<string, number> = {
    charmander: 31, squirtle: 31, bulbasaur: 31, // 87.5% male
  };

  private async readStatsAndIdentifyPID(
    natureIdx: number,
    natureName: string,
    gender: 'male' | 'female' | 'unknown' = 'unknown',
  ): Promise<{ stats: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number }; pidMatches: number; uniquePID: string | null; seedDelta: number | null } | null> {
    if (!this.cal.tid || !this.lastTargetedEntry) return null;

    // Navigate from summary page 1 → page 2 (press RIGHT)
    await this.input.pressButton('RIGHT', 50);
    await this.wait(500); // page transition animation on NSO takes ~400-500ms

    // Capture page 2 frame and extract stats
    const statsFrame = await this.frameSource.captureFrame();

    const stats = await extractStats(statsFrame);

    if (!stats) {
      logger.info('[Switch RNG] Stats OCR failed — skipping PID identification (check stats-page-*.png)');
      return null;
    }

    logger.info(
      `[Switch RNG] Stats: HP:${stats.hp} ATK:${stats.attack} DEF:${stats.defense} ` +
      `SpA:${stats.spAtk} SpD:${stats.spDef} SPE:${stats.speed}`
    );

    const statsResult = {
      hp: stats.hp, atk: stats.attack, def: stats.defense,
      spa: stats.spAtk, spd: stats.spDef, spe: stats.speed,
    };

    // Compute IV ranges from observed stats
    const ivRanges = computeIVRanges(this.target, 5, natureName, stats);
    if (!ivRanges) {
      logger.info('[Switch RNG] IV computation failed — unknown pokemon base stats?');
      return { stats: statsResult, pidMatches: 0, uniquePID: null, seedDelta: null };
    }

    // Search for matching PIDs near our targeted seed
    const targetSeed = this.lastTargetedEntry.initialSeed;
    const SEARCH_RADIUS = 15;
    const advMin = this.cal.advanceWindow.min;
    const advMax = this.cal.advanceWindow.max;

    const matches: Array<{
      seed: number;
      advance: number;
      pid: number;
      pidHigh: number;
      pidLow: number;
      ivs: IVs;
      delta: number;
    }> = [];

    for (let delta = -SEARCH_RADIUS; delta <= SEARCH_RADIUS; delta++) {
      const initSeed = (targetSeed + delta + 0x10000) & 0xFFFF;
      let seed = advanceSeed(initSeed, advMin);

      for (let adv = advMin; adv <= advMax; adv++) {
        const result = generateMethod1(seed, adv);
        if (result.nature === natureIdx) {
          const ivs = generateIVs(result.iv1Seed);
          if (ivsMatchRanges(ivs, ivRanges)) {
            matches.push({
              seed: initSeed,
              advance: adv,
              pid: result.pid,
              pidHigh: result.pidHigh,
              pidLow: result.pidLow,
              ivs,
              delta,
            });
          }
        }
        seed = nextSeed(seed);
      }
    }

    // Filter by gender if known (reduces matches by ~12.5% for male, ~87.5% for female)
    const genderThreshold = SwitchRngEngine.GENDER_THRESHOLDS[this.target] ?? 0;
    if (gender !== 'unknown' && genderThreshold > 0) {
      const beforeGender = matches.length;
      const filtered = matches.filter(m => {
        const pidGenderByte = m.pid & 0xFF;
        if (gender === 'female') return pidGenderByte < genderThreshold;
        return pidGenderByte >= genderThreshold; // male
      });
      if (filtered.length > 0) {
        matches.length = 0;
        matches.push(...filtered);
      }
      if (matches.length !== beforeGender) {
        logger.info(`[Switch RNG] Gender filter (${gender}): ${beforeGender} → ${matches.length} matches`);
      }
    }

    logger.info(`[Switch RNG] PID search: ${matches.length} matches for ${natureName} + stats in ±${SEARCH_RADIUS} seeds`);

    if (matches.length === 0) {
      logger.info('[Switch RNG] No PID matches — OCR may be wrong or seed outside window');
      return { stats: statsResult, pidMatches: 0, uniquePID: null, seedDelta: null };
    }

    if (matches.length === 1) {
      // Unique PID identified — full SID elimination + precise timing
      const m = matches[0];
      logger.info(
        `[Switch RNG] *** Unique PID: 0x${(m.pid >>> 0).toString(16).padStart(8, '0')} ` +
        `at seed 0x${m.seed.toString(16).padStart(4, '0')} adv ${m.advance} ***`
      );
      logger.info(
        `[Switch RNG] IVs: HP:${m.ivs.hp} Atk:${m.ivs.atk} Def:${m.ivs.def} ` +
        `SpA:${m.ivs.spa} SpD:${m.ivs.spd} Spe:${m.ivs.spe}`
      );

      // SID elimination
      const beforeCount = getRemainingCount(this.cal.sidCandidates);
      this.cal = addPIDObservation(this.cal, {
        attempt: this.attempts,
        pid: m.pid,
        pidHigh: m.pidHigh,
        pidLow: m.pidLow,
        nature: natureName,
        isShiny: false,
        timestamp: Date.now(),
      });
      const afterCount = getRemainingCount(this.cal.sidCandidates);

      if (afterCount < beforeCount) {
        logger.info(`[Switch RNG] SID elimination: ${beforeCount} → ${afterCount} candidates (−${beforeCount - afterCount})`);
      }

      // Check if phase changed (SID fully deduced)
      if (this.cal.phase !== 'MULTI_SID_TARGETING') {
        logger.info(`[Switch RNG] *** Phase changed to ${this.cal.phase} — SID deduced! ***`);
        this.seedSchedule = [];
      }

      // Advance tracking — record the actual advance for window narrowing
      const oldWindow = { ...this.cal.advanceWindow };
      this.cal = recordAdvanceHit(this.cal, m.advance);
      // If window changed, invalidate seed schedule so it rebuilds with new range
      if (this.cal.advanceWindow.min !== oldWindow.min || this.cal.advanceWindow.max !== oldWindow.max) {
        logger.info(`[Switch RNG] Advance window changed — seed schedule will rebuild on next encounter`);
        this.seedSchedule = [];
      }

      // Timing calibration from identified seed
      if (m.delta !== 0) {
        const timingErrorMs = m.delta * (1000 / 16384);
        this.timingDeltas.push(timingErrorMs);
        logger.info(
          `[Switch RNG] Timing: seed delta=${m.delta >= 0 ? '+' : ''}${m.delta} ` +
          `(${timingErrorMs.toFixed(1)}ms error)`
        );
        await this.applyTimingCorrection();
      }

      await saveCalibration(this.cal);
      return { stats: statsResult, pidMatches: 1, uniquePID: `0x${(m.pid >>> 0).toString(16).padStart(8, '0')}`, seedDelta: m.delta };
    }

    // Multiple matches — log them
    logger.info(`[Switch RNG] ${matches.length} PID candidates (ambiguous at Lv5):`);
    for (const m of matches.slice(0, 5)) {
      logger.info(
        `  seed 0x${m.seed.toString(16).padStart(4, '0')} ` +
        `(Δ${m.delta >= 0 ? '+' : ''}${m.delta}) adv ${m.advance}: ` +
        `PID 0x${(m.pid >>> 0).toString(16).padStart(8, '0')}`
      );
    }
    if (matches.length > 5) {
      logger.info(`  ... and ${matches.length - 5} more`);
    }

    // Conservative elimination: find SIDs that would be shiny for ALL candidate PIDs.
    // If encounter was non-shiny, those SIDs are impossible regardless of which PID is correct.
    const tid = this.cal.tid!;
    const eliminable = new Set<number>();

    for (const sc of this.cal.sidCandidates) {
      if (sc.eliminated) continue;
      if ((tid ^ sc.sid ^ matches[0].pidHigh ^ matches[0].pidLow) < 8) {
        eliminable.add(sc.sid);
      }
    }

    for (let i = 1; i < matches.length; i++) {
      for (const sid of eliminable) {
        if ((tid ^ sid ^ matches[i].pidHigh ^ matches[i].pidLow) >= 8) {
          eliminable.delete(sid);
        }
      }
    }

    if (eliminable.size > 0) {
      for (const sc of this.cal.sidCandidates) {
        if (eliminable.has(sc.sid)) {
          sc.eliminated = true;
        }
      }
      const afterCount = getRemainingCount(this.cal.sidCandidates);
      logger.info(`[Switch RNG] Conservative SID elimination: −${eliminable.size} SIDs (${afterCount} remaining)`);
      await saveCalibration(this.cal);
    }

    return { stats: statsResult, pidMatches: matches.length, uniquePID: null, seedDelta: null };
  }

  /**
   * Apply timing correction when enough consistent observations accumulate.
   * Uses the seed deltas from PID identification to compute an average timing error
   * and adjust timingOffsetMs accordingly.
   */
  private async applyTimingCorrection(): Promise<void> {
    if (this.timingDeltas.length < 3) return;

    const avg = this.timingDeltas.reduce((a, b) => a + b, 0) / this.timingDeltas.length;
    const variance = this.timingDeltas.reduce((sum, d) => sum + (d - avg) ** 2, 0) / this.timingDeltas.length;
    const stdDev = Math.sqrt(variance);

    // Apply correction if observations are reasonably consistent
    if (stdDev < 5 && Math.abs(avg) > 0.3) {
      const correction = Math.round(avg * 10) / 10;
      this.cal.timingOffsetMs += correction;
      logger.info(
        `[Switch RNG] Timing auto-cal: ${this.timingDeltas.length} obs, ` +
        `avg=${avg.toFixed(1)}ms, stdDev=${stdDev.toFixed(1)}ms → ` +
        `offset adjusted by ${correction >= 0 ? '+' : ''}${correction}ms ` +
        `(total: ${this.cal.timingOffsetMs.toFixed(1)}ms)`
      );
      this.timingDeltas = [];
      await saveCalibration(this.cal);
    } else if (this.timingDeltas.length >= 10) {
      // Too noisy — keep only recent observations
      logger.info(
        `[Switch RNG] Timing: ${this.timingDeltas.length} obs, ` +
        `avg=${avg.toFixed(1)}ms, stdDev=${stdDev.toFixed(1)}ms — ` +
        `not converging, trimming to last 5`
      );
      this.timingDeltas = this.timingDeltas.slice(-5);
    }
  }

  private async processObservation(
    natureIdx: number,
    natureName: string,
    bootTimingMs: number,
    isShiny: boolean,
  ): Promise<void> {
    const phase = this.cal.phase;

    if (phase === 'SID_DEDUCTION') {
      // Try to read SID directly from emulator memory
      const memSid = await this.readSIDFromMemory();

      if (memSid !== null) {
        // Emulator path: we can read SID directly from memory
        logger.info(`[Switch RNG] Read SID from memory: ${memSid} (0x${memSid.toString(16).padStart(4, '0')})`);
        this.cal = setSID(this.cal, memSid);
        logger.info(`[Switch RNG] Phase advanced to: ${this.cal.phase}`);
      } else {
        // Real hardware: log nature-only observation for debugging
        logger.info('[Switch RNG] SID deduction: observation logged');
        this.cal = addObservation(this.cal, {
          attempt: this.attempts,
          bootTimingMs,
          observedNature: natureName,
          observedNatureIdx: natureIdx,
          timestamp: Date.now(),
        });
      }

      await saveCalibration(this.cal);
    } else if (phase === 'MULTI_SID_TARGETING') {
      // EON Timer-style feedback: identify which seed we actually hit
      // by matching observed nature against seeds near our target.
      await this.identifySeedFromNature(natureIdx, natureName, bootTimingMs);
    } else if (phase === 'TIMING_CALIBRATION' && this.cal.shinyTarget) {
      // Check if we hit the expected nature
      const expectedNature = NATURE_NAMES.findIndex(
        n => n.toLowerCase() === this.cal.shinyTarget!.nature.toLowerCase()
      );
      this.cal = updateTimingOffset(this.cal, natureIdx, expectedNature);
      await saveCalibration(this.cal);
    }
    // In TID_ENTRY and READY phases, observations are just logged
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

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
