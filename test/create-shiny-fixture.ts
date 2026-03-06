import sharp from 'sharp';
import path from 'path';

const FIXTURES = path.join(__dirname, 'fixtures');

async function main() {
  const summaryPath = path.join(FIXTURES, 'normal-charmander-summary.png');
  const { data: summaryData, info } = await sharp(summaryPath).raw().toBuffer({ resolveWithObject: true });

  const shinySpritePath = path.join(FIXTURES, 'shiny-charmander-sprite-frlg.png');
  const { data: spriteData, info: spriteInfo } = await sharp(shinySpritePath)
    .resize(64, 64, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const outData = Buffer.from(summaryData);

  // Clear the entire left sprite panel (x=0-79, y=20-95) to light gray
  // This covers the full area where the sprite animation can appear
  for (let py = 20; py < 96; py++) {
    for (let px = 0; px < 80; px++) {
      const idx = (py * info.width + px) * info.channels;
      outData[idx] = 239;
      outData[idx + 1] = 239;
      outData[idx + 2] = 239;
    }
  }

  // Overlay shiny sprite centered in the cleared area
  // Normal Charmander body is at ~x=43-76, y=37-72, so center the 64x64 sprite
  // at roughly x=8, y=28 to match the GBA summary layout
  const offsetX = 8;
  const offsetY = 28;
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

  const outPath = path.join(FIXTURES, 'shiny-charmander-summary.png');
  await sharp(outData, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .png()
    .toFile(outPath);
  console.log(`Created: ${outPath}`);
}

main().catch(console.error);
