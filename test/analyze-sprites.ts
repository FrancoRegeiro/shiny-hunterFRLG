import sharp from 'sharp';
import path from 'path';

const FIXTURES = path.join(__dirname, 'fixtures');

function rgbToHsl(r: number, g: number, b: number) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) * 60; break;
      case g: h = ((b - r) / d + 2) * 60; break;
      case b: h = ((r - g) / d + 4) * 60; break;
    }
  }
  return { h: Math.round(h), s: +s.toFixed(2), l: +l.toFixed(2) };
}

async function analyzeSprite(name: string, filepath: string) {
  const { data, info } = await sharp(filepath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const hueMap: Record<string, number> = {};

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a < 128) continue;
    const hsl = rgbToHsl(r, g, b);
    if (hsl.s < 0.15 || hsl.l < 0.15 || hsl.l > 0.9) continue;
    const bucket = Math.round(hsl.h / 5) * 5;
    hueMap[bucket] = (hueMap[bucket] || 0) + 1;
  }

  const sorted = Object.entries(hueMap).sort((a, b) => +b[1] - +a[1]);
  console.log('\n=== ' + name + ' ===');
  console.log('Hue distribution (top 8):');
  for (const [hue, count] of sorted.slice(0, 8)) {
    const bar = '#'.repeat(Math.min(count, 50));
    console.log(`  hue ${hue.toString().padStart(3)}°: ${count.toString().padStart(4)} px  ${bar}`);
  }
}

async function main() {
  await analyzeSprite('Normal Charmander', path.join(FIXTURES, 'normal-charmander-sprite-frlg.png'));
  await analyzeSprite('Shiny Charmander', path.join(FIXTURES, 'shiny-charmander-sprite-frlg.png'));
  await analyzeSprite('Normal Squirtle', path.join(FIXTURES, 'normal-squirtle-sprite-frlg.png'));
  await analyzeSprite('Shiny Squirtle', path.join(FIXTURES, 'shiny-squirtle-sprite-frlg.png'));
  await analyzeSprite('Normal Bulbasaur', path.join(FIXTURES, 'normal-bulbasaur-sprite-frlg.png'));
  await analyzeSprite('Shiny Bulbasaur', path.join(FIXTURES, 'shiny-bulbasaur-sprite-frlg.png'));
}

main().catch(console.error);
