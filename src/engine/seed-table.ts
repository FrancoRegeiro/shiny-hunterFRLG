/**
 * Timer1 seed generation and TID-to-seed lookup for FRLG.
 *
 * On GBA, the PRNG is seeded from the Timer1 counter value when
 * transitioning from the title screen into gameplay. Timer1 is a
 * 16-bit value (0x0000-0xFFFF), so there are exactly 65536 possible
 * initial seeds.
 *
 * During a new game, TID and SID are generated from consecutive
 * PRNG calls at a known advance count. Given a visible TID, we can
 * enumerate which initial seeds produce that TID and what the
 * corresponding SID would be.
 */

import { nextSeed, seedToRandom, advanceSeed } from './rng';

export interface SeedCandidate {
  initialSeed: number;   // Timer1 value (0x0000-0xFFFF)
  tidAdvance: number;    // advance count where TID was generated
  tid: number;
  sid: number;
}

export interface ShinyTarget {
  initialSeed: number;
  advanceToShiny: number;  // total advances from initial seed to shiny PID
  nature: number;
  pid: number;
  ivs: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number };
}

// FRLG TID generation advance counts to search.
// The exact advance depends on game version, language, and text speed.
// We search a range to cover all common configurations.
// Community-known values: English FRLG typically generates TID at advances
// in the range ~800-1200 during new game creation.
const TID_ADVANCE_RANGE = { min: 800, max: 1500 };

/**
 * Find all initial seeds (Timer1 values) that produce the given TID.
 * Returns candidate (seed, SID) pairs.
 */
export function findSeedsForTID(tid: number): SeedCandidate[] {
  const candidates: SeedCandidate[] = [];

  for (let initSeed = 0; initSeed <= 0xFFFF; initSeed++) {
    // Walk the PRNG from this initial seed through the TID advance range
    let seed = initSeed;
    // Advance to the start of the search range
    seed = advanceSeed(seed, TID_ADVANCE_RANGE.min);

    for (let adv = TID_ADVANCE_RANGE.min; adv <= TID_ADVANCE_RANGE.max; adv++) {
      // TID = upper 16 bits of this call
      const s1 = nextSeed(seed);
      const candidateTid = seedToRandom(s1);

      if (candidateTid === tid) {
        // SID = upper 16 bits of the next call
        const s2 = nextSeed(s1);
        const candidateSid = seedToRandom(s2);

        candidates.push({
          initialSeed: initSeed,
          tidAdvance: adv,
          tid: candidateTid,
          sid: candidateSid,
        });
      }

      seed = nextSeed(seed);
    }
  }

  return candidates;
}

/**
 * Get all unique SID values from a set of seed candidates.
 */
export function getUniqueSIDs(candidates: SeedCandidate[]): number[] {
  return [...new Set(candidates.map(c => c.sid))];
}

/**
 * Timer1 ↔ boot timing conversion.
 * Timer1 runs at CPU_CLOCK / 1024 ≈ 16384 Hz.
 * The absolute timing depends on a fixed BIOS offset.
 */
const TIMER1_HZ = 16384;

export function seedToBootTimingMs(seed: number, biosOffsetMs: number): number {
  // seed = Timer1 counter value at title screen A press
  // Timer1 increments from 0 at boot (simplified model)
  return biosOffsetMs + (seed / TIMER1_HZ) * 1000;
}

export function bootTimingToSeed(timingMs: number, biosOffsetMs: number): number {
  const elapsed = Math.max(0, timingMs - biosOffsetMs);
  const seed = Math.round((elapsed / 1000) * TIMER1_HZ) & 0xFFFF;
  return seed;
}

/**
 * Get the range of seeds within ±toleranceMs of a target timing.
 */
export function seedsInTimingWindow(
  targetMs: number,
  toleranceMs: number,
  biosOffsetMs: number,
): { min: number; max: number; count: number } {
  const minSeed = bootTimingToSeed(targetMs - toleranceMs, biosOffsetMs);
  const maxSeed = bootTimingToSeed(targetMs + toleranceMs, biosOffsetMs);
  return {
    min: minSeed & 0xFFFF,
    max: maxSeed & 0xFFFF,
    count: Math.abs(maxSeed - minSeed) + 1,
  };
}
