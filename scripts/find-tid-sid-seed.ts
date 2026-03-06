/**
 * Brute-force find which (initialSeed, advance) produces TID=64197, SID=18481.
 */
import { nextSeed, seedToRandom, advanceSeed } from '../src/engine/rng';

const TARGET_TID = 64197;
const TARGET_SID = 18481;

function main() {
  console.log(`Searching for seed that produces TID=${TARGET_TID} SID=${TARGET_SID}...`);

  // Try all 65536 initial seeds, advances 0-5000
  const MAX_ADVANCE = 5000;

  for (let initSeed = 0; initSeed <= 0xFFFF; initSeed++) {
    let seed = initSeed;
    for (let adv = 0; adv <= MAX_ADVANCE; adv++) {
      const s1 = nextSeed(seed);
      const tid = seedToRandom(s1);

      if (tid === TARGET_TID) {
        const s2 = nextSeed(s1);
        const sid = seedToRandom(s2);

        if (sid === TARGET_SID) {
          console.log(`FOUND! initialSeed=0x${initSeed.toString(16).padStart(4, '0')} (${initSeed}) advance=${adv}`);
          console.log(`  TID=${tid} (0x${tid.toString(16).padStart(4, '0')})`);
          console.log(`  SID=${sid} (0x${sid.toString(16).padStart(4, '0')})`);
        }

        // Also log near-matches for context
        if (adv < 100 || (adv >= 800 && adv <= 1500)) {
          // just for the first few found ones with matching TID
        }
      }

      seed = nextSeed(seed);
    }

    if (initSeed % 10000 === 0) {
      process.stdout.write(`  ${initSeed}/65536...\r`);
    }
  }

  console.log('\nDone searching.');

  // Also check: what SIDs does findSeedsForTID produce?
  console.log('\n--- Checking findSeedsForTID output ---');
  const { findSeedsForTID } = require('../src/engine/seed-table');
  const candidates = findSeedsForTID(TARGET_TID);
  console.log(`Total candidates: ${candidates.length}`);

  // Check if 18481 is among them
  const match = candidates.find((c: any) => c.sid === TARGET_SID);
  if (match) {
    console.log(`SID ${TARGET_SID} found: seed=0x${match.initialSeed.toString(16)} adv=${match.tidAdvance}`);
  } else {
    console.log(`SID ${TARGET_SID} NOT in candidates`);
    // Show the advance range of all candidates
    const advances = candidates.map((c: any) => c.tidAdvance);
    console.log(`Advance range in candidates: ${Math.min(...advances)} - ${Math.max(...advances)}`);
  }
}

main();
