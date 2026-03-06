/**
 * Debug: trace the exact TID_ENTRY path from rng-switch.ts
 * Screenshots at every step to find where we go wrong.
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
    const name = `tid-${String(step).padStart(2, '0')}-${label}`;
    await fs.writeFile(path.join(outDir, `${name}.png`), frame);
    console.log(`  [${step}] ${label}`);
    step++;
  };

  const seqs = getSequences('fire-red', 'charmander');

  // === SOFT_RESET ===
  console.log('=== SOFT_RESET ===');
  await input.softReset();
  await snap('after-reset');

  // === WAIT_BOOT (4.5s) ===
  console.log('=== WAIT_BOOT (4.5s) ===');
  await wait(4500);
  await snap('after-boot-wait');

  // === TITLE SCREEN (standard sequence for TID_ENTRY) ===
  console.log('=== TITLE (standard sequence) ===');
  for (const s of seqs.title) {
    if (s.action === 'press') {
      console.log(`  press ${(s as any).keys}`);
      await input.pressButtons(s.keys as any, s.holdMs);
    } else if (s.action === 'wait') {
      console.log(`  wait ${(s as any).ms}ms`);
      await wait(s.ms);
    } else if (s.action === 'mashA') {
      console.log(`  mashA x${(s as any).count} @${(s as any).intervalMs}ms`);
      for (let i = 0; i < s.count; i++) {
        await input.pressButton('A', 50);
        await wait(s.intervalMs);
      }
    }
  }
  await snap('after-title');

  // === LOAD_SAVE (standard sequence) ===
  console.log('=== LOAD_SAVE (standard sequence) ===');
  for (const s of seqs.loadSave) {
    if (s.action === 'press') {
      console.log(`  press ${(s as any).keys}`);
      await input.pressButtons(s.keys as any, s.holdMs);
    } else if (s.action === 'wait') {
      console.log(`  wait ${(s as any).ms}ms`);
      await wait(s.ms);
    } else if (s.action === 'mashA') {
      for (let i = 0; i < s.count; i++) {
        await input.pressButton('A', 50);
        await wait(s.intervalMs);
      }
    }
  }
  await snap('after-load-save');

  // === RECAP MASHING (8xA @250ms — matching hunt-engine) ===
  console.log('=== RECAP (8xA @250ms) ===');
  for (let i = 0; i < 8; i++) {
    await input.pressButton('A', 50);
    await wait(250);
    await snap(`recap-A-${i + 1}`);
  }
  await wait(400);
  await snap('recap-done');

  // === PICK STARTER (pick sequence) ===
  console.log('=== PICK STARTER (pick sequence) ===');
  for (const s of seqs.pick) {
    if (s.action === 'press') {
      console.log(`  press ${(s as any).keys}`);
      await input.pressButtons(s.keys as any, s.holdMs);
      await wait(300);
      await snap(`pick-press-${(s as any).keys}`);
    } else if (s.action === 'wait') {
      console.log(`  wait ${(s as any).ms}ms`);
      await wait(s.ms);
      await snap(`pick-wait-${(s as any).ms}`);
    } else if (s.action === 'mashA') {
      console.log(`  mashA x${(s as any).count} @${(s as any).intervalMs}ms`);
      for (let i = 0; i < s.count; i++) {
        await input.pressButton('A', 50);
        await wait(s.intervalMs);
        // Screenshot every other A to avoid too many
        if (i % 2 === 1) await snap(`pick-mashA-${i + 1}`);
      }
    } else if (s.action === 'mashB') {
      console.log(`  mashB x${(s as any).count} @${(s as any).intervalMs}ms`);
      for (let i = 0; i < s.count; i++) {
        await input.pressButton('B', 50);
        await wait(s.intervalMs);
      }
    }
  }
  await snap('after-pick');

  // === OPEN SUMMARY ===
  console.log('=== OPEN SUMMARY ===');
  for (const s of seqs.summary) {
    if (s.action === 'press') {
      console.log(`  press ${(s as any).keys}`);
      await input.pressButtons(s.keys as any, s.holdMs);
      await wait(300);
      await snap(`summary-press-${(s as any).keys}`);
    } else if (s.action === 'wait') {
      await wait(s.ms);
    } else if (s.action === 'mashA') {
      for (let i = 0; i < s.count; i++) {
        await input.pressButton('A', 50);
        await wait(s.intervalMs);
      }
    }
  }
  await snap('summary-screen');

  console.log('\nDone! Check debug-screenshots/tid-*');
  await input.cleanup();
  await frames.cleanup();
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
