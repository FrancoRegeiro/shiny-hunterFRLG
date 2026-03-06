/**
 * Method 1 reverse PID search.
 *
 * Given a Pokemon's nature and IV ranges (from stat OCR),
 * search all initial seeds × advance window for Method 1 generations
 * that match. Each match gives a candidate PID for SID elimination.
 *
 * At Lv5, each stat typically maps to 2-4 possible IVs,
 * so IV ranges alone give ~64-4096 IV combos. But Method 1 constrains
 * IVs to come from consecutive PRNG calls, dramatically reducing matches.
 */

import {
  nextSeed,
  advanceSeed,
  generateMethod1,
  generateIVs,
  NATURE_NAMES,
  IVs,
} from './rng';
import { ivsMatchRanges } from './iv-calc';
import { logger } from '../logger';

export interface PIDCandidate {
  initialSeed: number;
  advance: number;
  pid: number;
  pidHigh: number;
  pidLow: number;
  nature: number;
  ivs: IVs;
}

/**
 * Search for all Method 1 PID candidates matching the observed nature and IV ranges.
 *
 * Scans all 65536 initial seeds across the given advance window.
 * This is computationally intensive but runs in ~1-3 seconds on modern hardware.
 */
export function findPIDCandidates(
  natureIdx: number,
  ivRanges: { hp: number[]; atk: number[]; def: number[]; spa: number[]; spd: number[]; spe: number[] },
  advanceWindow: { min: number; max: number },
): PIDCandidate[] {
  const candidates: PIDCandidate[] = [];
  const windowSize = advanceWindow.max - advanceWindow.min + 1;

  for (let initSeed = 0; initSeed <= 0xFFFF; initSeed++) {
    let seed = advanceSeed(initSeed, advanceWindow.min);

    for (let adv = advanceWindow.min; adv <= advanceWindow.max; adv++) {
      const result = generateMethod1(seed, adv);

      // Quick nature check first (cheapest filter)
      if (result.nature === natureIdx) {
        // Check IVs
        const ivs = generateIVs(result.iv1Seed);
        if (ivsMatchRanges(ivs, ivRanges)) {
          candidates.push({
            initialSeed: initSeed,
            advance: adv,
            pid: result.pid,
            pidHigh: result.pidHigh,
            pidLow: result.pidLow,
            nature: result.nature,
            ivs,
          });
        }
      }

      seed = nextSeed(seed);
    }
  }

  return candidates;
}

/**
 * Search a constrained seed range for PID candidates.
 * Much faster than full search when boot timing narrows the initial seed.
 */
export function findPIDCandidatesInSeedRange(
  natureIdx: number,
  ivRanges: { hp: number[]; atk: number[]; def: number[]; spa: number[]; spd: number[]; spe: number[] },
  advanceWindow: { min: number; max: number },
  seedMin: number,
  seedMax: number,
): PIDCandidate[] {
  const candidates: PIDCandidate[] = [];

  for (let initSeed = seedMin; initSeed <= seedMax; initSeed++) {
    let seed = advanceSeed(initSeed, advanceWindow.min);

    for (let adv = advanceWindow.min; adv <= advanceWindow.max; adv++) {
      const result = generateMethod1(seed, adv);

      if (result.nature === natureIdx) {
        const ivs = generateIVs(result.iv1Seed);
        if (ivsMatchRanges(ivs, ivRanges)) {
          candidates.push({
            initialSeed: initSeed,
            advance: adv,
            pid: result.pid,
            pidHigh: result.pidHigh,
            pidLow: result.pidLow,
            nature: result.nature,
            ivs,
          });
        }
      }

      seed = nextSeed(seed);
    }
  }

  return candidates;
}

/**
 * Get unique PIDs from a set of candidates.
 * Multiple (seed, advance) pairs can produce the same PID.
 */
export function getUniquePIDs(candidates: PIDCandidate[]): Array<{
  pid: number;
  pidHigh: number;
  pidLow: number;
  count: number;
}> {
  const byPid = new Map<number, { pidHigh: number; pidLow: number; count: number }>();
  for (const c of candidates) {
    const existing = byPid.get(c.pid);
    if (existing) {
      existing.count++;
    } else {
      byPid.set(c.pid, { pidHigh: c.pidHigh, pidLow: c.pidLow, count: 1 });
    }
  }
  return Array.from(byPid.entries()).map(([pid, info]) => ({ pid, ...info }));
}

/**
 * High-level: from observed stats, find all candidate PIDs and log results.
 */
export function findAndLogPIDCandidates(
  natureIdx: number,
  ivRanges: { hp: number[]; atk: number[]; def: number[]; spa: number[]; spd: number[]; spe: number[] },
  advanceWindow: { min: number; max: number },
): PIDCandidate[] {
  const start = Date.now();
  const candidates = findPIDCandidates(natureIdx, ivRanges, advanceWindow);
  const elapsed = Date.now() - start;

  const uniquePIDs = getUniquePIDs(candidates);
  const natureName = NATURE_NAMES[natureIdx];

  logger.info(`[PID Finder] Found ${candidates.length} Method 1 matches (${uniquePIDs.length} unique PIDs) for ${natureName} nature in ${elapsed}ms`);
  logger.info(`[PID Finder] IV ranges: HP=${ivRanges.hp.join(',')} Atk=${ivRanges.atk.join(',')} Def=${ivRanges.def.join(',')} SpA=${ivRanges.spa.join(',')} SpD=${ivRanges.spd.join(',')} Spe=${ivRanges.spe.join(',')}`);

  for (const p of uniquePIDs.slice(0, 10)) {
    logger.info(`[PID Finder]   PID=0x${(p.pid >>> 0).toString(16).padStart(8, '0')} (high=0x${p.pidHigh.toString(16).padStart(4, '0')} low=0x${p.pidLow.toString(16).padStart(4, '0')}) — ${p.count} seed/advance combos`);
  }

  if (uniquePIDs.length > 10) {
    logger.info(`[PID Finder]   ... and ${uniquePIDs.length - 10} more unique PIDs`);
  }

  return candidates;
}
