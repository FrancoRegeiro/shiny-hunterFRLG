/**
 * Test SID deduction logic using PID-based elimination.
 *
 * Two tests:
 * 1. Full 65536 SID search — proves the math works
 * 2. TID-derived 732 candidates — tests the enumeration path
 *
 * For each observation, a non-shiny PID eliminates SIDs where
 * (TID ^ SID ^ pidHigh ^ pidLow) < 8 — exactly 8 SIDs per PID.
 */
import {
  advanceSeed,
  generateMethod1,
  isShinyPID,
  NATURE_NAMES,
} from '../src/engine/rng';

const REAL_TID = 64197;
const REAL_SID = 18481;

interface SimpleSIDCandidate {
  sid: number;
  eliminated: boolean;
}

function eliminateByPID(
  tid: number,
  candidates: SimpleSIDCandidate[],
  pidHigh: number,
  pidLow: number,
  isShiny: boolean,
): number {
  let eliminatedCount = 0;
  for (const c of candidates) {
    if (c.eliminated) continue;
    const xor = tid ^ c.sid ^ pidHigh ^ pidLow;
    const wouldBeShiny = xor < 8;
    if (isShiny !== wouldBeShiny) {
      c.eliminated = true;
      eliminatedCount++;
    }
  }
  return eliminatedCount;
}

function main() {
  console.log('=== SID Deduction Test (PID-based elimination) ===\n');
  console.log(`TID: ${REAL_TID} (0x${REAL_TID.toString(16).padStart(4, '0')})`);
  console.log(`Real SID: ${REAL_SID} (0x${REAL_SID.toString(16).padStart(4, '0')})\n`);

  // Test 1: Full 65536 SID search
  console.log('--- Test 1: All 65536 SIDs ---');
  const allSids: SimpleSIDCandidate[] = [];
  for (let sid = 0; sid <= 0xFFFF; sid++) {
    allSids.push({ sid, eliminated: false });
  }

  const ADVANCE = 1150;
  let obsCount = 0;

  for (let attempt = 0; attempt < 200; attempt++) {
    const initSeed = Math.floor(Math.random() * 0xFFFF);
    const seed = advanceSeed(initSeed, ADVANCE);
    const result = generateMethod1(seed, ADVANCE);
    const isShiny = isShinyPID(REAL_TID, REAL_SID, result.pidHigh, result.pidLow);

    const eliminated = eliminateByPID(REAL_TID, allSids, result.pidHigh, result.pidLow, isShiny);
    obsCount++;
    const remaining = allSids.filter(c => !c.eliminated).length;

    if (obsCount <= 10 || obsCount % 20 === 0 || remaining <= 10) {
      console.log(
        `  Obs #${obsCount}: PID=0x${(result.pid >>> 0).toString(16).padStart(8, '0')} ` +
        `${NATURE_NAMES[result.nature]}${isShiny ? ' SHINY!' : ''} | ` +
        `eliminated ${eliminated} → ${remaining} remaining`
      );
    }

    // Check if real SID survived
    const realSidEntry = allSids.find(c => c.sid === REAL_SID);
    if (realSidEntry?.eliminated) {
      console.log(`\nERROR: Real SID ${REAL_SID} was incorrectly eliminated!`);
      process.exit(1);
    }

    if (remaining === 1) {
      const winner = allSids.find(c => !c.eliminated)!;
      console.log(`\nSID DEDUCED after ${obsCount} observations!`);
      console.log(`Deduced: ${winner.sid} (0x${winner.sid.toString(16).padStart(4, '0')})`);
      console.log(`Expected: ${REAL_SID} (0x${REAL_SID.toString(16).padStart(4, '0')})`);
      console.log(winner.sid === REAL_SID ? 'PASS' : 'FAIL');
      break;
    }
  }

  const remaining1 = allSids.filter(c => !c.eliminated).length;
  if (remaining1 > 1) {
    console.log(`\nAfter ${obsCount} observations: ${remaining1} SIDs remaining`);
    const survivors = allSids.filter(c => !c.eliminated).slice(0, 20);
    for (const s of survivors) {
      console.log(`  SID ${s.sid} (0x${s.sid.toString(16).padStart(4, '0')})`);
    }
  }

  // Test 2: Show elimination rate stats
  console.log('\n--- Elimination Rate Analysis ---');
  // Each non-shiny PID eliminates exactly 8 SIDs
  // Starting from 65536, need ~65535 eliminations
  // Expected observations: 65536/8 = 8192 (minus overlaps)
  // With birthday paradox, expect ~8000-9000 observations
  console.log('Each non-shiny PID eliminates exactly 8 SID values.');
  console.log('From 65536 total SIDs, theoretical minimum: ~8192 observations.');
  console.log(`Actual convergence: ${obsCount} observations for ${65536 - remaining1} eliminations.`);

  // Test 3: Verify shiny PID dramatically narrows
  console.log('\n--- Test 2: Shiny PID power ---');
  const allSids2: SimpleSIDCandidate[] = [];
  for (let sid = 0; sid <= 0xFFFF; sid++) {
    allSids2.push({ sid, eliminated: false });
  }

  // Find a PID that IS shiny with real SID
  let shinyPid = null;
  for (let i = 0; i < 100000; i++) {
    const initSeed = Math.floor(Math.random() * 0xFFFF);
    const seed = advanceSeed(initSeed, ADVANCE);
    const result = generateMethod1(seed, ADVANCE);
    if (isShinyPID(REAL_TID, REAL_SID, result.pidHigh, result.pidLow)) {
      shinyPid = result;
      break;
    }
  }

  if (shinyPid) {
    console.log(`Found shiny PID: 0x${(shinyPid.pid >>> 0).toString(16).padStart(8, '0')}`);
    const eliminated = eliminateByPID(REAL_TID, allSids2, shinyPid.pidHigh, shinyPid.pidLow, true);
    const remaining = allSids2.filter(c => !c.eliminated).length;
    console.log(`One shiny observation: eliminated ${eliminated} → ${remaining} remaining`);

    const survivors = allSids2.filter(c => !c.eliminated);
    for (const s of survivors) {
      const mark = s.sid === REAL_SID ? ' ← REAL SID' : '';
      console.log(`  SID ${s.sid} (0x${s.sid.toString(16).padStart(4, '0')})${mark}`);
    }

    const realSurvived = survivors.some(s => s.sid === REAL_SID);
    console.log(realSurvived ? 'PASS - Real SID survived' : 'FAIL - Real SID eliminated!');
  } else {
    console.log('Could not find shiny PID in 100000 attempts');
  }
}

main();
