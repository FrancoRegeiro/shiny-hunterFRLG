import sharp from 'sharp';
import Tesseract from 'tesseract.js';

export interface SummaryInfo {
  nature: string | null;
  gender: 'male' | 'female' | 'unknown';
  tid: number | null;
}

const NATURES = [
  'HARDY', 'LONELY', 'BRAVE', 'ADAMANT', 'NAUGHTY',
  'BOLD', 'DOCILE', 'RELAXED', 'IMPISH', 'LAX',
  'TIMID', 'HASTY', 'SERIOUS', 'JOLLY', 'NAIVE',
  'MODEST', 'MILD', 'QUIET', 'BASHFUL', 'RASH',
  'CALM', 'GENTLE', 'SASSY', 'CAREFUL', 'QUIRKY',
];

const SPANISH_NATURE_TO_ENGLISH: Record<string, string> = {
  // con acento
  'HURAÑA': 'Lonely',
  'PÍCARA': 'Naughty',
  'DÓCIL': 'Docile',
  'PLÁCIDA': 'Relaxed',
  'PÍCARESCA': 'Quirky',

  // sin acento (por si OCR las saca)
  'HURANA': 'Lonely',
  'PICARA': 'Naughty',
  'DOCIL': 'Docile',
  'PLACIDA': 'Relaxed',
  'PICARESCA': 'Quirky',

  'FUERTE': 'Hardy',
  'AUDAZ': 'Brave',
  'FIRME': 'Adamant',
  'OSADA': 'Bold',
  'AGITADA': 'Impish',
  'FLOJA': 'Lax',
  'MIEDOSA': 'Timid',
  'ACTIVA': 'Hasty',
  'SERIA': 'Serious',
  'ALEGRE': 'Jolly',
  'INGENUA': 'Naive',
  'MODESTA': 'Modest',
  'AFABLE': 'Mild',
  'MANSA': 'Quiet',
  'RARA': 'Bashful',
  'ALOCA': 'Rash',
  'SERENA': 'Calm',
  'AMABLE': 'Gentle',
  'GROSERA': 'Sassy',
  'CAUTA': 'Careful',
};

// Valid nature names in title case (as returned by extractNature)
const VALID_NATURES = new Set(NATURES.map(n => n.charAt(0) + n.slice(1).toLowerCase()));

// === Nature pixel pattern cache (self-learning) ===
// After Tesseract identifies a nature, we cache the binary pixel pattern.
// Future encounters with the same nature skip Tesseract entirely (~0.5s saved).
// After all 25 natures are cached, Tesseract is never called for nature again.
const naturePixelCache = new Map<string, string>();
const NATURE_BIN_REGION = { x: 4, y: 114, w: 100, h: 14 };

function extractNatureBinary(rawData: Buffer, width: number, height: number, channels: number): string {
  const { x, y, w, h } = NATURE_BIN_REGION;
  let binary = '';
  for (let py = y; py < y + h && py < height; py++) {
    for (let px = x; px < x + w && px < width; px++) {
      const idx = (py * width + px) * channels;
      const gray = 0.299 * rawData[idx] + 0.587 * rawData[idx + 1] + 0.114 * rawData[idx + 2];
      binary += gray < 168 ? '1' : '0';
    }
  }
  return binary;
}

function hammingDist(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

function matchNaturePixels(binary: string): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const [pat, name] of naturePixelCache) {
    const d = hammingDist(binary, pat);
    if (d < bestDist) { bestDist = d; best = name; }
  }
  // Allow up to 5% pixel difference for capture card noise
  return bestDist <= Math.floor(binary.length * 0.05) ? best : null;
}

// Fire Red summary screen (240x160 native):
// - Gender symbol: after Pokemon name, ~x=105-125, y=16-26. Male=blue, Female=red
// - Nature text: "XXX nature." in trainer memo, ~y=128-142, x=8-120
const GENDER_REGION = { x: 100, y: 14, w: 30, h: 14 };
const NATURE_REGION = { x: 4, y: 114, w: 130, h: 16 };
// "IDNo." label is on the left, the 5-digit TID number is on the right
// On FRLG summary screen (240x160): IDNo value at roughly x=168, y=78, w=60, h=12
const TID_REGION = { x: 158, y: 80, w: 75, h: 12 };

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

export async function extractGender(rawData: Buffer, info: { width: number; height: number; channels: number }): Promise<'male' | 'female' | 'unknown'> {
  // Scan the gender symbol region for blue (♂) or red (♀) pixels
  let blueCount = 0;
  let redCount = 0;

  const { x, y, w, h } = GENDER_REGION;
  for (let py = y; py < y + h && py < info.height; py++) {
    for (let px = x; px < x + w && px < info.width; px++) {
      const idx = (py * info.width + px) * info.channels;
      const r = rawData[idx], g = rawData[idx + 1], b = rawData[idx + 2];
      const hsl = rgbToHsl(r, g, b);

      // Skip low saturation (background/text)
      if (hsl.s < 0.3 || hsl.l < 0.15 || hsl.l > 0.85) continue;

      // Blue hue range for ♂ symbol (roughly 200-250)
      if (hsl.h >= 190 && hsl.h <= 260 && hsl.s > 0.4) blueCount++;
      // Red/pink hue range for ♀ symbol (roughly 330-20)
      if ((hsl.h >= 330 || hsl.h <= 20) && hsl.s > 0.4) redCount++;
    }
  }

  // Need at least a few pixels to be confident
  if (blueCount >= 5 && blueCount > redCount) return 'male';
  if (redCount >= 5 && redCount > blueCount) return 'female';
  return 'unknown';
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

let worker: Tesseract.Worker | null = null;

async function getWorker(): Promise<Tesseract.Worker> {
  if (!worker) {
    worker = await Tesseract.createWorker('eng');
    await worker.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzÁÉÍÓÚáéíóúÑñ .',
    });
  }
  return worker;
}

