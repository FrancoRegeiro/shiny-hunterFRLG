/**
 * Monte Carlo simulation: Multi-SID Targeting vs Bare Hunt Engine
 *
 * Compares expected encounters-to-shiny for:
 * 1. Bare hunt: random seed each reset, 1/8192 per encounter
 * 2. Multi-SID targeting: targeted seeds, cycling through schedule
 *
 * Run: npx tsx scripts/simulate-comparison.ts
 */

import {
  nextSeed,
  advanceSeed,
  generateMethod1,
  isShinyPID,
  NATURE_NAMES,
} from '../src/engine/rng';
import { findSeedsForTID, seedToBootTimingMs, bootTimingToSeed } from '../src/engine/seed-table';
import { buildSeedSchedule, SeedScheduleEntry } from '../src/engine/multi-sid-target';
import { enumerateSIDCandidates, SIDScore } from '../src/engine/sid-deduction';

// ── Configuration ──────────────────────────────────────────────────────────
const TID = 24248;                        // Our actual TID
const ADV_WINDOW = { min: 1050, max: 1250 };
const BIOS_OFFSET_MS = 4500;
const NUM_TRIALS = 5_000;                 // Monte Carlo trials per approach
const TIMING_JITTER_SEEDS = 5;            // ±N seeds of timing accuracy
const ENCOUNTER_CAP = 100_000;            // Stop trial if no shiny by this many

// Cycle time estimates (seconds per encounter)
const BARE_CYCLE_S = 30;                  // Random mashing, ~30s per cycle
const RNG_CYCLE_S = 32;                   // Slightly longer due to timed press + busy wait

// ── Helpers ────────────────────────────────────────────────────────────────

