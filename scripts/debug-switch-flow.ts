/**
 * Debug: trace the Switch RNG engine's dialogue flow with screenshots.
 * Follows the exact same steps as rng-switch.ts but captures frames at each point.
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
    const name = `sw-${String(step).padStart(2, '0')}-${label}`;
    await fs.writeFile(path.join(outDir, `${name}.png`), frame);
    console.log(`  [${step}] ${label}`);
    step++;
  };

  // === SOFT RESET ===
  console.log('=== SOFT_RESET ===');
  await input.softReset();
  await snap('after-reset');

  // === WAIT_BOOT ===
  console.log('=== WAIT_BOOT (4.5s) ===');
  await wait(4500);
  await snap('after-boot-wait');

  // === TIMED_TITLE_PRESS ===
  // Simulate ~7.7s boot timing (our target is 7718ms from boot)
  console.log('=== TIMED_TITLE_PRESS ===');
  // The title sequence from sequences.ts
  const seqs = getSequences('fire-red', 'charmander');
  console.log('Executing title sequence...');
  for (const s of seqs.title) {
    if (s.action === 'press') {
      await input.pressButtons(s.keys as any, s.holdMs);
    } else if (s.action === 'wait') {
      await wait(s.ms);
    } else if (s.action === 'mashA') {
      for (let i = 0; i < s.count; i++) {
        await input.pressButton('A', 50);
        await wait(s.intervalMs);
      }
    }
  }
  await snap('after-title');

  // === LOAD_SAVE ===
  console.log('=== LOAD_SAVE ===');
  for (const s of seqs.loadSave) {
    if (s.action === 'press') {
      await input.pressButtons(s.keys as any, s.holdMs);
    } else if (s.action === 'wait') {
      await wait(s.ms);
    } else if (s.action === 'mashA') {
      for (let i = 0; i < s.count; i++) {
        await input.pressButton('A', 50);
        await wait(s.intervalMs);
      }
    }
  }
  await snap('after-load-save');

  // === WAIT_OVERWORLD ===
  console.log('=== WAIT_OVERWORLD (8xA) ===');
  for (let i = 0; i < 8; i++) {
    await input.pressButton('A', 50);
    await wait(250);
  }
  await wait(400);
  await snap('after-overworld');

  // === NAVIGATE_TO_STARTER ===
  console.log('=== NAVIGATE_TO_STARTER (2xA) ===');
  await input.pressButton('A', 50);
  await wait(1500);
  await snap('after-first-A');

  await input.pressButton('A', 50);
  await wait(1500);
  await snap('after-second-A-should-be-yes-no');

  // === PICK_STARTER (confirmStarterAndFinish) ===
  console.log('=== PICK_STARTER (confirm + dialogue) ===');

  // Press A on YES
  console.log('  A on YES...');
  await input.pressButton('A', 50);
  await wait(1200);
  await snap('after-yes');

  // Mash A through receive text (3x)
  for (let i = 0; i < 3; i++) {
    console.log(`  A through receive text ${i + 1}...`);
    await input.pressButton('A', 50);
    await wait(1200);
    await snap(`after-receive-A-${i + 1}`);
  }

  // Nickname prompt — decline with B (3x)
  console.log('  B to decline nickname (3x)...');
  await wait(500);
  for (let i = 0; i < 3; i++) {
    await input.pressButton('B', 50);
    await wait(400);
    await snap(`after-nickname-B-${i + 1}`);
  }

  // Rival dialogue
  console.log('  A through rival dialogue (5x)...');
  for (let i = 0; i < 5; i++) {
    await input.pressButton('A', 50);
    await wait(200);
  }
  await wait(1500);
  await snap('after-rival-dialogue-1');

  console.log('  A through rival picks (8x)...');
  for (let i = 0; i < 8; i++) {
    await input.pressButton('A', 50);
    await wait(200);
  }
  await wait(200);
  await snap('after-rival-picks');

  // === OPEN_SUMMARY ===
  console.log('=== OPEN_SUMMARY ===');
  for (const s of seqs.summary) {
    if (s.action === 'press') {
      console.log(`  press ${(s as any).keys}`);
      await input.pressButtons(s.keys as any, s.holdMs);
    } else if (s.action === 'wait') {
      await wait(s.ms);
    } else if (s.action === 'mashA') {
      for (let i = 0; i < s.count; i++) {
        await input.pressButton('A', 50);
        await wait(s.intervalMs);
      }
    }
  }
  await wait(300);
  await snap('summary-screen');

  console.log('\nDone! Screenshots in debug-screenshots/');
  await input.cleanup();
  await frames.cleanup();
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
