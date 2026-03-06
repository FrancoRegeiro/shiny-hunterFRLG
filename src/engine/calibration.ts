/**
 * Calibration state management for Switch RNG manipulation.
 *
 * Phases:
 * 1. TID_ENTRY — User provides TID (from summary screen OCR or manual input)
 * 2. SID_DEDUCTION — Run calibration attempts, observe PIDs, deduce SID
 * 3. TARGET_SELECTION — SID known; pick best shiny target seed
 * 4. TIMING_CALIBRATION — Refine boot timing offset via test runs
 * 5. READY — Calibration complete; targeting specific shiny seed
 */

import path from 'path';
import fs from 'fs/promises';
import { logger } from '../logger';
import { IVs, NATURE_NAMES } from './rng';
import {
  SIDScore,
  PIDObservation,
  enumerateSIDCandidates,
  scoreSIDCandidates,
  scorePIDObservation,
  getBestSID,
  getRemainingCount,
  findShinyTargets,
} from './sid-deduction';
import { seedToBootTimingMs } from './seed-table';

const CALIBRATION_FILE = path.join(process.cwd(), 'data', 'switch-calibration.json');

export type CalibrationPhase =
  | 'TID_ENTRY'
  | 'SID_DEDUCTION'
  | 'MULTI_SID_TARGETING'  // Skip SID deduction, target shiny across all candidate SIDs
  | 'TARGET_SELECTION'
  | 'TIMING_CALIBRATION'
  | 'READY';

export interface CalibrationObservation {
  attempt: number;
  bootTimingMs: number;
  observedNature: string;
  observedNatureIdx: number;
  timestamp: number;
  // PID-based fields (for SID deduction)
  pid?: number;
  pidHigh?: number;
  pidLow?: number;
  isShiny?: boolean;
}

export interface ShinyTargetInfo {
  initialSeed: number;
  advance: number;
  nature: string;
  pid: number;
  ivs: IVs;
  targetBootTimingMs: number;
}

export interface CalibrationState {
  phase: CalibrationPhase;
  tid: number | null;
  sid: number | null;
  sidCandidates: SIDScore[];
  observations: CalibrationObservation[];
  pidObservations: PIDObservation[];
  // Timing config
  biosOffsetMs: number;
  advanceWindow: { min: number; max: number };
  timingOffsetMs: number;  // learned correction to boot timing
  // Advance tracking — records actual advances from unique PID identifications
  advanceHits: number[];
  advanceWindowLocked: boolean;  // true once auto-narrowed
  // Target
  shinyTarget: ShinyTargetInfo | null;
  allShinyTargets: ShinyTargetInfo[];
}

