/**
 * demo-reseed — the Crestwood Collection roster and the word lists the
 * generator draws from.
 *
 * Everything here is fictional. Names are common given names paired with
 * common surnames at random, so no entry corresponds to a person in any
 * real dataset. Email domains are RFC 2606 reserved (`example.com`,
 * `example.net`, `example.org`), which cannot receive mail, so a demo
 * visitor who copies an address out of the UI cannot reach anybody.
 *
 * Nothing from Rixey Manor appears here, and `rixeymanor.com` is refused
 * by an assertion in generate.ts rather than merely avoided by hand.
 */

import type { DemoWeddingSource } from './types'

/** The four Crestwood venues. Same ids as
 *  `src/lib/api/auth-helpers.ts` DEMO_VENUE_ALLOWLIST and
 *  `scripts/demo-repair.mjs` DEMO_VENUE_IDS. Repeated here because a
 *  plain script cannot import the Next.js server module. */
export interface DemoVenue {
  id: string
  name: string
  slug: string
  /** Fictional coordinator address for outbound signals. */
  coordinatorEmail: string
  /** Share of the roster. Hawthorne is heaviest, matching the existing
   *  `scripts/seed-demo-rich.ts` convention. */
  weight: number
  basePrice: number
  capacity: number
}

export const DEMO_VENUES: readonly DemoVenue[] = [
  {
    id: '22222222-2222-2222-2222-222222222201',
    name: 'Hawthorne Manor',
    slug: 'hawthorne-manor',
    coordinatorEmail: 'sarah@hawthornemanor.com',
    weight: 24,
    basePrice: 8500,
    capacity: 200,
  },
  {
    id: '22222222-2222-2222-2222-222222222202',
    name: 'Crestwood Farm',
    slug: 'crestwood-farm',
    coordinatorEmail: 'jake@crestwoodfarm.com',
    weight: 14,
    basePrice: 6500,
    capacity: 150,
  },
  {
    id: '22222222-2222-2222-2222-222222222203',
    name: 'The Glass House',
    slug: 'the-glass-house',
    coordinatorEmail: 'maya@theglasshouse.com',
    weight: 12,
    basePrice: 12000,
    capacity: 250,
  },
  {
    id: '22222222-2222-2222-2222-222222222204',
    name: 'Rose Hill Gardens',
    slug: 'rose-hill-gardens',
    coordinatorEmail: 'olivia@rosehillgardens.com',
    weight: 10,
    basePrice: 9500,
    capacity: 180,
  },
] as const

export const DEMO_VENUE_IDS: readonly string[] = DEMO_VENUES.map((v) => v.id)

/** The couple-portal hero. This `weddings.id` is pinned: the portal's
 *  demo cookie resolves to it (`src/lib/api/auth-helpers.ts`
 *  DEMO_WEDDING_ID, `src/lib/hooks/use-couple-context.ts`), and the
 *  checklist / guests / timeline seed rows in `supabase/seed.sql` are
 *  keyed to it. The reseed never deletes it. */
export const HERO_WEDDING_ID = '44444444-4444-4444-4444-444444000109'
export const HERO_VENUE_ID = '22222222-2222-2222-2222-222222222201'
export const HERO_PRIMARY_NAME = 'Chloe Martinez'
export const HERO_PARTNER_NAME = 'Ryan Brooks'
export const HERO_PRIMARY_EMAIL = 'chloe.martinez@example.com'
export const HERO_PARTNER_EMAIL = 'ryan.brooks@example.com'

/** Domains a generated address may use. RFC 2606, undeliverable. */
export const FICTIONAL_EMAIL_DOMAINS: readonly string[] = [
  'example.com',
  'example.net',
  'example.org',
]

/** Domains the generator refuses outright. Finding 5 of the 2026-09-08
 *  walk was a real venue inbox sitting in demo data. */
export const FORBIDDEN_EMAIL_FRAGMENTS: readonly string[] = [
  'rixeymanor',
  'honeybook.com',
  'gmail.com',
  'theknot.com',
  'weddingwire.com',
]

