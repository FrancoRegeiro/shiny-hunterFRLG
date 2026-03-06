import sharp from 'sharp';
import Tesseract from 'tesseract.js';
import { logger } from '../logger';
import { FRLG_POKEMON_NAMES } from './generated-palettes';

export interface BattleEnemyInfo {
  species: string | null;
  level: number | null;
  gender: 'male' | 'female' | 'unknown';
}

// All known Pokemon names
const ALL_POKEMON_NAMES = Object.values(FRLG_POKEMON_NAMES).map(n => n.toUpperCase());

// Text box region in FRLG battle (240x160): white text on dark blue-gray
const TEXT_BOX = { x: 8, y: 118, w: 224, h: 36 };

// Enemy info bar for level/gender
const INFO_BAR = { x: 12, y: 14, w: 120, h: 14 };

// Gender symbol scan region
const GENDER_REGION = { x: 10, y: 14, w: 120, h: 14 };

let worker: Tesseract.Worker | null = null;

async function getWorker(): Promise<Tesseract.Worker> {
  if (!worker) {
    worker = await Tesseract.createWorker('eng');
  }
  return worker;
}

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

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[m][n];
}

/**
 * Match OCR text to closest Pokemon name.
 * The text box OCR is quite reliable ("Wild CATERPIE appeared!"),
 * so we use a moderate threshold.
 */
function fuzzyMatchSpecies(ocrText: string): string | null {
  if (!ocrText || ocrText.length < 4) return null;
  const cleaned = ocrText.toUpperCase().replace(/[^A-Z]/g, '');
  if (cleaned.length < 4) return null;

  let bestName: string | null = null;
  let bestDist = Infinity;

  for (const name of ALL_POKEMON_NAMES) {
    const dist = levenshtein(cleaned, name);
    if (dist < bestDist) {
      bestDist = dist;
      bestName = name;
    }
  }

  // Accept if edit distance <= 40% of name length (text box OCR is reliable)
  if (bestName && bestDist <= Math.ceil(bestName.length * 0.4)) {
    return bestName.charAt(0) + bestName.slice(1).toLowerCase();
  }
  return null;
}

/**
 * Check if a battle frame shows the "Wild X appeared!" text.
 * Looks for white text pixels in the text box region.
 */
export async function hasWildAppearedText(frameBuffer: Buffer): Promise<boolean> {
  const { data, info } = await sharp(frameBuffer).raw().toBuffer({ resolveWithObject: true });
  const tb = TEXT_BOX;
  let whitePx = 0;
  let totalPx = 0;
  for (let py = tb.y; py < tb.y + tb.h && py < info.height; py++) {
    for (let px = tb.x; px < tb.x + tb.w && px < info.width; px++) {
      const idx = (py * info.width + px) * info.channels;
      totalPx++;
      if (data[idx] > 200 && data[idx + 1] > 200 && data[idx + 2] > 200) whitePx++;
    }
  }
  // "Wild X appeared!" has significant white text pixels
  // But not too many (screen flash would be all white)
  const ratio = totalPx > 0 ? whitePx / totalPx : 0;
  return ratio > 0.03 && ratio < 0.40;
}

/**
 * Extract enemy Pokemon info from a battle frame.
 *
 * Species: OCR the text box ("Wild CATERPIE appeared!" — white text on dark bg)
 * Level: OCR the info bar level region (separate digit-only pass)
 * Gender: Color scan for blue (♂) or red (♀) pixels in the info bar
 */
