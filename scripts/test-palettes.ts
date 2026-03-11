/**
 * Comprehensive palette detection accuracy test.
 *
 * For each of the 151 Gen 1 Pokemon:
 *   1. Feed the NORMAL sprite → should score normalScore > shinyScore
 *   2. Feed the SHINY sprite  → should score shinyScore > normalScore (and pass the 1.5x threshold)
 *   3. Feed the NORMAL sprite to species-blind detection → should identify the correct species
 *
 * Reports accuracy, false positives/negatives, and the hardest-to-distinguish Pokemon.
 *
 * Usage: npx ts-node scripts/test-palettes.ts
 */

import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

// ── Inline the scoring logic from battle-palette.ts so we can test raw sprites ──

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

function hueInRange(hue: number, range: { min: number; max: number }): boolean {
  if (range.min <= range.max) return hue >= range.min && hue <= range.max;
  return hue >= range.min || hue <= range.max;
}

interface ColorSignature {
  hueRanges: { min: number; max: number }[];
  satMin: number;
  valMin: number;
}

function scorePalette(spriteBins: number[], totalPixels: number, sig: ColorSignature): number {
  if (sig.hueRanges.length === 0 || totalPixels === 0) return 0;
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

/** Extract hue bins from a raw sprite PNG (no background filtering needed — sprites have transparency). */
async function extractSpriteBins(spritePath: string): Promise<{ bins: number[]; total: number; hues: number[] }> {
  const buf = fs.readFileSync(spritePath);
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const bins = new Array(36).fill(0);
  const hues: number[] = [];
  let total = 0;

  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a < 128) continue; // skip transparent
    const hsl = rgbToHsl(r, g, b);
    if (hsl.l < 0.12 || hsl.l > 0.92) continue; // skip near-black/white
    if (hsl.s < 0.10) continue; // skip grays
    bins[Math.floor(hsl.h / 10) % 36]++;
    hues.push(hsl.h);
    total++;
  }

  return { bins, total, hues };
}

// ── Pokemon data ──

const POKEMON_NAMES: Record<number, string> = {
  1: 'bulbasaur', 2: 'ivysaur', 3: 'venusaur',
  4: 'charmander', 5: 'charmeleon', 6: 'charizard',
  7: 'squirtle', 8: 'wartortle', 9: 'blastoise',
  10: 'caterpie', 11: 'metapod', 12: 'butterfree',
  13: 'weedle', 14: 'kakuna', 15: 'beedrill',
  16: 'pidgey', 17: 'pidgeotto', 18: 'pidgeot',
  19: 'rattata', 20: 'raticate',
  21: 'spearow', 22: 'fearow',
  23: 'ekans', 24: 'arbok',
  25: 'pikachu', 26: 'raichu',
  27: 'sandshrew', 28: 'sandslash',
  29: 'nidoranf', 30: 'nidorina', 31: 'nidoqueen',
  32: 'nidoranm', 33: 'nidorino', 34: 'nidoking',
  35: 'clefairy', 36: 'clefable',
  37: 'vulpix', 38: 'ninetales',
  39: 'jigglypuff', 40: 'wigglytuff',
  41: 'zubat', 42: 'golbat',
  43: 'oddish', 44: 'gloom', 45: 'vileplume',
  46: 'paras', 47: 'parasect',
  48: 'venonat', 49: 'venomoth',
  50: 'diglett', 51: 'dugtrio',
  52: 'meowth', 53: 'persian',
  54: 'psyduck', 55: 'golduck',
  56: 'mankey', 57: 'primeape',
  58: 'growlithe', 59: 'arcanine',
  60: 'poliwag', 61: 'poliwhirl', 62: 'poliwrath',
  63: 'abra', 64: 'kadabra', 65: 'alakazam',
  66: 'machop', 67: 'machoke', 68: 'machamp',
  69: 'bellsprout', 70: 'weepinbell', 71: 'victreebel',
  72: 'tentacool', 73: 'tentacruel',
  74: 'geodude', 75: 'graveler', 76: 'golem',
  77: 'ponyta', 78: 'rapidash',
  79: 'slowpoke', 80: 'slowbro',
  81: 'magnemite', 82: 'magneton',
  83: 'farfetchd', 84: 'doduo', 85: 'dodrio',
  86: 'seel', 87: 'dewgong',
  88: 'grimer', 89: 'muk',
  90: 'shellder', 91: 'cloyster',
  92: 'gastly', 93: 'haunter', 94: 'gengar',
  95: 'onix',
  96: 'drowzee', 97: 'hypno',
  98: 'krabby', 99: 'kingler',
  100: 'voltorb', 101: 'electrode',
  102: 'exeggcute', 103: 'exeggutor',
  104: 'cubone', 105: 'marowak',
  106: 'hitmonlee', 107: 'hitmonchan',
  108: 'lickitung',
  109: 'koffing', 110: 'weezing',
  111: 'rhyhorn', 112: 'rhydon',
  113: 'chansey',
  114: 'tangela',
  115: 'kangaskhan',
  116: 'horsea', 117: 'seadra',
  118: 'goldeen', 119: 'seaking',
  120: 'staryu', 121: 'starmie',
  122: 'mrmime',
  123: 'scyther',
  124: 'jynx',
  125: 'electabuzz',
  126: 'magmar',
  127: 'pinsir',
  128: 'tauros',
  129: 'magikarp', 130: 'gyarados',
  131: 'lapras',
  132: 'ditto',
  133: 'eevee', 134: 'vaporeon', 135: 'jolteon', 136: 'flareon',
  137: 'porygon',
  138: 'omanyte', 139: 'omastar',
  140: 'kabuto', 141: 'kabutops',
  142: 'aerodactyl',
  143: 'snorlax',
  144: 'articuno', 145: 'zapdos', 146: 'moltres',
  147: 'dratini', 148: 'dragonair', 149: 'dragonite',
  150: 'mewtwo', 151: 'mew',
};

