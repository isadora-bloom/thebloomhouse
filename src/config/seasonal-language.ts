/**
 * Bloom House: Seasonal Language Defaults
 *
 * Default seasonal imagery, phrases, and month mappings used by the
 * personality engine and intelligence context when a venue hasn't
 * configured custom seasonal content.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Season = 'spring' | 'summer' | 'fall' | 'winter'

export interface SeasonalDefaults {
  imagery: string
  phrases: string[]
  months: number[]
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const SEASONAL_DEFAULTS: Record<Season, SeasonalDefaults> = {
  spring: {
    imagery:
      'Dogwoods in bloom, fresh starts, gentle breezes carrying the scent of renewal. Everything feels possible in spring — the gardens wake up, the light softens, and there is a sense of new beginnings in the air.',
    phrases: [
      'Spring here is magical — everything comes alive',
      'The dogwoods are absolutely stunning this time of year',
      'Fresh blooms and gentle breezes — perfect for a celebration',
      'There is something so hopeful about a spring wedding',
      'The gardens are at their most romantic right now',
    ],
    months: [3, 4, 5],
  },
  summer: {
    imagery:
      'Golden hour stretching long into the evening, fireflies dancing at dusk, warm nights that invite guests to linger outdoors. Summer here is lush and alive — the kind of backdrop that makes every photo look effortless.',
    phrases: [
      'Summer evenings here are truly unforgettable',
      'Long golden hours perfect for photos',
      'The fireflies at dusk add a touch of magic',
      'Warm nights under the stars — it does not get better than this',
      'The grounds are at their most beautiful in summer',
    ],
    months: [6, 7, 8],
  },
  fall: {
    imagery:
      'Foliage turning amber and crimson, crisp air carrying the scent of harvest, candlelight glowing against rich autumn colors. Fall weddings here feel like stepping into a painting — warm, textured, and deeply romantic.',
    phrases: [
      'Fall is absolutely stunning here — the colors are unreal',
      'Crisp air and amber light — autumn weddings are our favorite',
      'The foliage creates a natural canopy of gold and crimson',
      'Harvest season adds such warmth to every celebration',
      'There is nothing like autumn light for photos',
    ],
    months: [9, 10, 11],
  },
  winter: {
    imagery:
      'Cozy candlelight, intimate gatherings by the fireside, evergreen touches against warm interiors. Winter weddings feel wonderfully intimate — fewer guests, richer moments, and a glow that only the colder months can bring.',
    phrases: [
      'Winter celebrations here feel magical and intimate',
      'Candlelight and warmth — so deeply romantic',
      'The venue glows in winter — cozy and inviting',
      'Fireside gatherings have a charm all their own',
      'Intimate and cozy — winter weddings are truly special',
    ],
    months: [12, 1, 2],
  },
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Returns the current season based on the current month.
 */
export function getCurrentSeason(): Season {
  const month = new Date().getMonth() + 1 // 1-indexed
  return getSeasonForMonth(month)
}

/**
 * Returns the season for a given month (1-12).
 */
export function getSeasonForMonth(month: number): Season {
  if (month >= 3 && month <= 5) return 'spring'
  if (month >= 6 && month <= 8) return 'summer'
  if (month >= 9 && month <= 11) return 'fall'
  return 'winter'
}
