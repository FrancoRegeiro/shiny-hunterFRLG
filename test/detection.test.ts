import sharp from 'sharp';
import path from 'path';
import { detectShiny } from '../src/detection/shiny-detector';

const FIXTURES = path.join(__dirname, 'fixtures');

function simulateEngineDecision(result: Awaited<ReturnType<typeof detectShiny>>): 'SHINY_FOUND' | 'RESET' {
  if (result.isShiny && result.totalSampled < 50) return 'RESET';
  if (result.isShiny) return 'SHINY_FOUND';
  return 'RESET';
}

describe.each(['charmander', 'squirtle', 'bulbasaur'])('Shiny detection: %s', (pokemon) => {
  test('normal is NOT shiny', async () => {
    const frame = await sharp(path.join(FIXTURES, `normal-${pokemon}-summary.png`)).toBuffer();
    const result = await detectShiny(frame, pokemon, 'fire-red');

    expect(result.isShiny).toBe(false);
    expect(result.debugInfo).toContain('border=normal(purple)');
    expect(result.totalSampled).toBeGreaterThan(50);
    expect(result.debugInfo).not.toBe('not on summary screen');
    expect(simulateEngineDecision(result)).toBe('RESET');
  });

  test('shiny IS shiny', async () => {
    const frame = await sharp(path.join(FIXTURES, `shiny-${pokemon}-summary.png`)).toBuffer();
    const result = await detectShiny(frame, pokemon, 'fire-red');

    expect(result.isShiny).toBe(true);
    expect(result.debugInfo).toContain('border=SHINY(teal)');
    expect(result.totalSampled).toBeGreaterThan(50);
    expect(result.debugInfo).not.toBe('not on summary screen');
    expect(simulateEngineDecision(result)).toBe('SHINY_FOUND');
  });
});

describe('Screen rejection', () => {
  test('naming screen is not shiny', async () => {
    const frame = await sharp(path.join(FIXTURES, 'naming-screen.png')).toBuffer();
    const result = await detectShiny(frame, 'charmander', 'fire-red');

    expect(result.isShiny).toBe(false);
    expect(result.debugInfo).toBe('not on summary screen');
    expect(simulateEngineDecision(result)).toBe('RESET');
  });

  test('overworld is not shiny', async () => {
    const frame = await sharp(path.join(FIXTURES, 'overworld.png')).toBuffer();
    const result = await detectShiny(frame, 'charmander', 'fire-red');

    expect(result.isShiny).toBe(false);
    expect(result.debugInfo).toBe('not on summary screen');
    expect(simulateEngineDecision(result)).toBe('RESET');
  });
});
