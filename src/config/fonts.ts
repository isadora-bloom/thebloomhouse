/**
 * Curated font pair definitions for venue branding.
 *
 * Venues pick a `font_pair` key stored in `venue_config`.
 * The couple-facing portal injects the corresponding Google Font imports
 * and CSS variables so the experience feels like "their" venue.
 *
 * Admin/Agent/Intel side always uses the default (playfair_inter).
 */

export interface FontPair {
  key: string
  label: string
  heading: { family: string; weight: string; googleFamily: string }
  body: { family: string; weight: string; googleFamily: string }
  description: string
}

export const FONT_PAIRS: Record<string, FontPair> = {
  playfair_inter: {
    key: 'playfair_inter',
    label: 'Classic Elegance',
    heading: { family: "'Playfair Display', serif", weight: '400;700', googleFamily: 'Playfair+Display:wght@400;700' },
    body: { family: "'Inter', sans-serif", weight: '400;500;600', googleFamily: 'Inter:wght@400;500;600' },
    description: 'The Bloom House default. Timeless serif headings with clean modern body text.',
  },
  cormorant_lato: {
    key: 'cormorant_lato',
    label: 'Refined Romance',
    heading: { family: "'Cormorant Garamond', serif", weight: '400;600', googleFamily: 'Cormorant+Garamond:wght@400;600' },
    body: { family: "'Lato', sans-serif", weight: '400;700', googleFamily: 'Lato:wght@400;700' },
    description: 'Delicate, high-contrast serif with a warm humanist sans. Feels editorial.',
  },
  libre_source: {
    key: 'libre_source',
    label: 'Modern Estate',
    heading: { family: "'Libre Baskerville', serif", weight: '400;700', googleFamily: 'Libre+Baskerville:wght@400;700' },
    body: { family: "'Source Sans 3', sans-serif", weight: '400;600', googleFamily: 'Source+Sans+3:wght@400;600' },
    description: 'Sturdy traditional serif with a versatile sans. Works for estates and manor houses.',
  },
  dm_nunito: {
    key: 'dm_nunito',
    label: 'Warm & Friendly',
    heading: { family: "'DM Serif Display', serif", weight: '400', googleFamily: 'DM+Serif+Display:wght@400' },
    body: { family: "'Nunito', sans-serif", weight: '400;600;700', googleFamily: 'Nunito:wght@400;600;700' },
    description: 'Approachable and rounded. Great for barn and garden venues.',
  },
  josefin_open: {
    key: 'josefin_open',
    label: 'Clean Contemporary',
    heading: { family: "'Josefin Sans', sans-serif", weight: '400;700', googleFamily: 'Josefin+Sans:wght@400;700' },
    body: { family: "'Open Sans', sans-serif", weight: '400;600', googleFamily: 'Open+Sans:wght@400;600' },
    description: 'All sans-serif, geometric headings. For modern/industrial venues.',
  },
  lora_raleway: {
    key: 'lora_raleway',
    label: 'Soft Sophistication',
    heading: { family: "'Lora', serif", weight: '400;700', googleFamily: 'Lora:wght@400;700' },
    body: { family: "'Raleway', sans-serif", weight: '400;600', googleFamily: 'Raleway:wght@400;600' },
    description: 'Gentle brushstroke serif with an elegant thin sans. Feels boutique.',
  },
}

/** Build a Google Fonts URL for a given font pair key */
export function getFontUrl(fontPairKey: string): string {
  const pair = FONT_PAIRS[fontPairKey] ?? FONT_PAIRS.playfair_inter
  return `https://fonts.googleapis.com/css2?family=${pair.heading.googleFamily}&family=${pair.body.googleFamily}&display=swap`
}

/** Get CSS variable values for a font pair */
export function getFontVars(fontPairKey: string): { heading: string; body: string } {
  const pair = FONT_PAIRS[fontPairKey] ?? FONT_PAIRS.playfair_inter
  return {
    heading: pair.heading.family,
    body: pair.body.family,
  }
}
