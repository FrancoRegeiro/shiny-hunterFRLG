/**
 * Debug: simulate the LIVE Switch RNG flow with timed title press.
 * Uses the exact boot timing the engine uses.
 */
import { EmulatorInput } from '../src/drivers/emulator-input';
import { EmulatorFrames } from '../src/drivers/emulator-frames';
import { getSequences } from '../src/engine/sequences';
import fs from 'fs/promises';
import path from 'path';

async function main() {
  const input = new EmulatorInput();
  const frames = new EmulatorFrames(input);
  await input.init();
  await frames.init();

  const outDir = path.join(process.cwd(), 'debug-screenshots');
  await fs.mkdir(outDir, { recursive: true });

  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  let step = 0;

  const snap = async (label: string) => {
    const frame = await frames.captureFrame();
    const name = `live-${String(step).padStart(2, '0')}-${label}`;
    await fs.writeFile(path.join(outDir, `${name}.png`), frame);
    console.log(`  [${step}] ${label}`);
    step++;
  };

  const seqs = getSequences('fire-red', 'charmander');

  // SOFT_RESET
  console.log('=== SOFT_RESET ===');
  await input.softReset();
  const bootTimestamp = Date.now();

  // WAIT_BOOT (4.5s)
  console.log('=== WAIT_BOOT ===');
  await wait(4500);

  // TIMED_TITLE_PRESS — wait until 7718ms from boot, then press A
  console.log('=== TIMED_TITLE_PRESS (target: 7718ms) ===');
  const targetMs = 7718;
  const elapsed = Date.now() - bootTimestamp;
  const remaining = targetMs - elapsed;
  console.log(`  elapsed: ${elapsed}ms, remaining: ${remaining}ms`);
  if (remaining > 0) {
    await wait(remaining);
  }
  await input.pressButton('A', 50);
  await wait(200);
  await input.pressButton('A', 50);
  await wait(500);
  await snap('after-timed-title');

  // LOAD_SAVE
  console.log('=== LOAD_SAVE ===');
  for (const s of seqs.loadSave) {
    if (s.action === 'press') await input.pressButtons(s.keys as any, s.holdMs);
    else if (s.action === 'wait') await wait(s.ms);
    else if (s.action === 'mashA') {
      for (let i = 0; i < s.count; i++) { await input.pressButton('A', 50); await wait(s.intervalMs); }
    }
  }
  await snap('after-load-save');

  // WAIT_OVERWORLD — screenshot after EACH A press to see where we are
  console.log('=== WAIT_OVERWORLD (8xA, screenshots each) ===');
  for (let i = 0; i < 8; i++) {
    await input.pressButton('A', 50);
    await wait(250);
    await snap(`overworld-A-${i + 1}`);
  }
  await wait(400);
  await snap('overworld-done');

  // NAVIGATE_TO_STARTER (1xA)
  console.log('=== NAVIGATE_TO_STARTER (1xA) ===');
  await input.pressButton('A', 50);
  await wait(1500);
  await snap('navigate-A');

  // What's on screen now?
  console.log('\nDone! Check debug-screenshots/live-*');
  await input.cleanup();
  await frames.cleanup();
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
