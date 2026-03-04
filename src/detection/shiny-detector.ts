import sharp from 'sharp';
import { DetectionResult, SpriteRegion, ColorSignature, HueRange } from '../types';
import { getPalette } from './color-palettes';
import { getSummarySpriteRegion } from './sprite-regions';
import { logger } from '../logger';

// Convert RGB to HSL
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255;
  g /= 255;
  b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
        break;
      case g:
        h = ((b - r) / d + 2) * 60;
        break;
      case b:
        h = ((r - g) / d + 4) * 60;
        break;
    }
  }

  return { h, s, l };
}

function hueInRange(hue: number, range: HueRange): boolean {
  if (range.min <= range.max) {
    return hue >= range.min && hue <= range.max;
  }
  // Wrapping range (e.g., 350-10 for red)
  return hue >= range.min || hue <= range.max;
}

function matchesSignature(h: number, s: number, l: number, sig: ColorSignature): boolean {
  if (s < sig.satMin || l < sig.valMin) return false;
  return sig.hueRanges.some((range) => hueInRange(h, range));
}

export async function detectShiny(
  frameBuffer: Buffer,
  pokemon: string,
  game: string
): Promise<DetectionResult> {
  const palette = getPalette(pokemon);
  if (!palette) {
    return {
      isShiny: false,
      confidence: 0,
      normalPixels: 0,
      shinyPixels: 0,
      totalSampled: 0,
      debugInfo: `No palette defined for ${pokemon}`,
    };
  }

  const region = getSummarySpriteRegion(game);
  return analyzeRegion(frameBuffer, region, palette);
}

async function analyzeRegion(
  frameBuffer: Buffer,
  region: SpriteRegion,
  palette: { normal: ColorSignature; shiny: ColorSignature }
): Promise<DetectionResult> {
  // Get image dimensions to validate region
  const metadata = await sharp(frameBuffer).metadata();
  const imgWidth = metadata.width || 240;
  const imgHeight = metadata.height || 160;

  // Clamp region to image bounds
  const x = Math.min(region.x, imgWidth - 1);
  const y = Math.min(region.y, imgHeight - 1);
  const w = Math.min(region.width, imgWidth - x);
  const h = Math.min(region.height, imgHeight - y);

  // Extract the sprite region's raw pixel data
  const { data } = await sharp(frameBuffer)
    .extract({ left: x, top: y, width: w, height: h })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let normalPixels = 0;
  let shinyPixels = 0;
  let totalSampled = 0;

  // Analyze every pixel in the region
  for (let i = 0; i < data.length; i += 3) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const { h, s, l } = rgbToHsl(r, g, b);

    // Skip near-black, near-white, and low-saturation pixels (background/outlines)
    if (l < 0.15 || l > 0.9 || s < 0.15) continue;

    totalSampled++;

    if (matchesSignature(h, s, l, palette.normal)) {
      normalPixels++;
    }
    if (matchesSignature(h, s, l, palette.shiny)) {
      shinyPixels++;
    }
  }

  // Determine if shiny based on pixel ratios
  const isShiny = shinyPixels > normalPixels && shinyPixels > totalSampled * 0.1;
  const confidence = totalSampled > 0
    ? Math.abs(shinyPixels - normalPixels) / totalSampled
    : 0;

  const result: DetectionResult = {
    isShiny,
    confidence,
    normalPixels,
    shinyPixels,
    totalSampled,
    debugInfo: `normal=${normalPixels} shiny=${shinyPixels} total=${totalSampled} ratio=${totalSampled > 0 ? (shinyPixels / totalSampled * 100).toFixed(1) : 0}%`,
  };

  logger.debug(
    `Detection: ${result.isShiny ? 'SHINY!' : 'normal'} — ${result.debugInfo}`
  );

  return result;
}