export const FIRST_NAMES: readonly string[] = [
  'Amara', 'Nadia', 'Priya', 'Imani', 'Lucia', 'Freya', 'Sadie', 'Rosalind',
  'Tamsin', 'Noor', 'Elowen', 'Marisol', 'Delphine', 'Wren', 'Anneke',
  'Sunniva', 'Thea', 'Clover', 'Odile', 'Ingrid', 'Saoirse', 'Yara',
  'Mireille', 'Briar', 'Solveig', 'Esme', 'Linnea', 'Zuri', 'Coralie',
  'Marguerite',
]

export const PARTNER_NAMES: readonly string[] = [
  'Theo', 'Kwame', 'Rafael', 'Bastian', 'Idris', 'Callum', 'Emeka', 'Soren',
  'Mateo', 'Anders', 'Fionn', 'Dmitri', 'Hugo', 'Tobias', 'Milo', 'Kaspar',
  'Osric', 'Leander', 'Nikolai', 'Emrys', 'Zephyr', 'Rune', 'Casimir',
  'Ilya', 'Amias', 'Barnaby', 'Cassius', 'Torin', 'Wilder', 'Ronan',
]

export const SURNAMES: readonly string[] = [
  'Ashcombe', 'Beaumont', 'Cardew', 'Delacroix', 'Eastwick', 'Fairholme',
  'Gallow', 'Hartsell', 'Ilminster', 'Jarrow', 'Kesteven', 'Lindqvist',
  'Marchetti', 'Norrington', 'Oakhurst', 'Penhallow', 'Quennell', 'Ravensworth',
  'Stroud', 'Tarrant', 'Underhill', 'Vasquez', 'Wexford', 'Yarborough',
  'Zabriskie', 'Ashworth', 'Bramwell', 'Costanza', 'Duquesne', 'Ellery',
]

/** Channel to `weddings.source`. The right-hand values are the CHECK list
 *  from migration 001; anything outside it fails the insert. */
export const SOURCE_FOR_CHANNEL: Record<string, DemoWeddingSource> = {
  knot: 'the_knot',
  weddingwire: 'weddingwire',
  instagram: 'instagram',
  website: 'website',
  gmail: 'referral',
  calendly: 'website',
}

/**
 * Heat points per event type, copied from `DEFAULT_POINTS` in
 * `src/lib/services/heat-mapping.ts`. Copied rather than imported because
 * that constant is module-private and this file must stay a pure,
 * dependency-free generator input.
 *
 * These values only drive the generator's PREDICTED heat, which is
 * advisory. The database is the truth: `wedding_heat` recomputes from the
 * `engagement_events` rows the applier writes, and `--verify` reads the
 * view back. If the two ever disagree, the view wins and this table is
 * stale.
 */
export const HEAT_POINTS: Record<string, number> = {
  initial_inquiry: 40,
  email_reply_received: 15,
  tour_requested: 15,
  high_commitment_signal: 10,
  family_mentioned: 5,
  high_specificity: 5,
  sustained_engagement: 5,
  tour_scheduled: 20,
  tour_completed: 25,
  contract_sent: 30,
  contract_viewed: 10,
  contract_signed: 50,
  pricing_page_view: 5,
  gallery_page_view: 3,
  availability_page_view: 5,
  social_engagement: 5,
  proposal_viewed: 20,
  tour_cancelled: -15,
  not_interested_signal: -25,
  marked_lost: -100,
}

/** Tier thresholds. Same numbers as `getTier` in heat-mapping.ts and the
 *  CASE arms in migration 321. */
export function tierForScore(score: number): 'hot' | 'warm' | 'cool' | 'cold' | 'frozen' {
  if (score >= 80) return 'hot'
  if (score >= 60) return 'warm'
  if (score >= 40) return 'cool'
  if (score >= 20) return 'cold'
  return 'frozen'
}
