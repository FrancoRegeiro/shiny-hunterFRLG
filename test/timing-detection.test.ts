import { evaluateTimingSignal, makeShinyDecision, TimingSignal } from '../src/engine/wild-hunt';

describe('evaluateTimingSignal', () => {
  const calibrated = { avgDelay: 2000, historySize: 30 };
  const uncalibrated = { avgDelay: 0, historySize: 2 };

  describe('absolute threshold (>3500ms)', () => {
    test('3501ms = shiny regardless of baseline', () => {
      const r = evaluateTimingSignal({ textDelayMs: 3501, ...uncalibrated, elapsedSinceBattle: 3501 });
      expect(r.signal).toBe('shiny');
      expect(r.debug).toContain('ABSOLUTE SHINY');
    });

    test('4000ms = shiny even with calibrated baseline', () => {
      const r = evaluateTimingSignal({ textDelayMs: 4000, ...calibrated, elapsedSinceBattle: 4000 });
      expect(r.signal).toBe('shiny');
      expect(r.debug).toContain('ABSOLUTE SHINY');
    });

    test('3500ms exactly = shiny via relative threshold (dev 1500 > 1000)', () => {
      const r = evaluateTimingSignal({ textDelayMs: 3500, ...calibrated, elapsedSinceBattle: 3500 });
      expect(r.signal).toBe('shiny');
      expect(r.debug).toContain('SHINY'); // hits relative, not absolute
      expect(r.debug).not.toContain('ABSOLUTE'); // 3500 is not > 3500
    });
  });

  describe('relative threshold (deviation from baseline)', () => {
    test('>1000ms deviation = shiny', () => {
      // avg 2000, delay 3100 → dev 1100
      const r = evaluateTimingSignal({ textDelayMs: 3100, ...calibrated, elapsedSinceBattle: 3100 });
      expect(r.signal).toBe('shiny');
      expect(r.debug).toContain('SHINY');
    });

    test('exactly 1000ms deviation = NOT shiny', () => {
      const r = evaluateTimingSignal({ textDelayMs: 3000, ...calibrated, elapsedSinceBattle: 3000 });
      expect(r.signal).toBe('inconclusive');
      expect(r.debug).toContain('suspicious');
    });

    test('600-1000ms deviation = inconclusive (suspicious)', () => {
      // avg 2000, delay 2700 → dev 700
      const r = evaluateTimingSignal({ textDelayMs: 2700, ...calibrated, elapsedSinceBattle: 2700 });
      expect(r.signal).toBe('inconclusive');
      expect(r.debug).toContain('suspicious');
    });

    test('200-600ms deviation = inconclusive (borderline)', () => {
      // avg 2000, delay 2300 → dev 300
      const r = evaluateTimingSignal({ textDelayMs: 2300, ...calibrated, elapsedSinceBattle: 2300 });
      expect(r.signal).toBe('inconclusive');
      expect(r.debug).toContain('borderline');
    });

    test('<200ms deviation = normal', () => {
      // avg 2000, delay 2100 → dev 100
      const r = evaluateTimingSignal({ textDelayMs: 2100, ...calibrated, elapsedSinceBattle: 2100 });
      expect(r.signal).toBe('normal');
      expect(r.debug).toContain('normal');
    });

    test('negative deviation = normal', () => {
      // avg 2000, delay 1800 → dev -200
      const r = evaluateTimingSignal({ textDelayMs: 1800, ...calibrated, elapsedSinceBattle: 1800 });
      expect(r.signal).toBe('normal');
    });
  });

  describe('calibration phase', () => {
    test('under 5 samples = inconclusive (calibrating)', () => {
      const r = evaluateTimingSignal({ textDelayMs: 2000, avgDelay: 1900, historySize: 4, elapsedSinceBattle: 2000 });
      expect(r.signal).toBe('inconclusive');
      expect(r.debug).toContain('calibrating');
    });

    test('exactly 5 samples = uses relative threshold', () => {
      const r = evaluateTimingSignal({ textDelayMs: 2000, avgDelay: 1900, historySize: 5, elapsedSinceBattle: 2000 });
      expect(r.signal).toBe('normal');
    });

    test('absolute threshold still works during calibration', () => {
      const r = evaluateTimingSignal({ textDelayMs: 4000, ...uncalibrated, elapsedSinceBattle: 4000 });
      expect(r.signal).toBe('shiny');
      expect(r.debug).toContain('ABSOLUTE SHINY');
    });
  });

  describe('no text detected (OCR failure)', () => {
    test('>4500ms with no text = shiny (animation blocking)', () => {
      const r = evaluateTimingSignal({ textDelayMs: null, ...calibrated, elapsedSinceBattle: 5000 });
      expect(r.signal).toBe('shiny');
      expect(r.debug).toContain('NO TEXT');
    });

    test('4500ms exactly = NOT shiny yet', () => {
      const r = evaluateTimingSignal({ textDelayMs: null, ...calibrated, elapsedSinceBattle: 4500 });
      expect(r.signal).toBe('inconclusive');
      expect(r.debug).toContain('not detected');
    });

    test('<4500ms with no text = inconclusive', () => {
      const r = evaluateTimingSignal({ textDelayMs: null, ...calibrated, elapsedSinceBattle: 3000 });
      expect(r.signal).toBe('inconclusive');
    });
  });

  describe('real-world scenarios', () => {
    test('typical normal Pikachu (delay ~2000ms, avg ~2000ms)', () => {
      const r = evaluateTimingSignal({ textDelayMs: 2050, ...calibrated, elapsedSinceBattle: 2050 });
      expect(r.signal).toBe('normal');
    });

    test('typical shiny with sparkle delay (delay ~3300ms, avg ~2000ms)', () => {
      // 1300ms extra from 80-frame sparkle animation
      const r = evaluateTimingSignal({ textDelayMs: 3300, ...calibrated, elapsedSinceBattle: 3300 });
      expect(r.signal).toBe('shiny');
    });

    test('worst-case normal (delay 2481ms, avg 2000ms) = NOT shiny', () => {
      // max observed normal delay from 10,243 encounters
      const r = evaluateTimingSignal({ textDelayMs: 2481, ...calibrated, elapsedSinceBattle: 2481 });
      expect(r.signal).toBe('inconclusive'); // dev 481 → borderline, not shiny
    });

    test('best-case shiny (delay ~2966ms, avg ~2000ms)', () => {
      // min shiny = max normal (2481) + min sparkle delay (~485ms from 29 frames minimum)
      // But more realistically: avg normal (2000) + sparkle (1300) = 3300
      const r = evaluateTimingSignal({ textDelayMs: 2966, ...calibrated, elapsedSinceBattle: 2966 });
      expect(r.signal).toBe('inconclusive'); // dev 966 → suspicious but not >1000
    });

    test('clear shiny (delay 3200ms, avg 2000ms) = shiny', () => {
      const r = evaluateTimingSignal({ textDelayMs: 3200, ...calibrated, elapsedSinceBattle: 3200 });
      expect(r.signal).toBe('shiny'); // dev 1200 > 1000
    });
  });
});

describe('makeShinyDecision', () => {
  test('normal timing = not shiny', () => {
    const { isShiny, signals } = makeShinyDecision({ timingSignal: 'normal' });
    expect(isShiny).toBe(false);
    expect(signals).toEqual([]);
  });

  test('shiny timing = shiny', () => {
    const { isShiny, signals } = makeShinyDecision({ timingSignal: 'shiny' });
    expect(isShiny).toBe(true);
    expect(signals).toEqual(['timing']);
  });

  test('inconclusive timing = not shiny', () => {
    const { isShiny, signals } = makeShinyDecision({ timingSignal: 'inconclusive' });
    expect(isShiny).toBe(false);
    expect(signals).toEqual([]);
  });
});
