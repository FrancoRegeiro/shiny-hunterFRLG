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
      // Blue/cyan body — dominant hues 195° and 215°
      hueRanges: [
        { min: 200, max: 230 },  // blue peak
        { min: 155, max: 170 },  // teal accents unique to normal
      ],
      satMin: 0.3,
      valMin: 0.3,
    },
    shiny: {
      // Shiny Squirtle: body shifts to 190° (from 195°+215° split)
      // Key differentiator: gains green shell accents (80-95°)
      hueRanges: [
        { min: 75, max: 100 },   // green accents (unique to shiny)
      ],
      satMin: 0.25,
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
  // Fossil Pokemon
  aerodactyl: {
    normal: {
      // Purple/gray body with blue-purple wing membranes
      hueRanges: [
        { min: 250, max: 290 },  // purple body/wings
      ],
      satMin: 0.15,
      valMin: 0.3,
    },
    shiny: {
      // Pink/magenta body — shiny Aerodactyl is distinctly pink
      hueRanges: [
        { min: 300, max: 340 },  // pink/magenta
      ],
      satMin: 0.2,
      valMin: 0.3,
    },
  },

  kabuto: {
    normal: {
      // Brown/tan shell with dark accents
      hueRanges: [
        { min: 20, max: 45 },  // brown/tan
      ],
      satMin: 0.2,
      valMin: 0.25,
    },
    shiny: {
      // Green shell — shiny Kabuto is distinctly green
      hueRanges: [
        { min: 80, max: 150 },  // green
      ],
      satMin: 0.2,
      valMin: 0.25,
    },
  },

  // Gift Pokemon
  lapras: {
    normal: {
      // Blue body with gray/blue shell
      hueRanges: [
        { min: 200, max: 240 },  // blue body
      ],
      satMin: 0.2,
      valMin: 0.3,
    },
    shiny: {
      // Purple/violet body — shiny Lapras is distinctly purple
      hueRanges: [
        { min: 260, max: 310 },  // purple/violet
      ],
      satMin: 0.2,
      valMin: 0.3,
    },
  },

  omanyte: {
    normal: {
      // Blue/cyan shell
      hueRanges: [
        { min: 190, max: 240 },  // blue/cyan
      ],
      satMin: 0.2,
      valMin: 0.3,
    },
    shiny: {
      // Purple shell — shiny Omanyte is purple/violet
      hueRanges: [
        { min: 260, max: 310 },  // purple/violet
      ],
      satMin: 0.2,
      valMin: 0.3,
    },
  },

  // Wild Pokemon
  pikachu: {
    normal: {
      // Yellow body
      hueRanges: [
        { min: 40, max: 60 },  // yellow
      ],
      satMin: 0.4,
      valMin: 0.4,
    },
    shiny: {
      // Deeper orange-gold — shiny Pikachu is a darker/richer yellow-orange
      hueRanges: [
        { min: 25, max: 45 },  // orange-gold
      ],
      satMin: 0.4,
      valMin: 0.4,
    },
  },

  nidoranm: {
    normal: {
      // Purple/violet body
      hueRanges: [
        { min: 270, max: 310 },  // purple
      ],
      satMin: 0.2,
      valMin: 0.3,
    },
    shiny: {
      // Blue/teal body — shiny Nidoran♂ turns blue
      hueRanges: [
        { min: 180, max: 220 },  // blue/teal
      ],
      satMin: 0.2,
      valMin: 0.3,
    },
  },

  nidoranf: {
    normal: {
      // Blue/teal body
      hueRanges: [
        { min: 190, max: 230 },  // blue/teal
      ],
      satMin: 0.2,
      valMin: 0.3,
    },
    shiny: {
      // Purple/pink body — shiny Nidoran♀ turns purple/pink
      hueRanges: [
        { min: 280, max: 330 },  // purple/pink
      ],
      satMin: 0.2,
      valMin: 0.3,
    },
  },

  // Casino Pokemon
  dratini: {
    normal: {
      // Blue/periwinkle body
      hueRanges: [
        { min: 210, max: 250 },  // blue/periwinkle
      ],
      satMin: 0.2,
      valMin: 0.3,
    },
    shiny: {
      // Pink/magenta body — shiny Dratini is distinctly pink
      hueRanges: [
        { min: 300, max: 340 },  // pink/magenta
      ],
      satMin: 0.2,
      valMin: 0.3,
    },
  },
};

export function getPalette(pokemon: string): PokemonPalette | null {
  return POKEMON_PALETTES[pokemon.toLowerCase()] || null;
}
