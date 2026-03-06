import sharp from 'sharp';
import path from 'path';

const FIXTURES = path.join(__dirname, 'fixtures');

// In FRLG, shiny Pokemon change the summary screen border from purple to teal
// Calibrated from real shiny screenshot (shiny-border.png):
//   Normal border: #947BAD rgb(148,123,173) — purple/lavender
//   Shiny border:  #62E8E1 rgb(98,232,225) — bright teal/cyan
const PURPLE_TO_TEAL: Record<string, [number, number, number]> = {
  // Lighter purple → bright teal (from real screenshot)
  '148,123,173': [98, 232, 225],
  // Darker purple → slightly darker teal
  '132,99,156': [82, 210, 205],
};

async function createSummaryFixture(
  spritePath: string,
  outputName: string,
  isShiny: boolean,
) {
  const basePath = path.join(FIXTURES, 'normal-charmander-summary.png');
  const { data: baseData, info } = await sharp(basePath).raw().toBuffer({ resolveWithObject: true });

  const { data: spriteData, info: spriteInfo } = await sharp(spritePath)
    .resize(64, 64, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const outData = Buffer.from(baseData);

  // For shiny fixtures: convert purple border pixels to teal
  if (isShiny) {
    for (let py = 0; py < info.height; py++) {
      for (let px = 0; px < info.width; px++) {
        const idx = (py * info.width + px) * info.channels;
        const key = `${outData[idx]},${outData[idx + 1]},${outData[idx + 2]}`;
        const teal = PURPLE_TO_TEAL[key];
        if (teal) {
          outData[idx] = teal[0];
          outData[idx + 1] = teal[1];
          outData[idx + 2] = teal[2];
        }
      }
    }
  }

  // Clear sprite placement area to light gray
  for (let py = 28; py < 92; py++) {
    for (let px = 8; px < 72; px++) {
      const idx = (py * info.width + px) * info.channels;
      outData[idx] = 239;
      outData[idx + 1] = 239;
      outData[idx + 2] = 239;
    }
  }

  // Overlay sprite
  const offsetX = 8, offsetY = 28;
  for (let sy = 0; sy < 64; sy++) {
    for (let sx = 0; sx < 64; sx++) {
      const spriteIdx = (sy * 64 + sx) * spriteInfo.channels;
      const alpha = spriteData[spriteIdx + 3];
      if (alpha > 128) {
        const destX = offsetX + sx;
        const destY = offsetY + sy;
        if (destX < info.width && destY < info.height) {
          const destIdx = (destY * info.width + destX) * info.channels;
          outData[destIdx] = spriteData[spriteIdx];
          outData[destIdx + 1] = spriteData[spriteIdx + 1];
          outData[destIdx + 2] = spriteData[spriteIdx + 2];
        }
      }
    }
  }

  const outPath = path.join(FIXTURES, `${outputName}.png`);
  await sharp(outData, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .png()
    .toFile(outPath);
  console.log(`Created: ${outPath}`);
}

async function main() {
  const starters = ['charmander', 'squirtle', 'bulbasaur'];

  for (const pokemon of starters) {
    // Normal: real normal sprite on purple border background
    await createSummaryFixture(
      path.join(FIXTURES, `normal-${pokemon}-sprite-frlg.png`),
      `normal-${pokemon}-summary`,
      false,
    );
    // Shiny: real shiny sprite on teal border background
    await createSummaryFixture(
      path.join(FIXTURES, `shiny-${pokemon}-sprite-frlg.png`),
      `shiny-${pokemon}-summary`,
      true,
    );
  }
}

main().catch(console.error);