const DEFAULT_STATE: CalibrationState = {
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

export async function loadCalibration(): Promise<CalibrationState> {
  try {
    const data = await fs.readFile(CALIBRATION_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    logger.info(`[Cal] Loaded calibration: phase=${parsed.phase}, ${parsed.pidObservations?.length || parsed.observations?.length || 0} observations`);
    return { ...DEFAULT_STATE, ...parsed };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export async function saveCalibration(state: CalibrationState): Promise<void> {
  try {
    await fs.mkdir(path.dirname(CALIBRATION_FILE), { recursive: true });
    await fs.writeFile(CALIBRATION_FILE, JSON.stringify(state, null, 2));
  } catch { /* ignore */ }
}

/**
 * Set TID and enumerate SID candidates. Advances to SID_DEDUCTION phase.
 */
export function setTID(state: CalibrationState, tid: number): CalibrationState {
  logger.info(`[Cal] Setting TID: ${tid} (0x${tid.toString(16).padStart(4, '0')})`);

  const sidCandidates = enumerateSIDCandidates(tid);
  logger.info(`[Cal] Found ${sidCandidates.length} unique SID candidates`);

  return {
    ...state,
    tid,
    phase: 'SID_DEDUCTION',
    sidCandidates,
  };
}

/**
 * Record a PID observation and score SID candidates.
 * Each non-shiny PID eliminates ~8/65536 SIDs.
 * A shiny PID narrows to ~8 SIDs immediately.
 */
export function addPIDObservation(
  state: CalibrationState,
  obs: PIDObservation,
): CalibrationState {
  const pidObservations = [...state.pidObservations, obs];
  const sidCandidates = [...state.sidCandidates.map(s => ({ ...s }))];

  if (state.tid !== null) {
    // Score just the new observation (incremental)
    scorePIDObservation(state.tid, sidCandidates, obs);

    const remaining = getRemainingCount(sidCandidates);
    logger.info(`[Cal] PID obs #${pidObservations.length}: PID=0x${(obs.pid >>> 0).toString(16).padStart(8, '0')} ${obs.nature} ${obs.isShiny ? 'SHINY!' : ''} | ${remaining} SID candidates remaining`);

    // Log top candidates
    const alive = sidCandidates.filter(s => !s.eliminated).slice(0, 5);
    for (const c of alive) {
      logger.info(`[Cal]   SID 0x${c.sid.toString(16).padStart(4, '0')} (${c.sid}): ${c.matchingObs}/${c.totalObs} consistent`);
    }

    // Check if SID is deduced
    const bestSid = getBestSID(sidCandidates, 1);
    if (bestSid !== null) {
      logger.info(`[Cal] SID DEDUCED: ${bestSid} (0x${bestSid.toString(16).padStart(4, '0')})`);
      return selectSID({ ...state, pidObservations, sidCandidates }, bestSid);
    }
  }

  return { ...state, pidObservations, sidCandidates };
}

/**
 * Legacy: record a nature observation (for logging only, not SID deduction).
 */
export function addObservation(
  state: CalibrationState,
  obs: CalibrationObservation,
): CalibrationState {
  const observations = [...state.observations, obs];
  return { ...state, observations };
}

/**
 * Manually set SID (if known from external source). Advances to TARGET_SELECTION.
 */
export function setSID(state: CalibrationState, sid: number): CalibrationState {
  return selectSID(state, sid);
}

function selectSID(state: CalibrationState, sid: number): CalibrationState {
  logger.info(`[Cal] SID confirmed: ${sid} (0x${sid.toString(16).padStart(4, '0')})`);

  if (state.tid === null) {
    logger.warn('[Cal] Cannot select SID without TID');
    return state;
  }

  // Find all shiny targets
  const rawTargets = findShinyTargets(state.tid, sid, state.advanceWindow);
  const allShinyTargets: ShinyTargetInfo[] = rawTargets.map(t => ({
    initialSeed: t.initialSeed,
    advance: t.advance,
    nature: NATURE_NAMES[t.nature],
    pid: t.pid,
    ivs: t.ivs,
    targetBootTimingMs: seedToBootTimingMs(t.initialSeed, state.biosOffsetMs),
  }));

  logger.info(`[Cal] Found ${allShinyTargets.length} shiny targets in advance window [${state.advanceWindow.min}, ${state.advanceWindow.max}]`);

  for (const t of allShinyTargets.slice(0, 10)) {
    logger.info(`  Seed 0x${t.initialSeed.toString(16).padStart(4, '0')} adv ${t.advance}: ${t.nature} | HP:${t.ivs.hp} Atk:${t.ivs.atk} Def:${t.ivs.def} SpA:${t.ivs.spa} SpD:${t.ivs.spd} Spe:${t.ivs.spe}`);
  }

  const shinyTarget = allShinyTargets.length > 0 ? allShinyTargets[0] : null;

  return {
    ...state,
    sid,
    phase: shinyTarget ? 'TIMING_CALIBRATION' : 'TARGET_SELECTION',
    allShinyTargets,
    shinyTarget,
  };
}

/**
 * Select a specific shiny target by index from allShinyTargets.
 */
export function selectTarget(state: CalibrationState, index: number): CalibrationState {
  if (index < 0 || index >= state.allShinyTargets.length) {
    logger.warn(`[Cal] Invalid target index ${index}`);
    return state;
  }

  const shinyTarget = state.allShinyTargets[index];
  logger.info(`[Cal] Selected target: seed 0x${shinyTarget.initialSeed.toString(16).padStart(4, '0')} adv ${shinyTarget.advance} ${shinyTarget.nature}`);

  return {
    ...state,
    shinyTarget,
    phase: 'TIMING_CALIBRATION',
  };
}

/**
 * Update timing offset based on calibration attempt result.
 */
export function updateTimingOffset(
  state: CalibrationState,
  observedNature: number,
  expectedNature: number,
): CalibrationState {
  if (observedNature === expectedNature) {
    logger.info('[Cal] Timing calibration: HIT! Nature matches target.');
    return { ...state, phase: 'READY' };
  }

  logger.info(`[Cal] Timing calibration: miss. Got ${NATURE_NAMES[observedNature]}, expected ${NATURE_NAMES[expectedNature]}`);
  return state;
}

/**
 * Skip SID deduction and go directly to multi-SID targeting mode.
 * Used when SID deduction via PID observations is impractical (e.g., Lv5 stats).
 */
export function skipToMultiSID(state: CalibrationState): CalibrationState {
  if (state.tid === null) {
    logger.warn('[Cal] Cannot skip to multi-SID without TID');
    return state;
  }
  logger.info('[Cal] Skipping SID deduction — entering multi-SID targeting mode');
  return { ...state, phase: 'MULTI_SID_TARGETING' };
}

/**
 * Record a confirmed advance from unique PID identification and auto-narrow the window.
 *
 * After enough observations (≥3), computes mean ± 3σ to set the advance window.
 * A tighter window means:
 *   - Fewer PID candidates per encounter → more unique identifications
 *   - More precise multi-SID targeting → better odds
 *   - Eventually enables specific advance targeting
 */
export function recordAdvanceHit(
  state: CalibrationState,
  advance: number,
): CalibrationState {
  const advanceHits = [...state.advanceHits, advance];

  logger.info(`[Cal] Advance hit #${advanceHits.length}: adv=${advance}`);

  if (advanceHits.length >= 3) {
    const mean = advanceHits.reduce((a, b) => a + b, 0) / advanceHits.length;
    const variance = advanceHits.reduce((sum, h) => sum + (h - mean) ** 2, 0) / advanceHits.length;
    const stdDev = Math.sqrt(variance);

    logger.info(
      `[Cal] Advance stats: n=${advanceHits.length}, mean=${mean.toFixed(1)}, ` +
      `stdDev=${stdDev.toFixed(1)}, range=[${Math.min(...advanceHits)}, ${Math.max(...advanceHits)}]`
    );

    // Auto-narrow: use mean ± 3σ with a minimum width of ±10 and padding of ±20
    // Only narrow if we have enough data and the variance is reasonable
    if (advanceHits.length >= 5 && stdDev < 50) {
      const margin = Math.max(20, Math.ceil(stdDev * 3));
      const newMin = Math.max(0, Math.floor(mean - margin));
      const newMax = Math.ceil(mean + margin);
      const oldWidth = state.advanceWindow.max - state.advanceWindow.min;
      const newWidth = newMax - newMin;

      if (newWidth < oldWidth) {
        logger.info(
          `[Cal] *** Advance window narrowed: [${state.advanceWindow.min}, ${state.advanceWindow.max}] (${oldWidth}) → ` +
          `[${newMin}, ${newMax}] (${newWidth}) ***`
        );
        return {
          ...state,
          advanceHits,
          advanceWindow: { min: newMin, max: newMax },
          advanceWindowLocked: true,
        };
      }
    }
  }

  return { ...state, advanceHits };
}

/**
 * Get boot timing for the current target, including calibration offset.
 */
export function getTargetBootTiming(state: CalibrationState): number | null {
  if (!state.shinyTarget) return null;
  return state.shinyTarget.targetBootTimingMs + state.timingOffsetMs;
}

/**
 * Get calibration boot timing for SID deduction phase.
 * Varies timing systematically to sample different seeds.
 */
export function getCalibrationBootTiming(
  state: CalibrationState,
  attemptIndex: number,
): number {
  const baseTiming = state.biosOffsetMs + 2000;
  return baseTiming + attemptIndex * 17;
}
