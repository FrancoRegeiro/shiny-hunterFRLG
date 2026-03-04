import { SpriteRegion } from '../types';

// GBA native resolution: 240x160
// These regions define where Pokemon sprites appear on different screens

export const SUMMARY_SPRITE_REGIONS: Record<string, SpriteRegion> = {
  // Fire Red/Leaf Green — Summary screen shows a 64x64 sprite on the left
  'fire-red': { x: 8, y: 24, width: 64, height: 64 },
  'leaf-green': { x: 8, y: 24, width: 64, height: 64 },

  // Ruby/Sapphire/Emerald — similar layout
  'ruby': { x: 8, y: 24, width: 64, height: 64 },
  'sapphire': { x: 8, y: 24, width: 64, height: 64 },
  'emerald': { x: 8, y: 24, width: 64, height: 64 },
};

export const BATTLE_SPRITE_REGIONS: Record<string, SpriteRegion> = {
  // Opponent's Pokemon in battle (right side of screen)
  'fire-red': { x: 144, y: 16, width: 64, height: 64 },
  'leaf-green': { x: 144, y: 16, width: 64, height: 64 },
};

export function getSummarySpriteRegion(game: string): SpriteRegion {
  return SUMMARY_SPRITE_REGIONS[game] || SUMMARY_SPRITE_REGIONS['fire-red'];
}

export function getBattleSpriteRegion(game: string): SpriteRegion {
  return BATTLE_SPRITE_REGIONS[game] || BATTLE_SPRITE_REGIONS['fire-red'];
}
