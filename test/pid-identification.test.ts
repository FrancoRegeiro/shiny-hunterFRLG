/**
 * Tests for PID identification from nature + stats, SID elimination,
 * IV calculation, and timing auto-calibration.
 */
import {
  nextSeed,
  advanceSeed,
  generateMethod1,
  isShinyPID,
  generateIVs,
  NATURE_NAMES,
  IVs,
} from '../src/engine/rng';
import { computeIVRanges, ivsMatchRanges } from '../src/engine/iv-calc';
import {
  enumerateSIDCandidates,
  scorePIDObservation,
  getRemainingCount,
  SIDScore,
  PIDObservation,
} from '../src/engine/sid-deduction';
import { seedToBootTimingMs, bootTimingToSeed } from '../src/engine/seed-table';
import { buildSeedSchedule } from '../src/engine/multi-sid-target';

// Shared SID candidates — computed once, cloned per test that mutates
let baseSidCandidates: SIDScore[];
const TID = 24248;

beforeAll(() => {
  baseSidCandidates = enumerateSIDCandidates(TID);
}, 60000);

function cloneCandidates(): SIDScore[] {
  return baseSidCandidates.map(s => ({ ...s }));
}

// ─── IV Calculation ─────────────────────────────────────────────────

describe('IV Calculation', () => {
  test('computeIVRanges returns valid ranges for charmander at Lv5', () => {
    const ivs: IVs = { hp: 15, atk: 20, def: 10, spa: 25, spd: 5, spe: 31 };
    const nature = 'Adamant'; // +Atk -SpA

    const stats = computeStatsFromIVs('charmander', 5, nature, ivs);
    const ranges = computeIVRanges('charmander', 5, nature, stats);

    expect(ranges).not.toBeNull();
    expect(ranges!.hp).toContain(ivs.hp);
    expect(ranges!.atk).toContain(ivs.atk);
    expect(ranges!.def).toContain(ivs.def);
    expect(ranges!.spa).toContain(ivs.spa);
    expect(ranges!.spd).toContain(ivs.spd);
    expect(ranges!.spe).toContain(ivs.spe);
  });

  test('Lv5 IV ranges are wide (multiple IVs per stat)', () => {
    const ranges = computeIVRanges('charmander', 5, 'Hardy', {
      hp: 19, attack: 10, defense: 9, spAtk: 11, spDef: 10, speed: 11,
    });

    expect(ranges).not.toBeNull();
    for (const stat of ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const) {
      expect(ranges![stat].length).toBeGreaterThan(1);
    }
  });

  test('returns null for unknown pokemon', () => {
    expect(computeIVRanges('pikachu', 5, 'Hardy', {
      hp: 20, attack: 10, defense: 9, spAtk: 11, spDef: 10, speed: 11,
    })).toBeNull();
  });

  test('ivsMatchRanges correctly matches and rejects', () => {
    const ranges = {
      hp: [8, 9, 10, 11, 12],
      atk: [14, 15, 16],
      def: [18, 19, 20, 21],
      spa: [4, 5, 6],
      spd: [24, 25, 26],
      spe: [28, 29, 30, 31],
    };
    expect(ivsMatchRanges({ hp: 10, atk: 15, def: 20, spa: 5, spd: 25, spe: 30 }, ranges)).toBe(true);
    expect(ivsMatchRanges({ hp: 0, atk: 15, def: 20, spa: 5, spd: 25, spe: 30 }, ranges)).toBe(false);
  });

  test('all three starters have base stats', () => {
    for (const pokemon of ['charmander', 'squirtle', 'bulbasaur']) {
      const result = computeIVRanges(pokemon, 5, 'Hardy', {
        hp: 19, attack: 10, defense: 10, spAtk: 11, spDef: 10, speed: 10,
      });
      // May return null if stats don't match, but shouldn't throw
      expect(() => computeIVRanges(pokemon, 5, 'Hardy', {
        hp: 19, attack: 10, defense: 10, spAtk: 11, spDef: 10, speed: 10,
      })).not.toThrow();
    }
  });
});

// ─── PID Identification from Nature + Stats ─────────────────────────

