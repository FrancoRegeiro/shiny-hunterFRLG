import sharp from 'sharp';

/**
 * Battle screen detection and shiny sparkle detection for FRLG.
 *
 * Key insight: The FRLG battle background has bright sky that creates
 * LARGE (300+px) clusters of near-white pixels. Sparkle stars create
 * SMALL (4-150px) clusters. We distinguish by cluster SIZE.
 *
 * GBA native resolution: 240x160
 * Enemy Pokemon sprite area: roughly x=144-208, y=24-72
 * Battle text box: y=112-160 (blue-gray background)
 */

// Enemy Pokemon sparkle region — starts at y:24 to exclude bright sky (y:0-24)
const ENEMY_SPARKLE_REGION = { x: 120, y: 24, w: 120, h: 56 };

// Battle text box region
const BATTLE_TEXT_BOX = { x: 0, y: 112, w: 240, h: 48 };

interface RawFrame {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

async function getRaw(frameBuffer: Buffer): Promise<RawFrame> {
  const { data, info } = await sharp(frameBuffer).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/**
 * Detect if the current frame is a battle screen.
 * Checks for FRLG battle text box (blue-gray background + gold border).
 */
export async function isBattleScreen(frameBuffer: Buffer): Promise<boolean> {
  const frame = await getRaw(frameBuffer);

  let textBoxPixels = 0;
  let goldPixels = 0;
  let totalPixels = 0;
  const { x, y, w, h } = BATTLE_TEXT_BOX;
  for (let py = y; py < y + h && py < frame.height; py++) {
    for (let px = x; px < x + w && px < frame.width; px++) {
      const idx = (py * frame.width + px) * frame.channels;
      const r = frame.data[idx], g = frame.data[idx + 1], b = frame.data[idx + 2];
      totalPixels++;
      if (r >= 25 && r <= 65 && g >= 75 && g <= 115 && b >= 95 && b <= 135) textBoxPixels++;
      if (r >= 180 && r <= 230 && g >= 160 && g <= 210 && b >= 30 && b <= 100) goldPixels++;
    }
  }

  if (totalPixels === 0) return false;
  const textBoxRatio = textBoxPixels / totalPixels;
  const goldRatio = goldPixels / totalPixels;

  let topDark = 0;
  let topTotal = 0;
  for (let py = 0; py < 80 && py < frame.height; py++) {
    for (let px = 0; px < frame.width; px += 4) {
      const idx = (py * frame.width + px) * frame.channels;
      topTotal++;
      if (frame.data[idx] < 40 && frame.data[idx + 1] < 40 && frame.data[idx + 2] < 40) topDark++;
    }
  }
  const topDarkRatio = topTotal > 0 ? topDark / topTotal : 0;

  return textBoxRatio > 0.30 && goldRatio > 0.03 && topDarkRatio < 0.70;
}

/**
 * Detect if the current frame is overworld (no battle text box).
 */
export async function isOverworldScreen(frameBuffer: Buffer): Promise<boolean> {
  const frame = await getRaw(frameBuffer);

  let textBoxPixels = 0;
  let goldPixels = 0;
  let totalPixels = 0;
  const { x, y, w, h } = BATTLE_TEXT_BOX;
  for (let py = y; py < y + h && py < frame.height; py++) {
    for (let px = x; px < x + w && px < frame.width; px++) {
      const idx = (py * frame.width + px) * frame.channels;
      const r = frame.data[idx], g = frame.data[idx + 1], b = frame.data[idx + 2];
      totalPixels++;
      if (r >= 25 && r <= 65 && g >= 75 && g <= 115 && b >= 95 && b <= 135) textBoxPixels++;
      if (r >= 180 && r <= 230 && g >= 160 && g <= 210 && b >= 30 && b <= 100) goldPixels++;
    }
  }

  if (totalPixels === 0) return false;
  const textBoxRatio = textBoxPixels / totalPixels;
  const goldRatio = goldPixels / totalPixels;

  return textBoxRatio < 0.15 && goldRatio < 0.02;
}

export interface SparkleResult {
  isShiny: boolean;
  sparkleCount: number;
  maxClusterSize: number;
  debugInfo: string;
}

/**
 * Check a battle frame for shiny sparkle stars in the enemy Pokemon area.
 *
 * Detection strategy: Count SMALL clusters (4-150px) of very bright pixels.
 * - Sparkle stars: 4 bright white star bursts (~30-80px each) = 3-4 small clusters
 * - Background sky: 1-2 LARGE bright patches (300+px each) = 0 small clusters
 * - Webcam/wrong device: massive bright pixels (>1500) = rejected outright
 *
 * Player's shiny Charmander flash is filtered by checking the text box region.
 */
export async function detectBattleSparkle(frameBuffer: Buffer): Promise<SparkleResult> {
  const frame = await getRaw(frameBuffer);

  // Screen-wide flash filter (player's Charmander sparkle)
  let textBoxBright = 0;
  let textBoxTotal = 0;
  const tb = BATTLE_TEXT_BOX;
  for (let py = tb.y; py < tb.y + tb.h && py < frame.height; py++) {
    for (let px = tb.x; px < tb.x + tb.w && px < frame.width; px += 2) {
      const idx = (py * frame.width + px) * frame.channels;
      const r = frame.data[idx], g = frame.data[idx + 1], b = frame.data[idx + 2];
      textBoxTotal++;
      if (r > 200 && g > 200 && b > 200) textBoxBright++;
    }
  }
  const flashRatio = textBoxTotal > 0 ? textBoxBright / textBoxTotal : 0;
  if (flashRatio > 0.15) {
    return {
      isShiny: false,
      sparkleCount: 0,
      maxClusterSize: 0,
      debugInfo: `flash_filtered (textBoxBright=${(flashRatio * 100).toFixed(0)}%)`,
    };
  }

  let sparklePixels = 0;
  const region = ENEMY_SPARKLE_REGION;
  const regionW = Math.min(region.w, frame.width - region.x);
  const regionH = Math.min(region.h, frame.height - region.y);

  const brightMap: boolean[][] = [];

  for (let py = 0; py < regionH; py++) {
    const row: boolean[] = [];
    for (let px = 0; px < regionW; px++) {
      const idx = ((region.y + py) * frame.width + (region.x + px)) * frame.channels;
      const r = frame.data[idx], g = frame.data[idx + 1], b = frame.data[idx + 2];
      const isBright = r > 245 && g > 245 && b > 235;
      row.push(isBright);
      if (isBright) sparklePixels++;
    }
    brightMap.push(row);
  }

  // Reject non-game frames (webcam, wrong capture device).
  // GBA battle backgrounds never have >1500 near-white pixels in the sprite region.
  if (sparklePixels > 1500) {
    return {
      isShiny: false,
      sparkleCount: sparklePixels,
      maxClusterSize: 0,
      debugInfo: `rejected_non_game (${sparklePixels} bright in ${regionW}x${regionH})`,
    };
  }

  // Cluster analysis: categorize by size
  const visited = brightMap.map(row => row.map(() => false));
  let maxCluster = 0;
  let smallClusters = 0;   // 4-150px: sparkle star candidates
  let largeClusters = 0;   // >150px: background sky patches
  let smallClusterPx = 0;

  for (let y = 0; y < brightMap.length; y++) {
    for (let x = 0; x < brightMap[y].length; x++) {
      if (brightMap[y][x] && !visited[y][x]) {
        const size = floodFill(brightMap, visited, x, y);
        if (size >= 4 && size <= 150) {
          smallClusters++;
          smallClusterPx += size;
        }
        if (size > 150) largeClusters++;
        if (size > maxCluster) maxCluster = size;
      }
    }
  }

  // Shiny: 3+ small bright clusters from sparkle star animation
  // Normal: 0-1 small clusters (random Pokemon sprite highlights)
  const isShiny = smallClusters >= 3 && smallClusterPx >= 30;

  return {
    isShiny,
    sparkleCount: sparklePixels,
    maxClusterSize: maxCluster,
    debugInfo: `sparkles=${sparklePixels} sm=${smallClusters}(${smallClusterPx}px) lg=${largeClusters} maxC=${maxCluster} flash=${(flashRatio * 100).toFixed(0)}%`,
  };
}

/**
 * Scan multiple frames for shiny sparkle during battle entry.
 * Does NOT require isBattleScreen — cluster criteria + non-game rejection
 * is sufficient to avoid false positives on non-battle frames.
 * Single-frame confirmation: the strict cluster criteria is selective enough.
 */
export async function scanForSparkle(
  captureFrame: () => Promise<Buffer>,
  frameCount: number = 5,
  intervalMs: number = 150,
): Promise<{ isShiny: boolean; bestResult: SparkleResult; framesChecked: number }> {
  let bestResult: SparkleResult = { isShiny: false, sparkleCount: 0, maxClusterSize: 0, debugInfo: 'no frames' };
  let framesChecked = 0;

  for (let i = 0; i < frameCount; i++) {
    const frame = await captureFrame();
    const result = await detectBattleSparkle(frame);
    framesChecked++;

    if (result.sparkleCount > bestResult.sparkleCount) {
      bestResult = result;
    }

    if (result.isShiny) {
      return { isShiny: true, bestResult: result, framesChecked };
    }

    if (i < frameCount - 1) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  return { isShiny: false, bestResult, framesChecked };
}

/**
 * Analyze pre-captured frames for sparkle (used with burst capture).
 */
export async function scanFramesForSparkle(
  frames: Buffer[],
): Promise<{ isShiny: boolean; bestResult: SparkleResult; framesChecked: number }> {
  let bestResult: SparkleResult = { isShiny: false, sparkleCount: 0, maxClusterSize: 0, debugInfo: 'no frames' };
  let framesChecked = 0;

  for (const frame of frames) {
    const result = await detectBattleSparkle(frame);
    framesChecked++;

    if (result.sparkleCount > bestResult.sparkleCount) {
      bestResult = result;
    }

    if (result.isShiny) {
      return { isShiny: true, bestResult: result, framesChecked };
    }
  }

  return { isShiny: false, bestResult, framesChecked };
}

function floodFill(map: boolean[][], visited: boolean[][], startX: number, startY: number): number {
  const stack = [{ x: startX, y: startY }];
  let size = 0;

  while (stack.length > 0) {
    const { x, y } = stack.pop()!;
    if (y < 0 || y >= map.length || x < 0 || x >= map[y].length) continue;
    if (visited[y][x] || !map[y][x]) continue;

    visited[y][x] = true;
    size++;

    stack.push({ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 });
  }

  return size;
}
