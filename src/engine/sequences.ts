import { ButtonSequence } from '../types';

// Fire Red — Charmander starter pick from Oak's lab
// Precondition: save state with player standing in front of Charmander's pokeball
export const FIRE_RED_CHARMANDER_PICK: ButtonSequence = [
  // === PICK STARTER ===
  // Interact with the pokeball
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 400 },

  // Oak's dialogue ("So, you want CHARMANDER?", etc.)
  { action: 'mashA', count: 12, intervalMs: 250 },
  { action: 'wait', ms: 300 },

  // Confirm "Yes" to take Charmander
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 600 },

  // Receive animation + "nickname?" → decline
  { action: 'mashA', count: 5, intervalMs: 250 },
  { action: 'wait', ms: 200 },
  // "No" is selected by default on nickname prompt — press A (or B to decline)
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 300 },

  // Remaining post-receive dialogue
  { action: 'mashA', count: 5, intervalMs: 250 },
  { action: 'wait', ms: 500 },
];

// Open the Party menu and navigate to Summary screen
export const FIRE_RED_OPEN_SUMMARY: ButtonSequence = [
  // Open start menu
  { action: 'press', keys: ['START'], holdMs: 50 },
  { action: 'wait', ms: 400 },

  // Select "POKéMON" (first option in the menu)
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 400 },

  // Select Charmander (only Pokemon in party)
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 300 },

  // Select "SUMMARY" from the sub-menu
  { action: 'press', keys: ['A'], holdMs: 50 },
  { action: 'wait', ms: 600 },
];

// Close out of menus and back to overworld (for reset)
export const FIRE_RED_CLOSE_MENUS: ButtonSequence = [
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 200 },
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 200 },
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 200 },
  { action: 'press', keys: ['B'], holdMs: 50 },
  { action: 'wait', ms: 200 },
];

// Map of game → starter → sequences
export const SEQUENCES: Record<string, Record<string, { pick: ButtonSequence; summary: ButtonSequence }>> = {
  'fire-red': {
    charmander: { pick: FIRE_RED_CHARMANDER_PICK, summary: FIRE_RED_OPEN_SUMMARY },
    squirtle: { pick: FIRE_RED_CHARMANDER_PICK, summary: FIRE_RED_OPEN_SUMMARY }, // Same flow, different pokeball position
    bulbasaur: { pick: FIRE_RED_CHARMANDER_PICK, summary: FIRE_RED_OPEN_SUMMARY },
  },
  'leaf-green': {
    charmander: { pick: FIRE_RED_CHARMANDER_PICK, summary: FIRE_RED_OPEN_SUMMARY },
    squirtle: { pick: FIRE_RED_CHARMANDER_PICK, summary: FIRE_RED_OPEN_SUMMARY },
    bulbasaur: { pick: FIRE_RED_CHARMANDER_PICK, summary: FIRE_RED_OPEN_SUMMARY },
  },
};

export function getSequences(game: string, target: string) {
  const gameSeqs = SEQUENCES[game];
  if (!gameSeqs) throw new Error(`No sequences defined for game: ${game}`);
  const seq = gameSeqs[target.toLowerCase()];
  if (!seq) throw new Error(`No sequences defined for ${target} in ${game}`);
  return seq;
}
