import {
  nextSeed,
  seedToRandom,
  advanceSeed,
  generateMethod1,
  isShinyPID,
  findNextShinyFrame,
  NATURE_NAMES,
  generateIVs,
} from '../src/engine/rng';

describe('Gen 3 PRNG Algorithm', () => {
  test('seed 0 advances to 0x6073', () => {
    expect(nextSeed(0)).toBe(0x6073);
  });

  test('second advance matches BigInt calculation', () => {
    const s1 = nextSeed(0);
    const s2 = nextSeed(s1);
    const expected = Number((BigInt(0x41C64E6D) * BigInt(0x6073) + BigInt(0x6073)) & BigInt(0xFFFFFFFF));
    expect(s2).toBe(expected);
  });

  test('seedToRandom extracts upper 16 bits', () => {
    expect(seedToRandom(0x12345678)).toBe(0x1234);
    expect(seedToRandom(0xABCD0000)).toBe(0xABCD);
  });
});

describe('Advance Seed', () => {
  test('batch advance matches manual loop', () => {
    let manual = 0;
    for (let i = 0; i < 100; i++) manual = nextSeed(manual);
    expect(advanceSeed(0, 100)).toBe(manual);
  });
});

describe('Method 1 PID/IV Generation', () => {
  const m1 = generateMethod1(0x6073, 0);

  test('produces non-zero PID', () => {
    expect(m1.pid).not.toBe(0);
  });

  test('nature is in valid range', () => {
    expect(m1.nature).toBeGreaterThanOrEqual(0);
    expect(m1.nature).toBeLessThan(25);
  });

  test('ability is 0 or 1', () => {
    expect([0, 1]).toContain(m1.ability);
  });

  test('PID = (high << 16) | low', () => {
    expect(((m1.pidHigh << 16) | m1.pidLow) >>> 0).toBe(m1.pid >>> 0);
  });
});

describe('Shiny Check', () => {
  test('XOR=0 is shiny', () => {
    expect(isShinyPID(0, 0, 0, 0)).toBe(true);
  });

  test('XOR=7 is shiny', () => {
    expect(isShinyPID(0, 0, 0, 7)).toBe(true);
  });

  test('XOR=8 is NOT shiny', () => {
    expect(isShinyPID(0, 0, 0, 8)).toBe(false);
  });

  test('matching TID/SID and PID is shiny', () => {
    expect(isShinyPID(12345, 54321, 12345, 54321)).toBe(true);
  });
});

describe('IV Generation', () => {
  const m1 = generateMethod1(0x6073, 0);
  const ivs = generateIVs(m1.iv1Seed);

  test.each(['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const)('%s IV is 0-31', (stat) => {
    expect(ivs[stat]).toBeGreaterThanOrEqual(0);
    expect(ivs[stat]).toBeLessThanOrEqual(31);
  });
});

describe('Find Shiny Frame', () => {
  test('finds a shiny within 100k frames', () => {
    const result = findNextShinyFrame(0, 0, 0, 100000);
    expect(result).not.toBeNull();
    expect(result!.frameOffset).toBeGreaterThanOrEqual(0);
    expect(isShinyPID(0, 0, result!.result.pidHigh, result!.result.pidLow)).toBe(true);
  });

  test('finds Adamant shiny within 500k frames', () => {
    const adamant = NATURE_NAMES.indexOf('Adamant');
    const result = findNextShinyFrame(0, 0, 0, 500000, adamant);
    expect(result).not.toBeNull();
    expect(result!.result.nature).toBe(adamant);
  });
});

describe('Shiny Rate Validation', () => {
  test('rate is approximately 1/8192', () => {
    let shinies = 0;
    let seed = 0x12345678;
    for (let i = 0; i < 100000; i++) {
      const m = generateMethod1(seed, i);
      if (isShinyPID(31337, 12345, m.pidHigh, m.pidLow)) shinies++;
      seed = nextSeed(seed);
    }
    // Expected ~12 shinies (1/8192 × 100k), allow 3-30
    expect(shinies).toBeGreaterThanOrEqual(3);
    expect(shinies).toBeLessThanOrEqual(30);
  });
});