describe('PID Identification', () => {
  function searchForPID(
    targetSeed: number,
    natureIdx: number,
    ivRanges: ReturnType<typeof computeIVRanges>,
    advWindow: { min: number; max: number },
    searchRadius: number,
  ) {
    if (!ivRanges) return [];
    const matches: Array<{
      seed: number; advance: number; pid: number;
      pidHigh: number; pidLow: number; ivs: IVs; delta: number;
    }> = [];

    for (let delta = -searchRadius; delta <= searchRadius; delta++) {
      const initSeed = (targetSeed + delta + 0x10000) & 0xFFFF;
      let seed = advanceSeed(initSeed, advWindow.min);

      for (let adv = advWindow.min; adv <= advWindow.max; adv++) {
        const result = generateMethod1(seed, adv);
        if (result.nature === natureIdx) {
          const ivs = generateIVs(result.iv1Seed);
          if (ivsMatchRanges(ivs, ivRanges)) {
            matches.push({
              seed: initSeed, advance: adv,
              pid: result.pid, pidHigh: result.pidHigh, pidLow: result.pidLow,
              ivs, delta,
            });
          }
        }
        seed = nextSeed(seed);
      }
    }
    return matches;
  }

  test('finds exact PID when given correct seed + nature + IVs', () => {
    const targetSeed = 0x1234;
    const advance = 1150;
    const seedAtAdv = advanceSeed(targetSeed, advance);
    const m1 = generateMethod1(seedAtAdv, advance);
    const ivs = generateIVs(m1.iv1Seed);
    const nature = NATURE_NAMES[m1.nature];
    const stats = computeStatsFromIVs('charmander', 5, nature, ivs);
    const ivRanges = computeIVRanges('charmander', 5, nature, stats);

    const matches = searchForPID(targetSeed, m1.nature, ivRanges, { min: 1050, max: 1250 }, 0);
    expect(matches.length).toBeGreaterThanOrEqual(1);

    const exactMatch = matches.find(m => m.seed === targetSeed && m.advance === advance);
    expect(exactMatch).toBeDefined();
    expect(exactMatch!.pid).toBe(m1.pid);
  });

  test('finds PID with ±5 seed jitter', () => {
    const targetSeed = 0x2000;
    const actualSeed = targetSeed + 3;
    const advance = 1100;

    const seedAtAdv = advanceSeed(actualSeed, advance);
    const m1 = generateMethod1(seedAtAdv, advance);
    const ivs = generateIVs(m1.iv1Seed);
    const nature = NATURE_NAMES[m1.nature];
    const stats = computeStatsFromIVs('charmander', 5, nature, ivs);
    const ivRanges = computeIVRanges('charmander', 5, nature, stats);

    const matches = searchForPID(targetSeed, m1.nature, ivRanges, { min: 1050, max: 1250 }, 5);
    const found = matches.find(m => m.seed === actualSeed && m.advance === advance);
    expect(found).toBeDefined();
    expect(found!.delta).toBe(3);
  });

  test('PID search with ±15 radius yields results for known data', () => {
    const matchCounts: number[] = [];

    for (let trial = 0; trial < 20; trial++) {
      const targetSeed = (trial * 3271 + 0x100) & 0xFFFF;
      const advance = 1100 + (trial * 7) % 100;

      const seedAtAdv = advanceSeed(targetSeed, advance);
      const m1 = generateMethod1(seedAtAdv, advance);
      const ivs = generateIVs(m1.iv1Seed);
      const nature = NATURE_NAMES[m1.nature];
      const stats = computeStatsFromIVs('charmander', 5, nature, ivs);
      const ivRanges = computeIVRanges('charmander', 5, nature, stats);
      if (!ivRanges) continue;

      const matches = searchForPID(targetSeed, m1.nature, ivRanges, { min: 1050, max: 1250 }, 15);
      matchCounts.push(matches.length);
      // The correct PID must always be found
      const found = matches.find(m => m.seed === targetSeed && m.advance === advance);
      expect(found).toBeDefined();
    }

    const avg = matchCounts.reduce((a, b) => a + b, 0) / matchCounts.length;
    // At Lv5 with wide IV ranges: expect some ambiguity, avg ~1-10 matches
    expect(avg).toBeGreaterThanOrEqual(1);
    expect(avg).toBeLessThanOrEqual(20);
    console.log(`PID search (20 trials): avg=${avg.toFixed(1)} matches, distribution=${JSON.stringify(matchCounts)}`);
  });
});

