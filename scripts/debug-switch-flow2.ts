/**
 * Debug: trace the FIXED Switch RNG dialogue flow.
 * Matches the updated rng-switch.ts logic exactly.
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
    const name = `sw2-${String(step).padStart(2, '0')}-${label}`;
    await fs.writeFile(path.join(outDir, `${name}.png`), frame);
    console.log(`  [${step}] ${label}`);
    step++;
  };

  const seqs = getSequences('fire-red', 'charmander');

  // SOFT_RESET
  console.log('=== SOFT_RESET ===');
  await input.softReset();

  // WAIT_BOOT
  console.log('=== WAIT_BOOT ===');
  await wait(4500);

  // TIMED_TITLE_PRESS (standard sequence)
  console.log('=== TITLE ===');
  for (const s of seqs.title) {
    if (s.action === 'press') await input.pressButtons(s.keys as any, s.holdMs);
    else if (s.action === 'wait') await wait(s.ms);
    else if (s.action === 'mashA') {
      for (let i = 0; i < s.count; i++) { await input.pressButton('A', 50); await wait(s.intervalMs); }
    }
  }

  // LOAD_SAVE
  console.log('=== LOAD_SAVE ===');
  for (const s of seqs.loadSave) {
    if (s.action === 'press') await input.pressButtons(s.keys as any, s.holdMs);
    else if (s.action === 'wait') await wait(s.ms);
    else if (s.action === 'mashA') {
      for (let i = 0; i < s.count; i++) { await input.pressButton('A', 50); await wait(s.intervalMs); }
    }
  }

  // WAIT_OVERWORLD (8xA)
  console.log('=== WAIT_OVERWORLD (8xA) ===');
  for (let i = 0; i < 8; i++) {
    await input.pressButton('A', 50);
    await wait(250);
  }
  await wait(400);
  await snap('after-overworld');

  // NAVIGATE_TO_STARTER — only 1 A to reach YES/NO
  console.log('=== NAVIGATE_TO_STARTER (1xA to YES/NO) ===');
  await input.pressButton('A', 50);
  await wait(1500);
  await snap('at-yes-no-prompt');

  // PICK_STARTER — press A on YES
  console.log('=== PICK_STARTER (A on YES) ===');
  await input.pressButton('A', 50);
  await wait(1200);
  await snap('after-yes-pid-generated');

  // postStarterDialogue: 4xA through receive text
  console.log('=== POST-STARTER DIALOGUE ===');
  for (let i = 0; i < 4; i++) {
    await input.pressButton('A', 50);
    await wait(1200);
    await snap(`post-A-${i + 1}`);
  }

  // Nickname prompt — B to decline
  console.log('  B to decline nickname...');
  await wait(500);
  await input.pressButton('B', 50);
  await wait(600);
  await snap('after-nickname-B1');
  await input.pressButton('B', 50);
  await wait(400);
  await snap('after-nickname-B2');

  // Rival dialogue
  console.log('  Rival dialogue (5xA)...');
  for (let i = 0; i < 5; i++) {
    await input.pressButton('A', 50);
    await wait(300);
  }
  await wait(1500);
  await snap('after-rival-1');

  console.log('  Rival picks (8xA)...');
  for (let i = 0; i < 8; i++) {
    await input.pressButton('A', 50);
    await wait(200);
  }
  await wait(300);
  await snap('after-rival-picks');

  // OPEN_SUMMARY
  console.log('=== OPEN_SUMMARY ===');
  for (const s of seqs.summary) {
    if (s.action === 'press') {
      console.log(`  press ${(s as any).keys}`);
      await input.pressButtons(s.keys as any, s.holdMs);
    } else if (s.action === 'wait') await wait(s.ms);
    else if (s.action === 'mashA') {
      for (let i = 0; i < s.count; i++) { await input.pressButton('A', 50); await wait(s.intervalMs); }
    }
  }
  await wait(300);
  await snap('summary-screen');

  console.log('\nDone! Check debug-screenshots/sw2-*');
  await input.cleanup();
  await frames.cleanup();
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
