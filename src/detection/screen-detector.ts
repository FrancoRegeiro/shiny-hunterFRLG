import sharp from 'sharp';
import { ScreenType, ScreenDetectionResult } from '../types';

// Detect which screen we're on by sampling known pixel positions
// GBA native resolution: 240x160

interface PixelSample {
  x: number;
  y: number;
}

// Convert RGB to a simple color name for matching
function classifyColor(r: number, g: number, b: number): string {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);

  // Dark/black
  if (max < 40) return 'black';
  // White/light
  if (min > 200) return 'white';
  // Gray
  if (max - min < 30 && max > 60) return 'gray';

  // Color classification by dominant channel
  if (r > g && r > b) {
    if (g > 150 && r > 200) return 'yellow';
    if (g > 100) return 'orange';
    return 'red';
  }
  if (g > r && g > b) return 'green';
  if (b > r && b > g) {
    if (r > 100 && b > 150) return 'purple';
    return 'blue';
  }

  return 'other';
}

async function getPixelColors(
  frameBuffer: Buffer,
  samples: PixelSample[]
): Promise<string[]> {
  const { data, info } = await sharp(frameBuffer)
    .raw()
    .toBuffer({ resolveWithObject: true });

  return samples.map(({ x, y }) => {
    // Clamp to bounds
    const cx = Math.min(x, info.width - 1);
    const cy = Math.min(y, info.height - 1);
    const idx = (cy * info.width + cx) * info.channels;
    return classifyColor(data[idx], data[idx + 1], data[idx + 2]);
  });
}

export async function detectScreen(frameBuffer: Buffer): Promise<ScreenDetectionResult> {
  // Fire Red summary screen detection:
  // - The summary screen has a characteristic blue/teal header bar
  // - The Pokemon sprite region on the left (8-72, 24-88)
  // - Stats text on the right side
  //
  // Party menu detection:
  // - Blue background with HP bar rectangles
  //
  // Dialogue detection:
  // - White/light text box at bottom of screen

  const samples: PixelSample[] = [
    // Top-left area (summary header)
    { x: 120, y: 5 },
    // Center of sprite area (summary Pokemon)
    { x: 40, y: 56 },
    // Right side stats area
    { x: 200, y: 56 },
    // Bottom text box area
    { x: 120, y: 145 },
    // Bottom-left corner
    { x: 10, y: 150 },
    // Top-right
    { x: 230, y: 5 },
  ];

  const colors = await getPixelColors(frameBuffer, samples);

  // Summary screen: blue header, content in body, stats on right
  const isSummary =
    (colors[0] === 'blue' || colors[0] === 'green') &&
    colors[2] !== 'black';

  if (isSummary) {
    return { screen: 'summary', confidence: 0.8 };
  }

  // Party menu: mostly blue background
  const blueCount = colors.filter((c) => c === 'blue').length;
  if (blueCount >= 3) {
    return { screen: 'party_menu', confidence: 0.7 };
  }

  // Dialogue: white text box at bottom
  if (colors[3] === 'white' || colors[4] === 'white') {
    return { screen: 'dialogue', confidence: 0.7 };
  }

  // Battle: characteristic layout with Pokemon sprites
  // (basic heuristic — can be refined)
  if (colors[0] === 'white' && colors[3] === 'white') {
    return { screen: 'battle', confidence: 0.5 };
  }

  // Overworld: mixed colors, greens for grass/trees
  if (colors.some((c) => c === 'green')) {
    return { screen: 'overworld', confidence: 0.5 };
  }

  return { screen: 'unknown', confidence: 0.3 };
}