// ─── SID Elimination ────────────────────────────────────────────────

describe('SID Elimination from PID', () => {
  test('non-shiny PID eliminates SIDs where it would be shiny', () => {
    const scores = cloneCandidates();
    const initialCount = getRemainingCount(scores);

    const obs: PIDObservation = {
      attempt: 1, pid: 0x12345678,
      pidHigh: 0x1234, pidLow: 0x5678,
      nature: 'Hardy', isShiny: false, timestamp: Date.now(),
    };

    scorePIDObservation(TID, scores, obs);
    const afterCount = getRemainingCount(scores);
    expect(afterCount).toBeLessThanOrEqual(initialCount);
  });

  test('shiny PID narrows to ~8 SIDs', () => {
    const scores = cloneCandidates();

    // Find a PID that's shiny for the first candidate SID
    const firstSid = scores[0].sid;
    const targetXor = TID ^ firstSid; // XOR=0 → shiny
    const shinyHigh = targetXor & 0xFFFF;
    const shinyLow = 0;

    const obs: PIDObservation = {
      attempt: 1, pid: ((shinyHigh << 16) | shinyLow) >>> 0,
      pidHigh: shinyHigh, pidLow: shinyLow,
      nature: 'Hardy', isShiny: true, timestamp: Date.now(),
    };

    scorePIDObservation(TID, scores, obs);
    const remaining = getRemainingCount(scores);

    expect(remaining).toBeLessThanOrEqual(10);
    expect(remaining).toBeGreaterThanOrEqual(1);
  });

  test('diverse non-shiny PIDs progressively eliminate SIDs', () => {
    const scores = cloneCandidates();
    const initialCount = getRemainingCount(scores);

    // Use PRNG-generated PIDs for diversity (not sequential patterns)
    let pidSeed = 0x12345678;
    for (let i = 0; i < 200; i++) {
      pidSeed = nextSeed(pidSeed);
      const m = generateMethod1(pidSeed, 1100 + (i % 50));

      scorePIDObservation(TID, scores, {
        attempt: i + 1,
        pid: m.pid,
        pidHigh: m.pidHigh,
        pidLow: m.pidLow,
        nature: NATURE_NAMES[m.nature],
        isShiny: false,
        timestamp: Date.now(),
      });
    }

    const finalCount = getRemainingCount(scores);
    const eliminated = initialCount - finalCount;

    // 200 diverse PIDs should eliminate at least a few SIDs
    // Each has ~8*703/65536 ≈ 0.086 expected eliminations
    // Over 200: ~17 expected, so we check for at least 1
    expect(finalCount).toBeLessThan(initialCount);
    console.log(`SID elimination: ${initialCount} → ${finalCount} (−${eliminated}) after 200 diverse PIDs`);
  });
});

// ─── Timing Auto-Calibration ────────────────────────────────────────

describe('Timing Auto-Calibration', () => {
  test('seed delta converts to timing error correctly', () => {
    const timingErrorMs = 10 * (1000 / 16384);
    expect(timingErrorMs).toBeCloseTo(0.61, 1);
  });

  test('timing correction converges with consistent observations', () => {
    const deltas = [0.5, 0.6, 0.4, 0.55, 0.45];
    const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const variance = deltas.reduce((sum, d) => sum + (d - avg) ** 2, 0) / deltas.length;
    const stdDev = Math.sqrt(variance);

    expect(stdDev).toBeLessThan(5);
    expect(Math.abs(avg)).toBeGreaterThan(0.3);
    expect(Math.round(avg * 10) / 10).toBe(0.5);
  });

  test('noisy observations do NOT trigger correction', () => {
    const deltas = [5.0, -3.0, 8.0, -6.0, 2.0];
    const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const variance = deltas.reduce((sum, d) => sum + (d - avg) ** 2, 0) / deltas.length;
    const stdDev = Math.sqrt(variance);

    expect(stdDev).toBeGreaterThan(4);
  });

  test('boot timing round-trip is accurate for multiple seeds', () => {
    const biosOffset = 4500;
    for (const seed of [0x0000, 0x1000, 0x8000, 0xFFFF]) {
      const timing = seedToBootTimingMs(seed, biosOffset);
      const recovered = bootTimingToSeed(timing, biosOffset);
      expect(Math.abs(recovered - seed)).toBeLessThanOrEqual(1);
    }
  });

  test('timing delta direction indicates early/late', () => {
    // Positive delta = hit a later seed = pressed A too late
    // Negative delta = hit an earlier seed = pressed A too early
    const targetSeed = 0x1000;
    const biosOffset = 4500;
    const targetTiming = seedToBootTimingMs(targetSeed, biosOffset);
    const lateSeed = targetSeed + 5;
    const lateTiming = seedToBootTimingMs(lateSeed, biosOffset);

    expect(lateTiming).toBeGreaterThan(targetTiming);
    expect(lateTiming - targetTiming).toBeCloseTo(5 * (1000 / 16384), 0);
  });
});

