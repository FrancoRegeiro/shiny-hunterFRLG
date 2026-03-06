import sharp from 'sharp';
import { PokemonPalette, ColorSignature, HueRange } from '../types';
import { FRLG_PALETTES, FRLG_POKEMON_NAMES } from './generated-palettes';
import { logger } from '../logger';

/**
 * Battle sprite palette analysis for shiny detection and species identification.
 *
 * Enemy Pokemon sprite region in FRLG battle (240x160 after trim+resize):
 *   x: 144-208, y: 24-72 (64x48 area)
 *
 * Strategy:
 * 1. Extract hue distribution from enemy sprite region
 * 2. Match against all known Pokemon palettes (normal + shiny)
 * 3. If best match is a shiny palette → shiny!
 * 4. Species = the Pokemon whose palette matches best
 */

// Enemy sprite region in the 240x160 battle frame
const ENEMY_SPRITE = { x: 144, y: 24, w: 64, h: 48 };

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
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
  return { h, s, l };
}

function hueInRange(hue: number, range: HueRange): boolean {
  if (range.min <= range.max) {
    return hue >= range.min && hue <= range.max;
  }
  return hue >= range.min || hue <= range.max;
}

function matchSignature(h: number, s: number, l: number, sig: ColorSignature): boolean {
  if (s < sig.satMin || l < sig.valMin) return false;
  return sig.hueRanges.some(range => hueInRange(h, range));
}

export interface BattlePaletteResult {
  species: string | null;
  speciesId: number | null;
  isShiny: boolean;
  confidence: number;
  normalScore: number;
  shinyScore: number;
  debugInfo: string;
}

/**
 * Analyze the enemy sprite region in a battle frame.
 * Matches the sprite's color distribution against all known FRLG palettes.
 */
export async function analyzeBattlePalette(frameBuffer: Buffer): Promise<BattlePaletteResult> {
  const { data, info } = await sharp(frameBuffer).raw().toBuffer({ resolveWithObject: true });

  // Extract hue distribution from enemy sprite region.
  // First pass: identify the dominant background hue (usually green grass or blue sky).
  // Second pass: filter out background pixels for cleaner sprite analysis.
  const region = ENEMY_SPRITE;
  const allHues: number[] = [];

  for (let py = region.y; py < region.y + region.h && py < info.height; py++) {
    for (let px = region.x; px < region.x + region.w && px < info.width; px++) {
      const idx = (py * info.width + px) * info.channels;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      const hsl = rgbToHsl(r, g, b);
      if (hsl.l < 0.12 || hsl.l > 0.90 || hsl.s < 0.10) continue;
      allHues.push(hsl.h);
    }
  }

  // Identify dominant background hue from edges (top-right and bottom of sprite region)
  const edgeHues: number[] = [];
  // Top row of region (usually sky/grass background, not sprite)
  for (let px = region.x; px < region.x + region.w && px < info.width; px++) {
    const idx = (region.y * info.width + px) * info.channels;
    const r = data[idx], g = data[idx + 1], b = data[idx + 2];
    const hsl = rgbToHsl(r, g, b);
    if (hsl.l >= 0.12 && hsl.l <= 0.90 && hsl.s >= 0.10) edgeHues.push(hsl.h);
  }
  // Bottom row
  const bottomY = Math.min(region.y + region.h - 1, info.height - 1);
  for (let px = region.x; px < region.x + region.w && px < info.width; px++) {
    const idx = (bottomY * info.width + px) * info.channels;
    const r = data[idx], g = data[idx + 1], b = data[idx + 2];
    const hsl = rgbToHsl(r, g, b);
    if (hsl.l >= 0.12 && hsl.l <= 0.90 && hsl.s >= 0.10) edgeHues.push(hsl.h);
  }

  // Find dominant edge hue bin (10-degree bins)
  const edgeBins = new Array(36).fill(0);
  for (const h of edgeHues) edgeBins[Math.floor(h / 10) % 36]++;
  let bgBin = 0;
  let bgCount = 0;
  for (let i = 0; i < 36; i++) {
    if (edgeBins[i] > bgCount) { bgBin = i; bgCount = edgeBins[i]; }
  }

  // Filter: exclude pixels within ±20° of dominant background hue
  const bgHueCenter = bgBin * 10 + 5;
  const hues = allHues.filter(h => {
    const diff = Math.min(Math.abs(h - bgHueCenter), 360 - Math.abs(h - bgHueCenter));
    return diff > 20;
  });

  if (hues.length < 20) {
    return {
      species: null, speciesId: null, isShiny: false,
      confidence: 0, normalScore: 0, shinyScore: 0,
      debugInfo: `too few chromatic pixels (${hues.length})`,
    };
  }

  // Build 10-degree hue bins for the sprite region
  const spriteBins = new Array(36).fill(0);
  for (const h of hues) {
    spriteBins[Math.floor(h / 10) % 36]++;
  }

  // Score each Pokemon palette (normal and shiny) against sprite
  let bestMatch: { name: string; id: number; isShiny: boolean; score: number } | null = null;
  let bestNormal: { name: string; score: number } | null = null;
  let bestShiny: { name: string; score: number } | null = null;

  for (const [name, palette] of Object.entries(FRLG_PALETTES)) {
    const normalScore = scorePalette(spriteBins, hues.length, palette.normal);
    const shinyScore = scorePalette(spriteBins, hues.length, palette.shiny);

    if (!bestNormal || normalScore > bestNormal.score) {
      bestNormal = { name, score: normalScore };
    }
    if (!bestShiny || shinyScore > bestShiny.score) {
      bestShiny = { name, score: shinyScore };
    }

    const bestForThis = normalScore >= shinyScore
      ? { name, id: palette.id, isShiny: false, score: normalScore }
      : { name, id: palette.id, isShiny: true, score: shinyScore };

    if (!bestMatch || bestForThis.score > bestMatch.score) {
      bestMatch = bestForThis;
    }
  }

  if (!bestMatch || bestMatch.score < 0.1) {
    return {
      species: null, speciesId: null, isShiny: false,
      confidence: 0, normalScore: 0, shinyScore: 0,
      debugInfo: `no palette match (best=${bestMatch?.name}@${bestMatch?.score.toFixed(2)})`,
    };
  }

  // For the matched species, get both normal and shiny scores
  const matchedPalette = FRLG_PALETTES[bestMatch.name];
  const normalScore = scorePalette(spriteBins, hues.length, matchedPalette.normal);
  const shinyScore = scorePalette(spriteBins, hues.length, matchedPalette.shiny);

  // Shiny if shiny palette matches significantly better than normal
  // Require strong shiny signal — battle background colors create noise
  const isShiny = shinyScore > normalScore * 1.5 && shinyScore > 0.3 && (shinyScore - normalScore) > 0.15;

  const confidence = Math.abs(shinyScore - normalScore) / Math.max(shinyScore, normalScore, 0.01);

  return {
    species: bestMatch.name,
    speciesId: bestMatch.id,
    isShiny,
    confidence,
    normalScore,
    shinyScore,
    debugInfo: `palette=${bestMatch.name} normal=${normalScore.toFixed(2)} shiny=${shinyScore.toFixed(2)} px=${hues.length}`,
  };
}