export async function extractNature(frameBuffer: Buffer): Promise<string | null> {
  try {
    // Crop the nature text region and upscale for better OCR
    const cropped = await sharp(frameBuffer)
      .extract({ left: NATURE_REGION.x, top: NATURE_REGION.y, width: NATURE_REGION.w, height: NATURE_REGION.h })
      .resize(NATURE_REGION.w * 4, NATURE_REGION.h * 4, { kernel: 'nearest' })
      .sharpen()
      .png()
      .toBuffer();

    const w = await getWorker();
    const { data: { text } } = await w.recognize(cropped);

    // Match against known natures
    const cleaned = text.toUpperCase().trim();

    // 1) Spanish -> English mapping first
    for (const [spanishNature, englishNature] of Object.entries(SPANISH_NATURE_TO_ENGLISH)) {
      if (cleaned.includes(spanishNature)) {
        return englishNature;
      }
    }

    // 2) Exact English match
    for (const nature of NATURES) {
      if (cleaned.includes(nature)) {
        return nature.charAt(0) + nature.slice(1).toLowerCase();
      }
    }

    // Fuzzy match: extract word before "NATURE" or "NATURALEZA" and map to English
    const beforeNature = cleaned.match(/(\w+)\s*(NATURE|NATURALEZA)/);
    if (beforeNature) {
      const candidate = beforeNature[1];
      let bestEnglishMatch = '';
      let bestEnglishDist = Infinity;

      for (const nature of NATURES) {
        const dist = levenshtein(candidate, nature);
        if (dist < bestEnglishDist) {
          bestEnglishDist = dist;
          bestEnglishMatch = nature;
        }
      }

      let bestSpanishMatch = '';
      let bestSpanishDist = Infinity;

      for (const spanishNature of Object.keys(SPANISH_NATURE_TO_ENGLISH)) {
        const dist = levenshtein(candidate, spanishNature);
        if (dist < bestSpanishDist) {
          bestSpanishDist = dist;
          bestSpanishMatch = spanishNature;
        }
      }

      // Prefer the closest between English and Spanish
      if (bestEnglishDist <= bestSpanishDist && bestEnglishDist <= 2) {
        return bestEnglishMatch.charAt(0) + bestEnglishMatch.slice(1).toLowerCase();
      }

      if (bestSpanishDist < bestEnglishDist && bestSpanishDist <= 2) {
        return SPANISH_NATURE_TO_ENGLISH[bestSpanishMatch];
      }
    }

    // Fallback: return raw text for debugging
    return text.trim() || null;
  } catch {
    return null;
  }
}

// TID region: exclude the colored icon on the left, just the digits
const TID_DIGITS_REGION = { x: 163, y: 79, w: 70, h: 14 };

export async function extractTID(frameBuffer: Buffer): Promise<number | null> {
  try {
    // Grayscale + high contrast makes the GBA pixel font readable by Tesseract
    const cropped = await sharp(frameBuffer)
      .extract({ left: TID_DIGITS_REGION.x, top: TID_DIGITS_REGION.y, width: TID_DIGITS_REGION.w, height: TID_DIGITS_REGION.h })
      .grayscale()
      .linear(2.5, -200) // boost contrast: darken text, brighten bg
      .resize(TID_DIGITS_REGION.w * 8, TID_DIGITS_REGION.h * 8, { kernel: 'nearest' })
      .png()
      .toBuffer();

    const w = await getWorker();
    await w.setParameters({
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: '7' as any, // single text line
    });
    const { data: { text } } = await w.recognize(cropped);
    // Restore default parameters
    await w.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzÁÉÍÓÚáéíóúÑñ .',
      tessedit_pageseg_mode: '3' as any,
    });

    const digits = text.trim().replace(/\D/g, '');
    if (digits.length >= 4 && digits.length <= 5) {
      const tid = parseInt(digits, 10);
      if (tid >= 0 && tid <= 65535) return tid;
    }
    return null;
  } catch {
    return null;
  }
}

export async function extractSummaryInfo(
  frameBuffer: Buffer,
  opts?: { skipTID?: boolean },
): Promise<SummaryInfo> {
  const { data: rawData, info } = await sharp(frameBuffer).raw().toBuffer({ resolveWithObject: true });

  const gender = await extractGender(rawData, info);

  // Nature detection — Tesseract is reliable, pixel cache was causing misidentifications
  // TODO: pixel cache needs validation (e.g. require 2 Tesseract confirmations before caching)
  const nature = await extractNature(frameBuffer);

  // Skip TID extraction when already known (saves ~0.3-0.5s per encounter)
  const tid = opts?.skipTID ? null : await extractTID(frameBuffer);

  return { nature, gender, tid };
}

export async function cleanupOcr(): Promise<void> {
  if (worker) {
    await worker.terminate();
    worker = null;
  }
}