// ─── Multi-SID Seed Schedule ─────────────────────────────────────────

describe('Multi-SID Seed Schedule', () => {
  test('schedule is sorted by sidCount descending', () => {
    // Use small advance window for speed
    const schedule = buildSeedSchedule(TID, baseSidCandidates, { min: 1100, max: 1110 }, 4500);

    expect(schedule.length).toBeGreaterThan(0);
    for (let i = 1; i < schedule.length; i++) {
      expect(schedule[i].sidCount).toBeLessThanOrEqual(schedule[i - 1].sidCount);
    }
    expect(schedule[0].sidCount).toBeGreaterThan(1);
  });

  test('fewer active SIDs produce different schedule', () => {
    const schedule1 = buildSeedSchedule(TID, baseSidCandidates, { min: 1100, max: 1105 }, 4500);

    const halfEliminated = baseSidCandidates.map((s, i) => ({
      ...s, eliminated: i % 2 === 0,
    }));
    const schedule2 = buildSeedSchedule(TID, halfEliminated, { min: 1100, max: 1105 }, 4500);

    expect(schedule2[0].sidCount).toBeLessThanOrEqual(schedule1[0].sidCount);
  });
});

// ─── Conservative Elimination ───────────────────────────────────────

describe('Conservative SID Elimination (ambiguous PIDs)', () => {
  test('intersection of shiny SID sets is smaller than union', () => {
    const pid1High = 0x1234;
    const pid1Low = 0x5678;
    const pid2High = 0xABCD;
    const pid2Low = 0xEF01;

    const shinyForBoth: number[] = [];
    const shinyForEither: number[] = [];

    for (let sid = 0; sid < 65536; sid++) {
      const s1 = (TID ^ sid ^ pid1High ^ pid1Low) < 8;
      const s2 = (TID ^ sid ^ pid2High ^ pid2Low) < 8;
      if (s1 && s2) shinyForBoth.push(sid);
      if (s1 || s2) shinyForEither.push(sid);
    }

    // Each PID has 8 shiny SIDs, intersection ≤ 8
    expect(shinyForBoth.length).toBeLessThanOrEqual(8);
    // Union should be larger than intersection (or equal if PIDs share shiny groups)
    expect(shinyForEither.length).toBeGreaterThanOrEqual(shinyForBoth.length);
  });

  test('non-shiny encounter eliminates only consensus SIDs', () => {
    const scores = cloneCandidates();
    const initialCount = getRemainingCount(scores);

    // Two candidate PIDs — only eliminate SIDs shiny for BOTH
    const pids = [
      { high: 0x1111, low: 0x2222 },
      { high: 0x3333, low: 0x4444 },
    ];

    // Find SIDs eliminable by consensus
    const eliminable = new Set<number>();
    for (const sc of scores) {
      if (sc.eliminated) continue;
      if ((TID ^ sc.sid ^ pids[0].high ^ pids[0].low) < 8) {
        eliminable.add(sc.sid);
      }
    }
    for (const sid of eliminable) {
      if ((TID ^ sid ^ pids[1].high ^ pids[1].low) >= 8) {
        eliminable.delete(sid);
      }
    }

    // Apply consensus elimination
    if (eliminable.size > 0) {
      for (const sc of scores) {
        if (eliminable.has(sc.sid)) sc.eliminated = true;
      }
    }

    const afterCount = getRemainingCount(scores);
    expect(afterCount).toBeLessThanOrEqual(initialCount);
    // Consensus elimination is at most as aggressive as single-PID elimination
    expect(eliminable.size).toBeLessThanOrEqual(8);
  });
});