export async function extractBattleInfo(frameBuffer: Buffer): Promise<BattleEnemyInfo> {
  const result: BattleEnemyInfo = { species: null, level: null, gender: 'unknown' };

  try {
    const { data: rawData, info } = await sharp(frameBuffer).raw().toBuffer({ resolveWithObject: true });

    // === Gender detection via color analysis ===
    const g = GENDER_REGION;
    let blueCount = 0, redCount = 0;
    for (let py = g.y; py < g.y + g.h && py < info.height; py++) {
      for (let px = g.x; px < g.x + g.w && px < info.width; px++) {
        const idx = (py * info.width + px) * info.channels;
        const r = rawData[idx], gr = rawData[idx + 1], b = rawData[idx + 2];
        const hsl = rgbToHsl(r, gr, b);
        if (hsl.s < 0.3 || hsl.l < 0.15 || hsl.l > 0.85) continue;
        if (hsl.h >= 190 && hsl.h <= 260 && hsl.s > 0.4) blueCount++;
        if ((hsl.h >= 330 || hsl.h <= 20) && hsl.s > 0.4) redCount++;
      }
    }
    if (blueCount >= 3 && blueCount > redCount) result.gender = 'male';
    else if (redCount >= 3 && redCount > blueCount) result.gender = 'female';

    // === Species: OCR the text box (white text on dark background) ===
    const tb = TEXT_BOX;
    const textBoxImg = await sharp(frameBuffer)
      .extract({ left: tb.x, top: tb.y, width: tb.w, height: tb.h })
      .grayscale()
      .threshold(160) // white text > 160, dark bg < 160
      .resize(tb.w * 4, tb.h * 4, { kernel: 'nearest' })
      .png()
      .toBuffer();

    const tw = await getWorker();
    await tw.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .!',
    });
    const { data: { text: textBoxText } } = await tw.recognize(textBoxImg);
    const tbCleaned = textBoxText.trim().toUpperCase();

    logger.info(`[BattleInfo] TextBox OCR: "${tbCleaned}"`);

    // Parse "Wild CATERPIE appeared!" or "Wild CATERPIE appeared !"
    const wildMatch = tbCleaned.match(/WILD\s+([A-Z.]+)\s+APPEARED/i);
    if (wildMatch) {
      const rawName = wildMatch[1].replace(/\./g, '');
      // Try exact match first, then fuzzy
      if (ALL_POKEMON_NAMES.includes(rawName)) {
        result.species = rawName.charAt(0) + rawName.slice(1).toLowerCase();
      } else {
        result.species = fuzzyMatchSpecies(rawName);
      }
    } else if (tbCleaned.includes('WILD') || tbCleaned.includes('APPEARED') || tbCleaned.length >= 10) {
      // Fallback: only try word matching if text looks like a battle message
      // (contains WILD/APPEARED or is substantial). Prevents short fragments
      // like "MIL" from fuzzy-matching to short names like "MUK".
      const words = tbCleaned.split(/\s+/).filter((w: string) => w.length >= 3 && !/^(WILD|MILD|APPEARED|GO|THE|FOES?)$/i.test(w));
      for (const word of words) {
        const clean = word.replace(/[^A-Z]/g, '');
        if (ALL_POKEMON_NAMES.includes(clean)) {
          result.species = clean.charAt(0) + clean.slice(1).toLowerCase();
          break;
        }
        const match = fuzzyMatchSpecies(clean);
        if (match) { result.species = match; break; }
      }
    }

    // === Level: OCR the info bar level region (digits only) ===
    try {
      const ib = INFO_BAR;
      // Level text is in the right portion of the info bar (~last 40px)
      const lvRegion = await sharp(frameBuffer)
        .extract({ left: ib.x + 80, top: ib.y, width: 40, height: ib.h })
        .grayscale()
        .threshold(140)
        .resize(40 * 4, ib.h * 4, { kernel: 'nearest' })
        .png()
        .toBuffer();

      await tw.setParameters({
        tessedit_char_whitelist: '0123456789LlVv ',
      });
      const { data: { text: lvText } } = await tw.recognize(lvRegion);
      const digits = lvText.replace(/[^0-9]/g, '');
      if (digits.length > 0 && digits.length <= 3) {
        const level = parseInt(digits, 10);
        if (level >= 1 && level <= 100) result.level = level;
      }
    } catch {}

  } catch (err) {
    logger.debug(`[BattleInfo] Failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

export async function cleanupBattleInfoOcr(): Promise<void> {
  if (worker) {
    await worker.terminate();
    worker = null;
  }
}
