/**
 * Analysis: Can we RNG manipulate without knowing SID?
 *
 * Approach: For all ~732 candidate SIDs, find shiny targets.
 * Many targets overlap across SIDs (same seed+advance = shiny for multiple SIDs).
 * If enough overlap, we can target seeds that work for ALL candidate SIDs.
 *
 * Alternative: Brute-force all 65536 SIDs, find shared shiny targets.
 */
import {
  advanceSeed,
  generateMethod1,
  isShinyPID,
  NATURE_NAMES,
} from '../src/engine/rng';

const REAL_TID = 64197;
const REAL_SID = 18481;
const ADV_MIN = 1050;
const ADV_MAX = 1250;

function main() {
  console.log('=== Multi-SID Targeting Analysis ===\n');

  // For EVERY possible SID, count how many shiny targets exist
  // and find targets that work for the maximum number of SIDs
  const targetMap = new Map<string, Set<number>>(); // "seed:advance" → set of SIDs

  console.log('Scanning all 65536 SIDs for shiny targets...');
  let totalTargets = 0;

  for (let sid = 0; sid <= 0xFFFF; sid++) {
    for (let initSeed = 0; initSeed <= 0xFFFF; initSeed++) {
      let seed = advanceSeed(initSeed, ADV_MIN);
      for (let adv = ADV_MIN; adv <= ADV_MAX; adv++) {
        const result = generateMethod1(seed, adv);
        if (isShinyPID(REAL_TID, sid, result.pidHigh, result.pidLow)) {
          const key = `${initSeed}:${adv}`;
          if (!targetMap.has(key)) targetMap.set(key, new Set());
          targetMap.get(key)!.add(sid);
          totalTargets++;
        }
        seed = (0x41C64E6Dn * BigInt(seed >>> 0) + 0x6073n) & 0xFFFFFFFFn;
        seed = Number(seed);
      }
    }
    if (sid % 1000 === 0) process.stdout.write(`  ${sid}/65536...\r`);
  }

  console.log(`\nTotal shiny targets across all SIDs: ${totalTargets}`);
  console.log(`Unique (seed, advance) pairs: ${targetMap.size}`);

  // How many targets work for 1, 2, 3... SIDs?
  const multiSidCounts = new Map<number, number>();
  for (const [, sids] of targetMap) {
    const count = sids.size;
    multiSidCounts.set(count, (multiSidCounts.get(count) || 0) + 1);
  }

  console.log('\nTargets by number of SIDs they work for:');
  const sorted = [...multiSidCounts.entries()].sort((a, b) => b[0] - a[0]);
  for (const [sidCount, targetCount] of sorted.slice(0, 20)) {
    console.log(`  ${sidCount} SIDs: ${targetCount} targets`);
  }

  // Find targets that work for the REAL SID
  const realTargets = [...targetMap.entries()]
    .filter(([, sids]) => sids.has(REAL_SID))
    .map(([key, sids]) => ({ key, sidCount: sids.size }))
    .sort((a, b) => b.sidCount - a.sidCount);

  console.log(`\nTargets for real SID (${REAL_SID}): ${realTargets.length}`);
  if (realTargets.length > 0) {
    console.log('Best overlapping targets:');
    for (const t of realTargets.slice(0, 10)) {
      const [seed, adv] = t.key.split(':');
      console.log(`  Seed 0x${parseInt(seed).toString(16).padStart(4, '0')} adv ${adv}: works for ${t.sidCount} SIDs`);
    }
  }

  // Key question: on average, what fraction of 65536 SIDs does each target cover?
  const avgSidsPerTarget = totalTargets / targetMap.size;
  console.log(`\nAvg SIDs per target: ${avgSidsPerTarget.toFixed(2)}`);
  console.log('Expected: 8 (since shiny check has 8/65536 probability × 65536 SIDs = 8)');
}

main();