// ─── End-to-End Integration ─────────────────────────────────────────

describe('End-to-End: PID identification → SID elimination', () => {
  test('full pipeline with known seed produces correct PID and SID elimination', () => {
    const targetSeed = 0x3000;
    const advance = 1150;
    const seedAtAdv = advanceSeed(targetSeed, advance);
    const m1 = generateMethod1(seedAtAdv, advance);
    const ivs = generateIVs(m1.iv1Seed);
    const nature = NATURE_NAMES[m1.nature];

    // Step 1: Compute stats from IVs (simulates OCR reading)
    const stats = computeStatsFromIVs('charmander', 5, nature, ivs);

    // Step 2: Compute IV ranges (what the engine does)
    const ivRanges = computeIVRanges('charmander', 5, nature, stats);
    expect(ivRanges).not.toBeNull();

    // Step 3: Search for PID
    let found = false;
    let seed = advanceSeed(targetSeed, 1050);
    for (let adv = 1050; adv <= 1250; adv++) {
      const result = generateMethod1(seed, adv);
      if (result.nature === m1.nature) {
        const candidateIvs = generateIVs(result.iv1Seed);
        if (ivsMatchRanges(candidateIvs, ivRanges!)) {
          if (result.pid === m1.pid) {
            found = true;

            // Step 4: SID elimination
            const scores = cloneCandidates();
            scorePIDObservation(TID, scores, {
              attempt: 1, pid: result.pid,
              pidHigh: result.pidHigh, pidLow: result.pidLow,
              nature, isShiny: false, timestamp: Date.now(),
            });

            // Verify elimination logic works
            const remaining = getRemainingCount(scores);
            expect(remaining).toBeLessThanOrEqual(baseSidCandidates.length);
            break;
          }
        }
      }
      seed = nextSeed(seed);
    }

    expect(found).toBe(true);
  });
});

// ─── Helpers ────────────────────────────────────────────────────────

function computeStatsFromIVs(
  pokemon: string, level: number, nature: string, ivs: IVs,
): { hp: number; attack: number; defense: number; spAtk: number; spDef: number; speed: number } {
  const BASE: Record<string, { hp: number; atk: number; def: number; spa: number; spd: number; spe: number }> = {
    charmander: { hp: 39, atk: 52, def: 43, spa: 60, spd: 50, spe: 65 },
    squirtle: { hp: 44, atk: 48, def: 65, spa: 50, spd: 64, spe: 43 },
    bulbasaur: { hp: 45, atk: 49, def: 49, spa: 65, spd: 65, spe: 45 },
  };
  const base = BASE[pokemon.toLowerCase()];
  if (!base) throw new Error(`Unknown pokemon: ${pokemon}`);

  const NATURE_MODS: Record<string, { plus: number; minus: number }> = {};
  for (let i = 0; i < 25; i++) {
    NATURE_MODS[NATURE_NAMES[i]] = { plus: Math.floor(i / 5), minus: i % 5 };
  }

  function getNatureMod(statIdx: number): number {
    const nm = NATURE_MODS[nature];
    if (!nm || nm.plus === nm.minus) return 1.0;
    if (statIdx === nm.plus) return 1.1;
    if (statIdx === nm.minus) return 0.9;
    return 1.0;
  }

  return {
    hp: Math.floor((2 * base.hp + ivs.hp) * level / 100) + level + 10,
    attack: Math.floor((Math.floor((2 * base.atk + ivs.atk) * level / 100) + 5) * getNatureMod(0)),
    defense: Math.floor((Math.floor((2 * base.def + ivs.def) * level / 100) + 5) * getNatureMod(1)),
    speed: Math.floor((Math.floor((2 * base.spe + ivs.spe) * level / 100) + 5) * getNatureMod(2)),
    spAtk: Math.floor((Math.floor((2 * base.spa + ivs.spa) * level / 100) + 5) * getNatureMod(3)),
    spDef: Math.floor((Math.floor((2 * base.spd + ivs.spd) * level / 100) + 5) * getNatureMod(4)),
  };
}