// ── Import generated palettes ──
// We'll load the compiled JS since we're running via ts-node
import { FRLG_PALETTES } from '../src/detection/generated-palettes';

interface TestResult {
  id: number;
  name: string;
  hasPalette: boolean;
  // When we know the species and feed it the normal sprite:
  normalCorrect: boolean;      // normalScore > shinyScore → correctly identified as normal
  normalNormalScore: number;
  normalShinyScore: number;
  normalMargin: number;         // normalScore - shinyScore (positive = correct)
  // When we know the species and feed it the shiny sprite:
  shinyDetected: boolean;       // passes the 1.5x threshold → correctly identified as shiny
  shinyNormalScore: number;
  shinyShinyScore: number;
  shinyMargin: number;          // shinyScore - normalScore (positive = correct direction)
  shinyPassThreshold: boolean;  // shinyScore > normalScore * 1.5 && shinyScore > 0.3 && diff > 0.15
  // Species identification (blind): feed normal sprite, does best-match = this species?
  speciesCorrect: boolean;
  speciesGuess: string;
  // Pixel counts
  normalPixels: number;
  shinyPixels: number;
}

async function main() {
  const spriteDir = path.join(__dirname, '..', 'data', 'sprites');
  const results: TestResult[] = [];

  const allPaletteEntries = Object.entries(FRLG_PALETTES);

  for (const [idStr, name] of Object.entries(POKEMON_NAMES)) {
    const id = parseInt(idStr);
    if (id > 151) continue; // Gen 1 only

    const normalPath = path.join(spriteDir, 'normal', `${id}.png`);
    const shinyPath = path.join(spriteDir, 'shiny', `${id}.png`);

    if (!fs.existsSync(normalPath) || !fs.existsSync(shinyPath)) {
      continue;
    }

    const palette = FRLG_PALETTES[name];
    if (!palette) {
      results.push({
        id, name, hasPalette: false,
        normalCorrect: false, normalNormalScore: 0, normalShinyScore: 0, normalMargin: 0,
        shinyDetected: false, shinyNormalScore: 0, shinyShinyScore: 0, shinyMargin: 0, shinyPassThreshold: false,
        speciesCorrect: false, speciesGuess: 'N/A',
        normalPixels: 0, shinyPixels: 0,
      });
      continue;
    }

    // Extract bins from actual sprites
    const normalData = await extractSpriteBins(normalPath);
    const shinyData = await extractSpriteBins(shinyPath);

    // Test 1: Known species, normal sprite → should score normalScore > shinyScore
    const normalNormalScore = scorePalette(normalData.bins, normalData.total, palette.normal);
    const normalShinyScore = scorePalette(normalData.bins, normalData.total, palette.shiny);

    // Test 2: Known species, shiny sprite → should score shinyScore > normalScore * 1.5
    const shinyNormalScore = scorePalette(shinyData.bins, shinyData.total, palette.normal);
    const shinyShinyScore = scorePalette(shinyData.bins, shinyData.total, palette.shiny);

    const shinyPassThreshold = shinyShinyScore > shinyNormalScore * 1.5
      && shinyShinyScore > 0.3
      && (shinyShinyScore - shinyNormalScore) > 0.15;

    // Test 3: Species identification (blind) — feed normal sprite, find best matching palette
    let bestSpecies = '';
    let bestScore = 0;
    for (const [pName, pPalette] of allPaletteEntries) {
      const ns = scorePalette(normalData.bins, normalData.total, pPalette.normal);
      const ss = scorePalette(normalData.bins, normalData.total, pPalette.shiny);
      const best = Math.max(ns, ss);
      if (best > bestScore) {
        bestScore = best;
        bestSpecies = pName;
      }
    }

    results.push({
      id, name, hasPalette: true,
      normalCorrect: normalNormalScore >= normalShinyScore,
      normalNormalScore, normalShinyScore,
      normalMargin: normalNormalScore - normalShinyScore,
      shinyDetected: shinyShinyScore > shinyNormalScore,
      shinyNormalScore, shinyShinyScore,
      shinyMargin: shinyShinyScore - shinyNormalScore,
      shinyPassThreshold,
      speciesCorrect: bestSpecies === name,
      speciesGuess: bestSpecies,
      normalPixels: normalData.total,
      shinyPixels: shinyData.total,
    });
  }

  // ── Report ──

  const withPalette = results.filter(r => r.hasPalette);
  const noPalette = results.filter(r => !r.hasPalette);

  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║          PALETTE DETECTION ACCURACY TEST — Gen 1 (151 Pokemon)       ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log(`\nPokemon with palettes: ${withPalette.length} / ${results.length}`);
  if (noPalette.length > 0) {
    console.log(`Missing palettes: ${noPalette.map(r => r.name).join(', ')}`);
  }

  // Test 1: Normal identification
  const normalCorrect = withPalette.filter(r => r.normalCorrect);
  console.log(`\n━━━ TEST 1: Normal sprite → correctly identified as NORMAL ━━━`);
  console.log(`Accuracy: ${normalCorrect.length}/${withPalette.length} (${(normalCorrect.length/withPalette.length*100).toFixed(1)}%)`);

  const normalFails = withPalette.filter(r => !r.normalCorrect).sort((a, b) => a.normalMargin - b.normalMargin);
  if (normalFails.length > 0) {
    console.log(`\n  FALSE POSITIVES (normal sprite scored as shiny):`);
    for (const r of normalFails) {
      console.log(`    #${r.id} ${r.name.padEnd(12)} normalScore=${r.normalNormalScore.toFixed(3)} shinyScore=${r.normalShinyScore.toFixed(3)} margin=${r.normalMargin.toFixed(3)}`);
    }
  }

  // Test 2: Shiny detection
  const shinyDirectionCorrect = withPalette.filter(r => r.shinyDetected);
  const shinyThresholdPass = withPalette.filter(r => r.shinyPassThreshold);
  console.log(`\n━━━ TEST 2: Shiny sprite → correctly identified as SHINY ━━━`);
  console.log(`Direction correct (shinyScore > normalScore): ${shinyDirectionCorrect.length}/${withPalette.length} (${(shinyDirectionCorrect.length/withPalette.length*100).toFixed(1)}%)`);
  console.log(`Threshold pass (1.5x + 0.3 + 0.15 diff):     ${shinyThresholdPass.length}/${withPalette.length} (${(shinyThresholdPass.length/withPalette.length*100).toFixed(1)}%)`);

  const shinyFails = withPalette.filter(r => !r.shinyDetected).sort((a, b) => a.shinyMargin - b.shinyMargin);
  if (shinyFails.length > 0) {
    console.log(`\n  FALSE NEGATIVES (shiny sprite NOT detected — wrong direction):`);
    for (const r of shinyFails) {
      console.log(`    #${r.id} ${r.name.padEnd(12)} normalScore=${r.shinyNormalScore.toFixed(3)} shinyScore=${r.shinyShinyScore.toFixed(3)} margin=${r.shinyMargin.toFixed(3)}`);
    }
  }

  const shinyDirectionOkButThresholdFail = withPalette.filter(r => r.shinyDetected && !r.shinyPassThreshold)
    .sort((a, b) => a.shinyMargin - b.shinyMargin);
  if (shinyDirectionOkButThresholdFail.length > 0) {
    console.log(`\n  DIRECTION OK but below threshold (would miss in production):`);
    for (const r of shinyDirectionOkButThresholdFail) {
      const ratio = r.shinyShinyScore / Math.max(r.shinyNormalScore, 0.001);
      console.log(`    #${r.id} ${r.name.padEnd(12)} normalScore=${r.shinyNormalScore.toFixed(3)} shinyScore=${r.shinyShinyScore.toFixed(3)} ratio=${ratio.toFixed(2)}x margin=${r.shinyMargin.toFixed(3)}`);
    }
  }

  // Test 3: Species identification
  const speciesCorrect = withPalette.filter(r => r.speciesCorrect);
  console.log(`\n━━━ TEST 3: Blind species identification (normal sprite) ━━━`);
  console.log(`Accuracy: ${speciesCorrect.length}/${withPalette.length} (${(speciesCorrect.length/withPalette.length*100).toFixed(1)}%)`);

  const speciesFails = withPalette.filter(r => !r.speciesCorrect);
  if (speciesFails.length > 0) {
    console.log(`\n  MISIDENTIFICATIONS:`);
    for (const r of speciesFails) {
      console.log(`    #${r.id} ${r.name.padEnd(12)} → identified as ${r.speciesGuess}`);
    }
  }

  // ── Hardest to distinguish (lowest margin between normal and shiny) ──
  console.log(`\n━━━ HARDEST TO DISTINGUISH (lowest |normalScore - shinyScore| on shiny sprite) ━━━`);
  const sortedByDifficulty = [...withPalette]
    .sort((a, b) => Math.abs(a.shinyMargin) - Math.abs(b.shinyMargin));
  for (const r of sortedByDifficulty.slice(0, 20)) {
    const status = r.shinyPassThreshold ? '✓ PASS' : r.shinyDetected ? '~ WEAK' : '✗ FAIL';
    console.log(`  ${status}  #${r.id} ${r.name.padEnd(12)} margin=${r.shinyMargin.toFixed(3)} (normal=${r.shinyNormalScore.toFixed(3)} shiny=${r.shinyShinyScore.toFixed(3)})`);
  }

  // ── Summary ──
  console.log(`\n━━━ SUMMARY ━━━`);
  console.log(`Normal identification:  ${normalCorrect.length}/${withPalette.length} (${(normalCorrect.length/withPalette.length*100).toFixed(1)}%) — false shiny alerts`);
  console.log(`Shiny detection (dir):  ${shinyDirectionCorrect.length}/${withPalette.length} (${(shinyDirectionCorrect.length/withPalette.length*100).toFixed(1)}%) — correct direction`);
  console.log(`Shiny detection (prod): ${shinyThresholdPass.length}/${withPalette.length} (${(shinyThresholdPass.length/withPalette.length*100).toFixed(1)}%) — passes production threshold`);
  console.log(`Species identification: ${speciesCorrect.length}/${withPalette.length} (${(speciesCorrect.length/withPalette.length*100).toFixed(1)}%) — blind ID`);

  // ── Full results table ──
  console.log(`\n━━━ FULL RESULTS TABLE ━━━`);
  console.log('ID   Name          Pixels  Normal(n/s)     Shiny(n/s)      Margin  Thresh  Species');
  for (const r of withPalette) {
    const normStr = `${r.normalNormalScore.toFixed(2)}/${r.normalShinyScore.toFixed(2)}`;
    const shnyStr = `${r.shinyNormalScore.toFixed(2)}/${r.shinyShinyScore.toFixed(2)}`;
    const thresh = r.shinyPassThreshold ? '  PASS' : r.shinyDetected ? '  weak' : '  FAIL';
    const species = r.speciesCorrect ? '  OK' : `  →${r.speciesGuess}`;
    console.log(`${String(r.id).padStart(3)}  ${r.name.padEnd(12)}  ${String(r.normalPixels).padStart(5)}  ${normStr.padEnd(14)}  ${shnyStr.padEnd(14)}  ${r.shinyMargin.toFixed(3).padStart(6)}${thresh}${species}`);
  }
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
