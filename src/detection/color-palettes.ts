import { PokemonPalette } from '../types';

// Pokemon color signatures for shiny detection
// Each entry defines the hue ranges (in HSL degrees) that characterize
// the normal and shiny forms of a Pokemon.
//
// HSL hue ranges: 0=red, 30=orange, 60=yellow, 120=green, 240=blue, 300=purple
// satMin/valMin filter out background/shadow pixels (low saturation or value)

export const POKEMON_PALETTES: Record<string, PokemonPalette> = {
  charmander: {
    normal: {
      // Orange body with reddish-orange tones
      hueRanges: [
        { min: 10, max: 40 },  // orange body
      ],
      satMin: 0.3,
      valMin: 0.3,
    },
    shiny: {
      // Yellow/gold body
      hueRanges: [
        { min: 40, max: 65 },  // yellow/gold body
      ],
      satMin: 0.3,
      valMin: 0.3,
    },
  },

  squirtle: {
    normal: {
      // Blue body
      hueRanges: [
        { min: 190, max: 230 },
      ],
      satMin: 0.3,
      valMin: 0.3,
    },
    shiny: {
      // Lighter/greenish blue body
      hueRanges: [
        { min: 160, max: 195 },
      ],
      satMin: 0.3,
      valMin: 0.3,
    },
  },

  bulbasaur: {
    normal: {
      // Teal-green body
      hueRanges: [
        { min: 140, max: 180 },
      ],
      satMin: 0.25,
      valMin: 0.3,
    },
    shiny: {
      // Yellowy-green body
      hueRanges: [
        { min: 70, max: 140 },
      ],
      satMin: 0.25,
      valMin: 0.3,
    },
  },
};

export function getPalette(pokemon: string): PokemonPalette | null {
  return POKEMON_PALETTES[pokemon.toLowerCase()] || null;
}
