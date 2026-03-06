/**
 * Quick script to read TID/SID from the running emulator.
 * Run: npx tsx scripts/read-ids.ts
 */
import { EmulatorInput } from '../src/drivers/emulator-input';
import { FRLG_ADDRESSES } from '../src/engine/rng';

async function main() {
  const input = new EmulatorInput();
  await input.init();

  const saveBlockPtr = await input.readMemory(FRLG_ADDRESSES.saveBlockPointer, 4);
  console.log(`Save block pointer: 0x${(saveBlockPtr >>> 0).toString(16).padStart(8, '0')}`);

  if (saveBlockPtr === 0) {
    console.log('Save not loaded — make sure game is past title screen');
    await input.cleanup();
    return;
  }

  const tid = await input.readMemory(saveBlockPtr + FRLG_ADDRESSES.tidOffset, 2);
  const sid = await input.readMemory(saveBlockPtr + FRLG_ADDRESSES.sidOffset, 2);

  console.log(`TID: ${tid} (0x${tid.toString(16).padStart(4, '0')})`);
  console.log(`SID: ${sid} (0x${sid.toString(16).padStart(4, '0')})`);
  console.log(`\nTo set these in the Switch RNG engine:`);
  console.log(`  curl -X POST http://localhost:3002/api/rng/tid -H 'Content-Type: application/json' -d '{"tid": ${tid}}'`);
  console.log(`  curl -X POST http://localhost:3002/api/rng/sid -H 'Content-Type: application/json' -d '{"sid": ${sid}}'`);

  await input.cleanup();
}

main().catch(err => { console.error(err); process.exit(1); });
