import sharp from 'sharp';
import path from 'path';
import { extractSummaryInfo, cleanupOcr } from '../src/detection/summary-info';

const FIXTURES = path.join(__dirname, 'fixtures');

afterAll(async () => {
  await cleanupOcr();
});

describe('Summary Info Extraction', () => {
  test('normal charmander: detects Lax nature and male gender', async () => {
    const frame = await sharp(path.join(FIXTURES, 'normal-charmander-summary.png')).toBuffer();
    const info = await extractSummaryInfo(frame);

    expect(info.nature).toBe('Lax');
    expect(info.gender).toBe('male');
  });

  test('shiny charmander: detects nature and gender', async () => {
    const frame = await sharp(path.join(FIXTURES, 'shiny-charmander-summary.png')).toBuffer();
    const info = await extractSummaryInfo(frame);

    expect(info.nature).not.toBeNull();
    expect(info.gender).not.toBe('unknown');
  });

  test('overworld does not crash', async () => {
    const frame = await sharp(path.join(FIXTURES, 'overworld.png')).toBuffer();
    const info = await extractSummaryInfo(frame);

    // Should not throw — nature/gender may be garbage but that's ok
    expect(info).toBeDefined();
  });
});
