/**
 * Multi-SID targeting: find shiny timing windows without knowing the exact SID.
 *
 * Instead of deducing SID first, we:
 * 1. Enumerate all candidate SIDs for the known TID
 * 2. For each SID, find all shiny targets in the advance window
 * 3. Group by boot timing — find timing windows where many SIDs produce shinies
 * 4. Target the densest timing windows (highest probability of hitting a shiny)
 *
 * With ~703 candidate SIDs and ~200 advances per seed, we get enough targets
 * that timing overlap is common. Any shiny we hit confirms the SID retroactively.
 */

import path from 'path';
import fs from 'fs/promises';
import {
  nextSeed,
  advanceSeed,
  generateMethod1,
  generateIVs,
  isShinyPID,
  NATURE_NAMES,
  IVs,
} from './rng';
import { seedToBootTimingMs } from './seed-table';
import { SIDScore } from './sid-deduction';
import { logger } from '../logger';

const SCHEDULE_CACHE = path.join(process.cwd(), 'data', 'seed-schedule-cache.json');

export interface MultiSIDTarget {
  initialSeed: number;
  advance: number;
  nature: string;
  pid: number;
  ivs: IVs;
  targetBootTimingMs: number;
  candidateSIDs: number[];  // which SIDs would make this shiny
}

/**
 * Lightweight target for scheduling — only store what we need for timing.
 */
export interface SeedScheduleEntry {
  initialSeed: number;
  targetBootTimingMs: number;
  sidCount: number;  // how many SIDs are shiny at this seed (across any advance)
}

/**
 * Build a seed schedule: for each initial seed, count how many SIDs
 * have at least one shiny advance. This is memory-efficient.
 */
export function buildSeedSchedule(
  tid: number,
  sidCandidates: SIDScore[],
  advanceWindow: { min: number; max: number },
  biosOffsetMs: number,
): SeedScheduleEntry[] {
  const activeSIDs = sidCandidates.filter(s => !s.eliminated).map(s => s.sid);
  const schedule: SeedScheduleEntry[] = [];

  for (let initSeed = 0; initSeed <= 0xFFFF; initSeed++) {
    let seed = advanceSeed(initSeed, advanceWindow.min);
    const shinySIDs = new Set<number>();

    for (let adv = advanceWindow.min; adv <= advanceWindow.max; adv++) {
      const result = generateMethod1(seed, adv);

      for (const sid of activeSIDs) {
        if (isShinyPID(tid, sid, result.pidHigh, result.pidLow)) {
          shinySIDs.add(sid);
        }
      }

      seed = nextSeed(seed);
    }

    if (shinySIDs.size > 0) {
      schedule.push({
        initialSeed: initSeed,
        targetBootTimingMs: seedToBootTimingMs(initSeed, biosOffsetMs),
        sidCount: shinySIDs.size,
      });
    }
  }

  // Sort by SID count descending — prioritize seeds covering the most SIDs
  schedule.sort((a, b) => b.sidCount - a.sidCount);
  return schedule;
}

/**
 * Find detailed shiny targets for a specific initial seed.
 * Called on-demand when targeting a specific seed.
 */
export function findTargetsForSeed(
  tid: number,
  sidCandidates: SIDScore[],
  initialSeed: number,
  advanceWindow: { min: number; max: number },
  biosOffsetMs: number,
): MultiSIDTarget[] {
  const activeSIDs = sidCandidates.filter(s => !s.eliminated).map(s => s.sid);
  const targets: MultiSIDTarget[] = [];
  let seed = advanceSeed(initialSeed, advanceWindow.min);

  for (let adv = advanceWindow.min; adv <= advanceWindow.max; adv++) {
    const result = generateMethod1(seed, adv);
    const matchingSIDs: number[] = [];

    for (const sid of activeSIDs) {
      if (isShinyPID(tid, sid, result.pidHigh, result.pidLow)) {
        matchingSIDs.push(sid);
      }
    }

    if (matchingSIDs.length > 0) {
      const ivs = generateIVs(result.iv1Seed);
      targets.push({
        initialSeed,
        advance: adv,
        nature: NATURE_NAMES[result.nature],
        pid: result.pid,
        ivs,
        targetBootTimingMs: seedToBootTimingMs(initialSeed, biosOffsetMs),
        candidateSIDs: matchingSIDs,
      });
    }

    seed = nextSeed(seed);
  }

  return targets;
}