/**
 * Given a specific species name, check if the battle sprite looks like its shiny form.
 * More accurate than analyzeBattlePalette when we already know the species.
 */
export async function checkShinyByPalette(
  frameBuffer: Buffer,
  species: string,
): Promise<{ isShiny: boolean; confidence: number; normalScore: number; shinyScore: number; debugInfo: string }> {
  const palette = FRLG_PALETTES[species.toLowerCase()];
  if (!palette) {
    return { isShiny: false, confidence: 0, normalScore: 0, shinyScore: 0, debugInfo: `unknown species: ${species}` };
  }

  const { data, info } = await sharp(frameBuffer).raw().toBuffer({ resolveWithObject: true });
  const region = ENEMY_SPRITE;
  const hues: number[] = [];

  for (let py = region.y; py < region.y + region.h && py < info.height; py++) {
    for (let px = region.x; px < region.x + region.w && px < info.width; px++) {
      const idx = (py * info.width + px) * info.channels;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      const hsl = rgbToHsl(r, g, b);
      if (hsl.l < 0.12 || hsl.l > 0.90 || hsl.s < 0.10) continue;
      hues.push(hsl.h);
    }
  }

  if (hues.length < 20) {
    return { isShiny: false, confidence: 0, normalScore: 0, shinyScore: 0, debugInfo: `too few pixels (${hues.length})` };
  }

  const spriteBins = new Array(36).fill(0);
  for (const h of hues) {
    spriteBins[Math.floor(h / 10) % 36]++;
  }

  const normalScore = scorePalette(spriteBins, hues.length, palette.normal);
  const shinyScore = scorePalette(spriteBins, hues.length, palette.shiny);

  // Require strong shiny signal — battle background colors create noise
  const isShiny = shinyScore > normalScore * 1.5 && shinyScore > 0.3 && (shinyScore - normalScore) > 0.15;
  const confidence = Math.abs(shinyScore - normalScore) / Math.max(shinyScore, normalScore, 0.01);

  return {
    isShiny,
    confidence,
    normalScore,
    shinyScore,
    debugInfo: `${species} normal=${normalScore.toFixed(2)} shiny=${shinyScore.toFixed(2)} px=${hues.length}`,
  };
}

/**
 * Score how well a sprite's hue distribution matches a palette signature.
 * Returns 0-1 where 1 = perfect match.
 */
function scorePalette(spriteBins: number[], totalPixels: number, sig: ColorSignature): number {
  if (sig.hueRanges.length === 0 || totalPixels === 0) return 0;

  // Count pixels that fall within the palette's hue ranges
  let matchingPixels = 0;
  for (let bin = 0; bin < 36; bin++) {
    const hueCenter = bin * 10 + 5;
    for (const range of sig.hueRanges) {
      if (hueInRange(hueCenter, range)) {
        matchingPixels += spriteBins[bin];
        break;
      }
    }
  }

  return matchingPixels / totalPixels;
}
