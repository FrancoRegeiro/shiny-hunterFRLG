import { ButtonSequence } from '../types';

// === FIRE RED SEQUENCES (FAST TEXT SPEED) ===
// Timings calibrated for normal speed (no turbo) — Switch-compatible

// After BIOS + Game Freak logo (handled by WAIT_BOOT), spam through intro
export const FIRE_RED_TITLE_SCREEN: ButtonSequence = [
  // Spam START+A to skip intro/title as fast as possible
  { action: 'mashA', count: 10, intervalMs: 400 },
  { action: 'press', keys: ['START'], holdMs: 50 },
  { action: 'wait', ms: 200 },
  { action: 'press', keys: ['START'], holdMs: 50 },
  { action: 'wait', ms: 200 },
  { action: 'press', keys: ['START'], holdMs: 50 },
  { action: 'wait', ms: 300 },
];

// Select CONTINUE from the menu
export const FIRE_RED_LOAD_SAVE: ButtonSequence = [
  { action: 'wait', ms: 200 },
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 200 },
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 2000 },
];

// Pick starter from pokeball (FAST TEXT) — works for all 3 starters
// Timing-sensitive — nickname prompt timing must not be shortened
export const FIRE_RED_STARTER_PICK: ButtonSequence = [
  // Phase 1: Dialogue + YES + animation starts
  // Fast text: A4 selects YES (~t=2.4s), animation runs during remaining A's
  { action: 'mashA', count: 7, intervalMs: 800 },

  // Phase 2: Wait for fanfare + nickname prompt
  // YES at ~t=2.4s, nickname ~7s after YES. mashA ends at t=5.6s → need ~4s
  { action: 'wait', ms: 2000 },

  // Phase 3: Decline nickname (B spam — harmless if fanfare still going)
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 400 },
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 400 },
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 400 },
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 400 },

  // Phase 4: Rival dialogue + pick — enough A to clear text, then move on
  { action: 'mashA', count: 5, intervalMs: 200 },
  { action: 'wait', ms: 1500 },
  { action: 'mashA', count: 8, intervalMs: 200 },
  { action: 'wait', ms: 200 },
];

// Open Party → Summary (tightened where safe, generous final wait for screen render)
export const FIRE_RED_OPEN_SUMMARY: ButtonSequence = [
  { action: 'press', keys: ['START'], holdMs: 50 },
  { action: 'wait', ms: 400 },
  // POKéMON (first option)
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 600 },
  // Select starter
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 400 },
  // SUMMARY
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 500 },
  // Safety A — then wait for summary screen to fully render + clear shiny verify
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 1300 },
];

// === LAPRAS GIFT SEQUENCE (Silph Co 7F) ===
// Pre-condition: saved in front of the Silph Co employee who gives Lapras.
// Must have already beaten rival on this floor.
//
// Dialogue from pokefirered decomp:
// 1. "Oh! Hi! You're not a ROCKET! You came to save us? Why, thank you!"  (A, A)
// 2. "I want you to have this POKéMON for saving us."  (A)
// 3. [givemon LAPRAS Lv25]
// 4. "[PLAYER] obtained a LAPRAS from the SILPH employee!" + fanfare (~3s)
// 5. "Would you like to give a nickname?" → B (NO)
// 6. "It's a LAPRAS. It's a very intelligent POKéMON..." (A×4 explanation text)
// 7. [setflag] done

export const FRLG_LAPRAS_INTERACT: ButtonSequence = [
  // Phase 1: Talk to NPC — 3 text boxes before receiving
  // "Oh! Hi! You're not a ROCKET!..." → "Why, thank you!" → "I want you to have this POKéMON"
  { action: 'mashA', count: 5, intervalMs: 800 },

  // Phase 2: "[PLAYER] obtained a LAPRAS!" + fanfare jingle (~3s)
  { action: 'wait', ms: 3000 },

  // Phase 3: "Would you like to give a nickname?" → NO
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 400 },
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 400 },
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 400 },

  // Phase 4: Post-nickname explanation text (4 text boxes)
  // "It's a LAPRAS. It's a very intelligent POKéMON."
  // "We kept it in our lab, but it will be much better off with you."
  // "I think you will be a good TRAINER for LAPRAS!"
  // "It's a good swimmer. It'll give you a lift across water!"
  { action: 'mashA', count: 6, intervalMs: 800 },

  // Wait for dialogue to fully close
  { action: 'wait', ms: 500 },
];