function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  Multi-SID Targeting vs Bare Hunt — Monte Carlo Simulation         ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  // ── Step 1: Enumerate SID candidates ─────────────────────────────────
  const sidCandidates = enumerateSIDCandidates(TID);
  const activeSIDs = sidCandidates.filter(s => !s.eliminated).map(s => s.sid);
  console.log(`TID: ${TID}`);
  console.log(`SID candidates: ${activeSIDs.length}`);
  console.log(`Advance window: [${ADV_WINDOW.min}, ${ADV_WINDOW.max}] (${ADV_WINDOW.max - ADV_WINDOW.min + 1} advances)\n`);

  // ── Step 2: Build multi-SID schedule ─────────────────────────────────
  console.log('Building seed schedule...');
  const t0 = Date.now();
  const schedule = buildSeedSchedule(TID, sidCandidates, ADV_WINDOW, BIOS_OFFSET_MS);
  console.log(`Done in ${Date.now() - t0}ms: ${schedule.length} seeds with shiny targets\n`);

  // ── Step 3: Analyze schedule ─────────────────────────────────────────
  console.log('── Schedule Analysis ──');
  console.log(`Top 10 seeds by SID coverage:`);
  for (const s of schedule.slice(0, 10)) {
    console.log(`  0x${s.initialSeed.toString(16).padStart(4, '0')}: ${s.sidCount}/${activeSIDs.length} SIDs (${(s.sidCount / activeSIDs.length * 100).toFixed(1)}%)`);
  }

  const avgSIDs = schedule.reduce((sum, s) => sum + s.sidCount, 0) / schedule.length;
  console.log(`\nAverage SIDs per seed: ${avgSIDs.toFixed(1)}`);
  console.log(`Expected (theoretical): ~${(activeSIDs.length * 8 * (ADV_WINDOW.max - ADV_WINDOW.min + 1) / 65536).toFixed(1)}`);
  // Each advance has P=8/65536 of being shiny for a given SID.
  // Over 201 advances, E[shiny advances per SID] = 201*8/65536 ≈ 0.0245
  // P(at least 1 shiny advance for SID) = 1-(1-8/65536)^201 ≈ 2.4%
  // Expected SIDs covered per seed ≈ 703 * 0.024 ≈ 17.1

  // ── Step 4: SID clustering analysis ──────────────────────────────────
  // For a given PID, the 8 shiny-compatible SIDs share top 13 bits.
  // If our candidates cluster in these 8-groups, we can exploit it.
  console.log('\n── SID Clustering ──');
  const top13Buckets = new Map<number, number[]>();
  for (const sid of activeSIDs) {
    const top13 = sid >>> 3;
    if (!top13Buckets.has(top13)) top13Buckets.set(top13, []);
    top13Buckets.get(top13)!.push(sid);
  }
  const clusterSizes = [...top13Buckets.values()].map(v => v.length).sort((a, b) => b - a);
  console.log(`Our ${activeSIDs.length} SIDs span ${top13Buckets.size} shiny-groups (of 8192 possible)`);
  console.log(`Cluster sizes: max=${clusterSizes[0]}, top5=[${clusterSizes.slice(0, 5).join(', ')}]`);
  console.log(`Groups with 2+ candidates: ${clusterSizes.filter(c => c > 1).length}`);

  // Key insight: for any specific PID, exactly 8 SIDs make it shiny,
  // and they all share top 13 bits. So P(our real SID is shiny) =
  // (# of our candidates in that 8-group) / (total candidates)
  // If cluster size is 1 (typical): P = 1/703 ≈ 0.14%
  // If cluster size is 2: P = 2/703 ≈ 0.28%
  // Baseline random: P = 8/65536 ≈ 0.012%
  // Wait — these aren't the same because our 703 candidates aren't uniformly distributed!
  // Our candidates are a specific subset of all 65536 SIDs.

  // Precise calculation: for a given PID, the 8 shiny SIDs are X, X^1, ..., X^7
  // where X = TID ^ pidH ^ pidL. How many of our 703 candidates fall in {X..X^7}?
  // If candidates are uniformly spread: E = 703*8/65536 ≈ 0.086 → usually 0, sometimes 1
  // So P(shiny for our real SID) ≈ P(real SID ∈ shiny set) = 8/65536 per PID
  // This is STILL 1/8192 — the multi-SID targeting can't change this.

  // BUT: multi-SID targeting doesn't change the PID — it changes which SEED we target.
  // For each seed, the advance window produces ~200 PIDs. The question is whether
  // we can find seeds where MORE of those PIDs align with our SID candidates.

  // ── Step 5: The real math ────────────────────────────────────────────
  console.log('\n── Probability Theory ──');

  // For the bare approach: pick random seed, random advance within window
  // P(shiny) = 8/65536 = 1/8192 (always, regardless of seed)
  console.log(`Bare hunt P(shiny per encounter): 8/65536 = 1/8192 = ${(8/65536*100).toFixed(4)}%`);

  // For multi-SID targeting with perfect timing:
  // We hit the exact seed we target. The game hits a specific advance A.
  // P(shiny) = P(PID at this (seed, A) is shiny for our real SID) = 8/65536
  // This is STILL 1/8192 per encounter!
  //
  // The schedule prioritizes seeds where MANY candidate SIDs have shiny advances.
  // But the real SID is one specific value. The probability that it's the
  // one that's shiny for this PID is always 8/65536.
  //
  // HOWEVER: what if we cycle through different seeds? Each seed's advance
  // produces a DIFFERENT PID. Over many attempts on different seeds, we're
  // testing different PIDs — but each test is still 1/8192 independently.
  //
  // The only advantage would come if:
  // (a) We can test MULTIPLE PIDs per encounter (we can't — only 1 starter)
  // (b) Our SID candidates are clustered such that certain PIDs have
  //     disproportionate coverage (the clustering analysis above shows this is minimal)

  // Let's VERIFY empirically by checking P(shiny) for top seeds
  console.log('\nEmpirical P(shiny) for top schedule seeds:');
  for (const entry of schedule.slice(0, 5)) {
    let shinyCount = 0;
    let totalChecks = 0;
    let seed = advanceSeed(entry.initialSeed, ADV_WINDOW.min);
    for (let adv = ADV_WINDOW.min; adv <= ADV_WINDOW.max; adv++) {
      const result = generateMethod1(seed, adv);
      for (const sid of activeSIDs) {
        totalChecks++;
        if (isShinyPID(TID, sid, result.pidHigh, result.pidLow)) {
          shinyCount++;
        }
      }
      seed = nextSeed(seed);
    }
    // P(shiny for random candidate SID at random advance) = shinyCount / totalChecks
    const pShiny = shinyCount / totalChecks;
    const advRange = ADV_WINDOW.max - ADV_WINDOW.min + 1;
    console.log(`  Seed 0x${entry.initialSeed.toString(16).padStart(4, '0')}: ${shinyCount} shiny slots / ${totalChecks} total = P=${(pShiny * 100).toFixed(4)}% (baseline: ${(8/65536*100).toFixed(4)}%)`);
    // Also: P(shiny | fixed advance, random SID) for each advance
  }

  // ── Step 6: Precompute shiny lookups for fast simulation ──────────────
  console.log('\nPrecomputing shiny lookup tables...');
  const t1 = Date.now();

  // For bare hunt: precompute all shiny (initSeed, advance) → Set<SID>
  // This avoids calling advanceSeed(1050 times) per encounter in the hot loop
  // Key: (initSeed << 16) | advance → array of shiny SIDs
  // Too much memory for all 65536×201 = 13M entries. Instead, precompute
  // the PRNG state at each (initSeed, advMin) so we only need ~1 nextSeed per advance.

  // Faster approach: for each initSeed, precompute the PID at a random advance,
  // then check shininess inline. The bottleneck is advanceSeed(initSeed, 1050).
  // We can precompute seed-at-advMin for all 65536 seeds in one pass.
  const seedAtAdvMin = new Uint32Array(65536);
  for (let s = 0; s <= 0xFFFF; s++) {
    seedAtAdvMin[s] = advanceSeed(s, ADV_WINDOW.min);
  }

  // For multi-SID deterministic: precompute seed at fixedAdv for top schedule entries
  const TOP_N = Math.min(500, schedule.length);
  const fixedAdv = Math.floor((ADV_WINDOW.min + ADV_WINDOW.max) / 2);
  const fixedAdvOffset = fixedAdv - ADV_WINDOW.min;

  // Precompute PID at (schedule[i].initialSeed, fixedAdv) for fast deterministic lookup
  interface PrecomputedPID { pidHigh: number; pidLow: number; }
  const detPIDs: PrecomputedPID[] = [];
  for (let i = 0; i < TOP_N; i++) {
    let seed = seedAtAdvMin[schedule[i].initialSeed];
    for (let j = 0; j < fixedAdvOffset; j++) seed = nextSeed(seed);
    const result = generateMethod1(seed, fixedAdv);
    detPIDs.push({ pidHigh: result.pidHigh, pidLow: result.pidLow });
  }

  console.log(`Precomputation done in ${Date.now() - t1}ms`);

  // ── Step 7: Monte Carlo simulation ───────────────────────────────────
  console.log(`\n── Monte Carlo: ${NUM_TRIALS.toLocaleString()} trials ──\n`);

  const bareResults: number[] = [];
  const multiJitterResults: number[] = [];
  const multiPerfectResults: number[] = [];
  const multiDetResults: number[] = [];

  for (let trial = 0; trial < NUM_TRIALS; trial++) {
    const realSID = pick(activeSIDs);

    // ── Bare: random seed, random advance ──
    {
      let enc = 0;
      while (enc < ENCOUNTER_CAP) {
        enc++;
        const rSeed = randInt(0, 0xFFFF);
        const advOffset = randInt(0, ADV_WINDOW.max - ADV_WINDOW.min);
        let seed = seedAtAdvMin[rSeed];
        for (let j = 0; j < advOffset; j++) seed = nextSeed(seed);
        const result = generateMethod1(seed, 0);
        if (isShinyPID(TID, realSID, result.pidHigh, result.pidLow)) break;
      }
      bareResults.push(enc);
    }

    // ── Multi-SID with timing jitter ──
    {
      let enc = 0;
      let idx = 0;
      while (enc < ENCOUNTER_CAP) {
        enc++;
        const entry = schedule[idx % TOP_N];
        const actualSeed = (entry.initialSeed + randInt(-TIMING_JITTER_SEEDS, TIMING_JITTER_SEEDS) + 0x10000) & 0xFFFF;
        const advOffset = randInt(0, ADV_WINDOW.max - ADV_WINDOW.min);
        let seed = seedAtAdvMin[actualSeed];
        for (let j = 0; j < advOffset; j++) seed = nextSeed(seed);
        const result = generateMethod1(seed, 0);
        if (isShinyPID(TID, realSID, result.pidHigh, result.pidLow)) break;
        idx++;
      }
      multiJitterResults.push(enc);
    }

    // ── Multi-SID with perfect timing, random advance ──
    {
      let enc = 0;
      let idx = 0;
      while (enc < ENCOUNTER_CAP) {
        enc++;
        const entry = schedule[idx % TOP_N];
        const advOffset = randInt(0, ADV_WINDOW.max - ADV_WINDOW.min);
        let seed = seedAtAdvMin[entry.initialSeed];
        for (let j = 0; j < advOffset; j++) seed = nextSeed(seed);
        const result = generateMethod1(seed, 0);
        if (isShinyPID(TID, realSID, result.pidHigh, result.pidLow)) break;
        idx++;
      }
      multiPerfectResults.push(enc);
    }

    // ── Multi-SID with perfect timing, deterministic advance ──
    // Uses precomputed PIDs — extremely fast
    {
      let enc = 0;
      let idx = 0;
      while (enc < ENCOUNTER_CAP) {
        enc++;
        const pid = detPIDs[idx % TOP_N];
        if (isShinyPID(TID, realSID, pid.pidHigh, pid.pidLow)) break;
        idx++;
      }
      multiDetResults.push(enc);
    }

    if ((trial + 1) % 1000 === 0) {
      process.stdout.write(`  ${(trial + 1).toLocaleString()}/${NUM_TRIALS.toLocaleString()} trials...\r`);
    }
  }

  // ── Results ──────────────────────────────────────────────────────────
  console.log('\n');
  printResults('Bare Hunt (random seed, random advance)', bareResults, BARE_CYCLE_S);
  console.log('');
  printResults(`Multi-SID (±${TIMING_JITTER_SEEDS} seed jitter, random advance)`, multiJitterResults, RNG_CYCLE_S);
  console.log('');
  printResults('Multi-SID (perfect timing, random advance)', multiPerfectResults, RNG_CYCLE_S);
  console.log('');
  printResults(`Multi-SID (perfect timing, fixed advance ${fixedAdv})`, multiDetResults, RNG_CYCLE_S);

  // ── Speedup ──────────────────────────────────────────────────────────
  const bMed = percentile(bareResults, 50);
  const jMed = percentile(multiJitterResults, 50);
  const pMed = percentile(multiPerfectResults, 50);
  const dMed = percentile(multiDetResults, 50);

  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  SPEEDUP SUMMARY                                                   ║');
  console.log('╠══════════════════════════════════════════════════════════════════════╣');
  const fmtRow = (label: string, med: number, cycle: number) => {
    const time = formatTime(med * cycle);
    const speedup = (bMed * BARE_CYCLE_S / (med * cycle));
    return `║  ${label.padEnd(40)} ${String(med).padStart(6)} enc  ${time.padStart(8)}  ${speedup.toFixed(2).padStart(5)}x ║`;
  };
  console.log(`║  ${'Approach'.padEnd(40)} ${'Median'.padStart(6)}    ${'Time'.padStart(8)}  ${'Speed'.padStart(5)}  ║`);
  console.log(`║  ${'─'.repeat(66)} ║`);
  console.log(fmtRow('Bare hunt', bMed, BARE_CYCLE_S));
  console.log(fmtRow(`Multi-SID (±${TIMING_JITTER_SEEDS} jitter)`, jMed, RNG_CYCLE_S));
  console.log(fmtRow('Multi-SID (perfect timing)', pMed, RNG_CYCLE_S));
  console.log(fmtRow(`Multi-SID (perfect + fixed adv)`, dMed, RNG_CYCLE_S));
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  // ── Final insight ────────────────────────────────────────────────────
  console.log('\n── Key Insight ──');
  const bareRate = 1 / mean(bareResults);
  const multiRate = 1 / mean(multiPerfectResults);
  if (Math.abs(bareRate - multiRate) / bareRate < 0.05) {
    console.log(`Per-encounter shiny rate is ~${(bareRate * 100).toFixed(4)}% for BOTH approaches.`);
    console.log('Multi-SID targeting does NOT improve per-encounter probability.');
    console.log('This is because P(shiny) = 8/65536 per PID, regardless of which');
    console.log('seed we target. The schedule optimizes for SID *coverage* across');
    console.log('the advance window, but we only test ONE advance per encounter.');
    console.log('\nTo actually improve odds, we would need to:');
    console.log('  1. Control the advance precisely (EON Timer-style)');
    console.log('  2. Know the SID (eliminates all uncertainty)');
    console.log('  3. Test multiple PIDs per encounter (not possible for starters)');
  } else {
    console.log(`Bare rate: 1 in ${Math.round(1/bareRate)}`);
    console.log(`Multi-SID rate: 1 in ${Math.round(1/multiRate)}`);
    console.log(`Multi-SID is ${(multiRate / bareRate).toFixed(2)}x better per encounter!`);
  }
}

function printResults(label: string, results: number[], cycleS: number) {
  const sorted = [...results].sort((a, b) => a - b);
  const avg = mean(results);
  const med = percentile(results, 50);
  const p25 = percentile(results, 25);
  const p75 = percentile(results, 75);
  const p90 = percentile(results, 90);
  const p99 = percentile(results, 99);
  const capped = results.filter(r => r >= ENCOUNTER_CAP).length;

  console.log(`  ${label}`);
  console.log(`  ${'─'.repeat(60)}`);
  console.log(`  Mean:   ${avg.toFixed(0)} enc (${formatTime(avg * cycleS)})`);
  console.log(`  Median: ${med} enc (${formatTime(med * cycleS)})`);
  console.log(`  P25:    ${p25} enc   P75: ${p75} enc   P90: ${p90} enc   P99: ${p99} enc`);
  console.log(`  Min: ${sorted[0]}   Max: ${sorted[sorted.length - 1]}${capped > 0 ? `   Capped: ${capped}` : ''}`);
}

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * p / 100);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function formatTime(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}min`;
  return `${(seconds / 3600).toFixed(1)}hr`;
}

main();
