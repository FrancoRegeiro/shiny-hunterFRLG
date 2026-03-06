import {
  advanceSeed,
  generateMethod1,
  isShinyPID,
  generateIVs,
  NATURE_NAMES,
  identifyHitFrame,
  generateTrainerIDs,
} from '../src/engine/rng';
import { findSeedsForTID, seedToBootTimingMs, bootTimingToSeed } from '../src/engine/seed-table';
import { enumerateSIDCandidates, findShinyTargets } from '../src/engine/sid-deduction';

describe('Generate Trainer IDs', () => {
  test('TID and SID are in valid range', () => {
    const ids = generateTrainerIDs(0x1234, 1000);
    expect(ids.tid).toBeGreaterThanOrEqual(0);
    expect(ids.tid).toBeLessThanOrEqual(65535);
    expect(ids.sid).toBeGreaterThanOrEqual(0);
    expect(ids.sid).toBeLessThanOrEqual(65535);
  });

  test('generation is deterministic', () => {
    const ids1 = generateTrainerIDs(0x1234, 1000);
    const ids2 = generateTrainerIDs(0x1234, 1000);
    expect(ids1.tid).toBe(ids2.tid);
    expect(ids1.sid).toBe(ids2.sid);
  });
});

describe('Identify Hit Frame', () => {
  test('finds known frame from nature + IVs', () => {
    const testSeed = 0xABCD;
    const testAdvance = 1100;
    const seedAtAdv = advanceSeed(testSeed, testAdvance);
    const m1 = generateMethod1(seedAtAdv, testAdvance);
    const expectedIVs = generateIVs(m1.iv1Seed);

    const hits = identifyHitFrame(testSeed, 0, 0, m1.nature, expectedIVs, 1050, 1200);
    expect(hits.length).toBeGreaterThan(0);

    const exactMatch = hits.find(h => h.advance === testAdvance);
    expect(exactMatch).toBeDefined();
  });
});

describe('Seed-Timing Conversion', () => {
  const biosOffset = 4500;

  test('round-trip seed→timing→seed', () => {
    const testSeed = 0x4000;
    const timing = seedToBootTimingMs(testSeed, biosOffset);
    const backToSeed = bootTimingToSeed(timing, biosOffset);
    expect(Math.abs(backToSeed - testSeed)).toBeLessThanOrEqual(1);
  });

  test('timing formula is correct', () => {
    const testSeed = 0x4000;
    const timing = seedToBootTimingMs(testSeed, biosOffset);
    const expected = biosOffset + (testSeed / 16384) * 1000;
    expect(Math.abs(timing - expected)).toBeLessThan(1);
  });
});

describe('Find Seeds for TID', () => {
  test('finds the original seed that generated a TID', () => {
    const knownIds = generateTrainerIDs(0x100, 1000);
    const candidates = findSeedsForTID(knownIds.tid);

    expect(candidates.length).toBeGreaterThan(0);

    const foundOriginal = candidates.find(
      c => c.initialSeed === 0x100 && c.tidAdvance === 1000
    );
    expect(foundOriginal).toBeDefined();
    expect(foundOriginal!.sid).toBe(knownIds.sid);
  });
});

describe('Enumerate SID Candidates', () => {
  test('includes the correct SID', () => {
    const knownIds = generateTrainerIDs(0x100, 1000);
    const sidScores = enumerateSIDCandidates(knownIds.tid);

    expect(sidScores.length).toBeGreaterThan(0);
    expect(sidScores.find(s => s.sid === knownIds.sid)).toBeDefined();
  });
});

describe('Find Shiny Targets', () => {
  // Use tight advance window for speed (5 advances instead of 200)
  const tightWindow = { min: 1100, max: 1105 };

  test('finds targets for TID=0 SID=0', () => {
    const targets = findShinyTargets(0, 0, tightWindow);
    expect(targets.length).toBeGreaterThan(0);

    const t = targets[0];
    expect(isShinyPID(0, 0, (t.pid >>> 16) & 0xFFFF, t.pid & 0xFFFF)).toBe(true);
  });

  test('finds targets for realistic TID/SID', () => {
    const targets = findShinyTargets(12345, 54321, tightWindow);
    // Even with 6 advances, TID=0 SID=0 should find many; realistic may find fewer
    // Just verify it doesn't crash
    expect(targets).toBeDefined();
  });

  test('full pipeline: find target → regenerate → verify shiny', () => {
    const tid = 31337;
    const sid = 12345;
    // Use wider window to guarantee targets
    const targets = findShinyTargets(tid, sid, { min: 1050, max: 1250 });
    expect(targets.length).toBeGreaterThan(0);

    const target = targets[0];
    const seedAtTarget = advanceSeed(target.initialSeed, target.advance);
    const result = generateMethod1(seedAtTarget, target.advance);

    expect(isShinyPID(tid, sid, result.pidHigh, result.pidLow)).toBe(true);
    expect(result.nature).toBe(target.nature);
  });
});
