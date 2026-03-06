/**
 * SID deduction from PID observations.
 *
 * Process:
 * 1. From visible TID, enumerate all possible SIDs via seed-table
 * 2. Each calibration run: pick starter, determine PID
 *    - Emulator: read PID from memory
 *    - Real hardware: OCR stats → compute IVs → reverse PRNG → PID
 * 3. For each non-shiny observation, eliminate SIDs where
 *    (TID ^ SID ^ pidHigh ^ pidLow) < 8
 * 4. After a few observations, usually only one SID remains
 *
 * Why nature alone CAN'T work:
 *   Nature = PID % 25, which is determined entirely by the PRNG state.
 *   TID/SID only affect the shiny check, not the nature calculation.
 *   So observing natures tells us nothing about SID.
 */

import {
  nextSeed,
  advanceSeed,
  generateMethod1,
  isShinyPID,
  generateIVs,
  NATURE_NAMES,
  IVs,
} from './rng';
import { SeedCandidate, findSeedsForTID, bootTimingToSeed } from './seed-table';

export interface PIDObservation {
  attempt: number;
  pid: number;          // full 32-bit PID
  pidHigh: number;      // upper 16 bits
  pidLow: number;       // lower 16 bits
  nature: string;
  isShiny: boolean;
  timestamp: number;
}

export interface SIDScore {
  sid: number;
  candidates: SeedCandidate[];  // initial seeds that produce this SID with the TID
  eliminated: boolean;          // true if any observation proves this SID impossible
  matchingObs: number;          // observations consistent with this SID
  totalObs: number;
  confidence: number;
}

/**
 * Enumerate all candidate SIDs for a given TID.
 * Groups seed candidates by their SID value.
 */
export function enumerateSIDCandidates(tid: number): SIDScore[] {
  const allCandidates = findSeedsForTID(tid);

  // Group by SID
  const bySid = new Map<number, SeedCandidate[]>();
  for (const c of allCandidates) {
    const arr = bySid.get(c.sid) || [];
    arr.push(c);
    bySid.set(c.sid, arr);
  }

  return Array.from(bySid.entries()).map(([sid, candidates]) => ({
    sid,
    candidates,
    eliminated: false,
    matchingObs: 0,
    totalObs: 0,
    confidence: 0,
  }));
}

/**
 * Score a single PID observation against all SID candidates.
 *
 * For a NON-SHINY Pokemon:
 *   We know (TID ^ SID ^ pidHigh ^ pidLow) >= 8
 *   So we eliminate any SID where (TID ^ SID ^ pidHigh ^ pidLow) < 8
 *
 * For a SHINY Pokemon:
 *   We know (TID ^ SID ^ pidHigh ^ pidLow) < 8
 *   So we eliminate any SID where (TID ^ SID ^ pidHigh ^ pidLow) >= 8
 *   This is much more powerful — narrows to ~8 possible SIDs immediately.
 */
export function scorePIDObservation(
  tid: number,
  scores: SIDScore[],
  obs: PIDObservation,
): void {
  for (const score of scores) {
    if (score.eliminated) continue;
    score.totalObs++;

    const xorValue = tid ^ score.sid ^ obs.pidHigh ^ obs.pidLow;
    const wouldBeShiny = xorValue < 8;

    if (obs.isShiny) {
      // Pokemon IS shiny: SID must produce shiny for this PID
      if (wouldBeShiny) {
        score.matchingObs++;
      } else {
        score.eliminated = true;
        score.confidence = 0;
        continue;
      }
    } else {
      // Pokemon is NOT shiny: SID must NOT produce shiny for this PID
      if (!wouldBeShiny) {
        score.matchingObs++;
      } else {
        score.eliminated = true;
        score.confidence = 0;
        continue;
      }
    }

    score.confidence = score.totalObs > 0
      ? score.matchingObs / score.totalObs
      : 0;
  }
}

/**
 * Score all PID observations against all SID candidates.
 */
export function scoreSIDCandidates(
  tid: number,
  scores: SIDScore[],
  observations: PIDObservation[],
): void {
  // Reset scores
  for (const s of scores) {
    s.matchingObs = 0;
    s.totalObs = 0;
    s.confidence = 0;
    s.eliminated = false;
  }

  for (const obs of observations) {
    scorePIDObservation(tid, scores, obs);
  }
}

/**
 * Get the best SID candidate.
 * Returns the SID if exactly one non-eliminated candidate remains,
 * or if one has significantly higher confidence than the rest.
 */
export function getBestSID(scores: SIDScore[], minObservations: number = 1): number | null {
  const alive = scores.filter(s => !s.eliminated);

  if (alive.length === 0) return null;
  if (alive.length === 1 && alive[0].totalObs >= minObservations) {
    return alive[0].sid;
  }

  // Not yet narrowed to one — return null
  return null;
}

/**
 * Get the count of remaining (non-eliminated) SID candidates.
 */
export function getRemainingCount(scores: SIDScore[]): number {
  return scores.filter(s => !s.eliminated).length;
}

/**
 * Compute which SIDs would be eliminated by a given PID.
 * Useful for understanding the discriminating power of an observation.
 */
export function computeEliminationPower(
  tid: number,
  scores: SIDScore[],
  pidHigh: number,
  pidLow: number,
  isShiny: boolean,
): number {
  let eliminated = 0;
  for (const score of scores) {
    if (score.eliminated) continue;
    const xorValue = tid ^ score.sid ^ pidHigh ^ pidLow;
    const wouldBeShiny = xorValue < 8;
    if (isShiny !== wouldBeShiny) eliminated++;
  }
  return eliminated;
}

function ivsMatch(a: IVs, b: IVs): boolean {
  return a.hp === b.hp && a.atk === b.atk && a.def === b.def
    && a.spa === b.spa && a.spd === b.spd && a.spe === b.spe;
}

/**
 * Given known TID+SID, find all (initialSeed, advance) combinations
 * that produce a shiny within the advance window.
 */
export function findShinyTargets(
  tid: number,
  sid: number,
  advanceWindow: { min: number; max: number },
): Array<{
  initialSeed: number;
  advance: number;
  nature: number;
  pid: number;
  ivs: IVs;
}> {
  const targets: Array<{
    initialSeed: number;
    advance: number;
    nature: number;
    pid: number;
    ivs: IVs;
  }> = [];

  for (let initSeed = 0; initSeed <= 0xFFFF; initSeed++) {
    let seed = advanceSeed(initSeed, advanceWindow.min);

    for (let adv = advanceWindow.min; adv <= advanceWindow.max; adv++) {
      const result = generateMethod1(seed, adv);

      if (isShinyPID(tid, sid, result.pidHigh, result.pidLow)) {
        const ivs = generateIVs(result.iv1Seed);
        targets.push({
          initialSeed: initSeed,
          advance: adv,
          nature: result.nature,
          pid: result.pid,
          ivs,
        });
      }

      seed = nextSeed(seed);
    }
  }

  return targets;
}
