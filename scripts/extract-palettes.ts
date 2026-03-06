/**
 * Download all FireRed/LeafGreen sprites and extract HSL palettes for shiny detection.
 *
 * Fetches normal + shiny sprites from PokeAPI's GitHub sprite repo,
 * analyzes each with sharp to extract dominant hue ranges,
 * then generates src/detection/generated-palettes.ts.
 *
 * Usage: npx ts-node scripts/extract-palettes.ts
 */

import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

const SPRITE_DIR = path.join(__dirname, '..', 'data', 'sprites');
const OUTPUT_FILE = path.join(__dirname, '..', 'src', 'detection', 'generated-palettes.ts');

// All Pokemon available in FireRed/LeafGreen (National Dex 1-151 + some extras)
// We'll try 1-386 (full Gen 3 national dex) and skip missing ones
const MAX_DEX = 386;

const BASE_URL = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-iii/firered-leafgreen';

// Pokemon name lookup (Gen 1-3)
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
  // Gen 2 Pokemon available in FRLG post-game
  152: 'chikorita', 153: 'bayleef', 154: 'meganium',
  155: 'cyndaquil', 156: 'quilava', 157: 'typhlosion',
  158: 'totodile', 159: 'croconaw', 160: 'feraligatr',
  161: 'sentret', 162: 'furret',
  163: 'hoothoot', 164: 'noctowl',
  165: 'ledyba', 166: 'ledian',
  167: 'spinarak', 168: 'ariados',
  169: 'crobat',
  170: 'chinchou', 171: 'lanturn',
  172: 'pichu',
  173: 'cleffa',
  174: 'igglybuff',
  175: 'togepi', 176: 'togetic',
  177: 'natu', 178: 'xatu',
  179: 'mareep', 180: 'flaaffy', 181: 'ampharos',
  182: 'bellossom',
  183: 'marill', 184: 'azumarill',
  185: 'sudowoodo',
  186: 'politoed',
  187: 'hoppip', 188: 'skiploom', 189: 'jumpluff',
  190: 'aipom',
  191: 'sunkern', 192: 'sunflora',
  193: 'yanma',
  194: 'wooper', 195: 'quagsire',
  196: 'espeon', 197: 'umbreon',
  198: 'murkrow',
  199: 'slowking',
  200: 'misdreavus',
  201: 'unown',
  202: 'wobbuffet',
  203: 'girafarig',
  204: 'pineco', 205: 'forretress',
  206: 'dunsparce',
  207: 'gligar',
  208: 'steelix',
  209: 'snubbull', 210: 'granbull',
  211: 'qwilfish',
  212: 'scizor',
  213: 'shuckle',
  214: 'heracross',
  215: 'sneasel',
  216: 'teddiursa', 217: 'ursaring',
  218: 'slugma', 219: 'magcargo',
  220: 'swinub', 221: 'piloswine',
  222: 'corsola',
  223: 'remoraid', 224: 'octillery',
  225: 'delibird',
  226: 'mantine',
  227: 'skarmory',
  228: 'houndour', 229: 'houndoom',
  230: 'kingdra',
  231: 'phanpy', 232: 'donphan',
  233: 'porygon2',
  234: 'stantler',
  235: 'smeargle',
  236: 'tyrogue',
  237: 'hitmontop',
  238: 'smoochum',
  239: 'elekid',
  240: 'magby',
  241: 'miltank',
  242: 'blissey',
  243: 'raikou', 244: 'entei', 245: 'suicune',
  246: 'larvitar', 247: 'pupitar', 248: 'tyranitar',
  249: 'lugia', 250: 'hooh',
  251: 'celebi',
};

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

/**
 * Extract dominant hue ranges from a sprite image.
 * Uses 10-degree bins, groups contiguous significant bins into ranges.
 * Much more robust than peak detection for small GBA sprites.
 */
async function extractPalette(spriteBuffer: Buffer): Promise<{
  hueRanges: { min: number; max: number }[];
  satMin: number;
  valMin: number;
  pixelCount: number;
}> {
  const { data, info } = await sharp(spriteBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const sats: number[] = [];
  const lits: number[] = [];

  // 10-degree hue bins (36 bins)
  const bins = new Array(36).fill(0);
  let total = 0;

  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a < 128) continue;
    const hsl = rgbToHsl(r, g, b);
    if (hsl.l < 0.12 || hsl.l > 0.92) continue;
    if (hsl.s < 0.10) continue;

    bins[Math.floor(hsl.h / 10) % 36]++;
    sats.push(hsl.s);
    lits.push(hsl.l);
    total++;
  }

  if (total === 0) {
    return { hueRanges: [], satMin: 0.15, valMin: 0.15, pixelCount: 0 };
  }

  // Threshold: bin must have at least 3% of chromatic pixels
  const threshold = total * 0.03;

  // Find significant bins
  const significant = bins.map((count, i) => ({ bin: i, count, significant: count >= threshold }));

  // Group contiguous significant bins into ranges
  const hueRanges: { min: number; max: number }[] = [];
  let rangeStart = -1;

  // Handle wrap-around: check if bin 0 and bin 35 are both significant
  // by scanning from the first non-significant bin
  let startScan = 0;
  for (let i = 0; i < 36; i++) {
    if (!significant[i].significant) {
      startScan = i;
      break;
    }
  }

  let inRange = false;
  for (let j = 0; j < 36; j++) {
    const i = (startScan + j) % 36;
    if (significant[i].significant) {
      if (!inRange) {
        rangeStart = i * 10;
        inRange = true;
      }
    } else {
      if (inRange) {
        const prevBin = ((i - 1 + 36) % 36);
        hueRanges.push({ min: rangeStart, max: prevBin * 10 + 9 });
        inRange = false;
      }
    }
  }
  // Close final range if still open
  if (inRange) {
    const lastBin = (startScan - 1 + 36) % 36;
    hueRanges.push({ min: rangeStart, max: lastBin * 10 + 9 });
  }

  // Saturation/lightness minimums (10th percentile)
  sats.sort((a, b) => a - b);
  lits.sort((a, b) => a - b);
  const p10 = Math.floor(sats.length * 0.1);
  const satMin = Math.max(0.10, Math.round(sats[p10] * 100) / 100);
  const valMin = Math.max(0.12, Math.round(lits[p10] * 100) / 100);

  return { hueRanges, satMin, valMin, pixelCount: total };
}