/**
 * Load cached seed schedule if it exists and matches current TID + advance window.
 */
async function loadCachedSchedule(
  tid: number,
  advanceWindow: { min: number; max: number },
  activeSIDCount: number,
): Promise<SeedScheduleEntry[] | null> {
  try {
    const raw = await fs.readFile(SCHEDULE_CACHE, 'utf-8');
    const cached = JSON.parse(raw);
    if (cached.tid === tid && cached.advMin === advanceWindow.min &&
        cached.advMax === advanceWindow.max && cached.activeSIDCount === activeSIDCount) {
      logger.info(`[Multi-SID] Loaded cached seed schedule (${cached.schedule.length} entries, ${activeSIDCount} active SIDs)`);
      return cached.schedule;
    }
    if (cached.activeSIDCount !== activeSIDCount) {
      logger.info(`[Multi-SID] Cache stale: SID count changed (${cached.activeSIDCount} → ${activeSIDCount}), rebuilding`);
    }
  } catch { /* no cache or invalid */ }
  return null;
}

async function saveCachedSchedule(
  tid: number,
  advanceWindow: { min: number; max: number },
  activeSIDCount: number,
  schedule: SeedScheduleEntry[],
): Promise<void> {
  try {
    await fs.writeFile(SCHEDULE_CACHE, JSON.stringify({
      tid,
      advMin: advanceWindow.min,
      advMax: advanceWindow.max,
      activeSIDCount,
      schedule,
    }));
  } catch { /* ignore */ }
}

/**
 * Compute seed schedule and log summary.
 */
export async function computeAndLogMultiSIDTargets(
  tid: number,
  sidCandidates: SIDScore[],
  advanceWindow: { min: number; max: number },
  biosOffsetMs: number,
): Promise<{ schedule: SeedScheduleEntry[] }> {
  const activeSIDs = sidCandidates.filter(s => !s.eliminated).length;

  // Try cache first
  const cached = await loadCachedSchedule(tid, advanceWindow, activeSIDs);
  if (cached) {
    return { schedule: cached };
  }

  const start = Date.now();
  const schedule = buildSeedSchedule(tid, sidCandidates, advanceWindow, biosOffsetMs);
  const elapsed = Date.now() - start;
  const totalSeeds = schedule.length;
  const maxSIDs = schedule.length > 0 ? schedule[0].sidCount : 0;
  const avgSIDs = totalSeeds > 0 ? schedule.reduce((sum, s) => sum + s.sidCount, 0) / totalSeeds : 0;

  logger.info(`[Multi-SID] Built seed schedule in ${elapsed}ms`);
  logger.info(`[Multi-SID] ${totalSeeds}/65536 seeds have shiny targets for ${activeSIDs} SID candidates`);
  logger.info(`[Multi-SID] Best seed covers ${maxSIDs} SIDs, average: ${avgSIDs.toFixed(1)}`);

  if (schedule.length > 0) {
    logger.info(`[Multi-SID] Top 5 seeds:`);
    for (const s of schedule.slice(0, 5)) {
      logger.info(`  Seed 0x${s.initialSeed.toString(16).padStart(4, '0')}: ${s.sidCount} SIDs, timing ${s.targetBootTimingMs.toFixed(0)}ms`);
    }
  }

  // Cache for next startup
  await saveCachedSchedule(tid, advanceWindow, activeSIDs, schedule);

  return { schedule };
}