// === FOSSIL REVIVAL SEQUENCES (Cinnabar Lab) ===
// Pre-condition: saved in front of scientist AFTER giving fossil.
// Talk to scientist → receive revived Pokemon → decline nickname.

export const FRLG_FOSSIL_INTERACT: ButtonSequence = [
  // Phase 1: Talk to scientist and advance through dialogue
  // "Ah, [PLAYER]!" / "Your fossil Pokemon is fully restored!" / "Here, take it back!"
  // Fast text: each text box = 1 A press. Be generous (6 presses).
  { action: 'mashA', count: 6, intervalMs: 800 },

  // Phase 2: "[Player] received [POKEMON]!" + fanfare jingle (~3s)
  // Extra A presses during fanfare are harmless.
  { action: 'wait', ms: 3000 },

  // Phase 3: "Would you like to give a nickname?" → NO
  // B spam declines the nickname prompt
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 400 },
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 400 },
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 400 },
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 400 },

  // Small wait for dialogue to fully close
  { action: 'wait', ms: 500 },
];

// Open summary for a non-first party slot.
// Navigates DOWN to reach the target slot before selecting SUMMARY.
// The number of DOWN presses is controlled by the engine based on PARTY_SLOT config.
// This sequence handles slot 1 (no DOWN needed).
export const FIRE_RED_OPEN_SUMMARY_SLOT1: ButtonSequence = [
  { action: 'press', keys: ['START'], holdMs: 50 },
  { action: 'wait', ms: 400 },
  // POKéMON (first option)
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 600 },
  // Select Pokemon in slot
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 400 },
  // SUMMARY
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 500 },
  // Safety A + wait for summary screen render
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 1300 },
];

// Map of game → starter → sequences
export const SEQUENCES: Record<string, Record<string, {
  title: ButtonSequence;
  loadSave: ButtonSequence;
  pick: ButtonSequence;
  summary: ButtonSequence;
}>> = {
  'fire-red': {
    charmander: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      pick: FIRE_RED_STARTER_PICK,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    squirtle: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      pick: FIRE_RED_STARTER_PICK,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    bulbasaur: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      pick: FIRE_RED_STARTER_PICK,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
  },
  'leaf-green': {
    charmander: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      pick: FIRE_RED_STARTER_PICK,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    squirtle: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      pick: FIRE_RED_STARTER_PICK,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    bulbasaur: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      pick: FIRE_RED_STARTER_PICK,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
  },
};

// Static encounter sequences keyed by game → pokemon
// Used by StaticHuntEngine for fossil revival, gift Pokemon, etc.
export const STATIC_SEQUENCES: Record<string, Record<string, {
  title: ButtonSequence;
  loadSave: ButtonSequence;
  interact: ButtonSequence;
  summary: ButtonSequence;
}>> = {
  'fire-red': {
    // Gift Pokemon (Silph Co 7F — Lv25)
    lapras: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      interact: FRLG_LAPRAS_INTERACT,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    // Fossil Pokemon (Cinnabar Lab — Lv5)
    aerodactyl: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      interact: FRLG_FOSSIL_INTERACT,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    kabuto: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      interact: FRLG_FOSSIL_INTERACT,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    omanyte: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      interact: FRLG_FOSSIL_INTERACT,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
  },
  'leaf-green': {
    lapras: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      interact: FRLG_LAPRAS_INTERACT,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    aerodactyl: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      interact: FRLG_FOSSIL_INTERACT,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    kabuto: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      interact: FRLG_FOSSIL_INTERACT,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
    omanyte: {
      title: FIRE_RED_TITLE_SCREEN,
      loadSave: FIRE_RED_LOAD_SAVE,
      interact: FRLG_FOSSIL_INTERACT,
      summary: FIRE_RED_OPEN_SUMMARY,
    },
  },
};

export function getStaticSequences(game: string, target: string) {
  const gameSeqs = STATIC_SEQUENCES[game];
  if (!gameSeqs) throw new Error(`No static sequences defined for game: ${game}`);
  const seq = gameSeqs[target.toLowerCase()];
  if (!seq) throw new Error(`No static sequences defined for ${target} in ${game}`);
  return seq;
}

export function getSequences(game: string, target: string) {
  const gameSeqs = SEQUENCES[game];
  if (!gameSeqs) throw new Error(`No sequences defined for game: ${game}`);
  const seq = gameSeqs[target.toLowerCase()];
  if (!seq) throw new Error(`No sequences defined for ${target} in ${game}`);
  return seq;
}