async function downloadSprite(id: number, shiny: boolean): Promise<Buffer | null> {
  const url = shiny
    ? `${BASE_URL}/shiny/${id}.png`
    : `${BASE_URL}/${id}.png`;

  const cacheDir = path.join(SPRITE_DIR, shiny ? 'shiny' : 'normal');
  const cachePath = path.join(cacheDir, `${id}.png`);

  // Check cache
  try {
    return await fs.readFile(cachePath);
  } catch {}

  // Download
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(cachePath, buf);
    return buf;
  } catch {
    return null;
  }
}

async function main() {
  console.log('Extracting FRLG sprite palettes...');

  const palettes: Record<string, {
    id: number;
    normal: { hueRanges: { min: number; max: number }[]; satMin: number; valMin: number };
    shiny: { hueRanges: { min: number; max: number }[]; satMin: number; valMin: number };
  }> = {};

  let downloaded = 0;
  let skipped = 0;

  for (const [idStr, name] of Object.entries(POKEMON_NAMES)) {
    const id = parseInt(idStr);
    process.stdout.write(`\r  ${name} (#${id})...`);

    const normalBuf = await downloadSprite(id, false);
    const shinyBuf = await downloadSprite(id, true);

    if (!normalBuf || !shinyBuf) {
      skipped++;
      continue;
    }

    const normalPalette = await extractPalette(normalBuf);
    const shinyPalette = await extractPalette(shinyBuf);

    // Skip if we couldn't extract meaningful colors
    if (normalPalette.hueRanges.length === 0 && shinyPalette.hueRanges.length === 0) {
      skipped++;
      continue;
    }

    palettes[name] = {
      id,
      normal: {
        hueRanges: normalPalette.hueRanges,
        satMin: normalPalette.satMin,
        valMin: normalPalette.valMin,
      },
      shiny: {
        hueRanges: shinyPalette.hueRanges,
        satMin: shinyPalette.satMin,
        valMin: shinyPalette.valMin,
      },
    };
    downloaded++;
  }

  console.log(`\nExtracted ${downloaded} palettes, skipped ${skipped}`);

  // Generate TypeScript file
  const lines: string[] = [
    '// AUTO-GENERATED by scripts/extract-palettes.ts',
    '// Derived from actual FireRed/LeafGreen sprites via PokeAPI.',
    '// Do not edit manually — re-run the script to regenerate.',
    '',
    'import { PokemonPalette } from \'../types\';',
    '',
    'export const FRLG_PALETTES: Record<string, PokemonPalette & { id: number }> = {',
  ];

  for (const [name, data] of Object.entries(palettes)) {
    const normalRanges = data.normal.hueRanges.map(r => `{ min: ${r.min}, max: ${r.max} }`).join(', ');
    const shinyRanges = data.shiny.hueRanges.map(r => `{ min: ${r.min}, max: ${r.max} }`).join(', ');

    lines.push(`  ${name}: {`);
    lines.push(`    id: ${data.id},`);
    lines.push(`    normal: { hueRanges: [${normalRanges}], satMin: ${data.normal.satMin}, valMin: ${data.normal.valMin} },`);
    lines.push(`    shiny: { hueRanges: [${shinyRanges}], satMin: ${data.shiny.satMin}, valMin: ${data.shiny.valMin} },`);
    lines.push(`  },`);
  }

  lines.push('};');
  lines.push('');
  lines.push('export function getFRLGPalette(pokemon: string): (PokemonPalette & { id: number }) | null {');
  lines.push('  return FRLG_PALETTES[pokemon.toLowerCase()] || null;');
  lines.push('}');
  lines.push('');
  lines.push(`export const FRLG_POKEMON_NAMES: Record<number, string> = {`);
  for (const [name, data] of Object.entries(palettes)) {
    lines.push(`  ${data.id}: '${name}',`);
  }
  lines.push('};');
  lines.push('');

  await fs.writeFile(OUTPUT_FILE, lines.join('\n'));
  console.log(`Generated ${OUTPUT_FILE}`);
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
