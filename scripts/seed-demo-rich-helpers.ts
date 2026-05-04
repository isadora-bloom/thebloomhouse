/**
 * Helpers for seed-demo-rich.ts (Stream VVV).
 *
 * Pure functions: deterministic UUID generators (so the SQL is byte-stable
 * across runs and ON CONFLICT DO NOTHING is meaningful), a tiny seeded RNG,
 * and a small SQL-string escape helper.
 *
 * Why deterministic UUIDs: re-running the seed against a database that has
 * already absorbed it must be a no-op. ON CONFLICT (id) DO NOTHING needs
 * the same id to land on the same row every time. We allocate UUIDs from
 * shaped namespaces so a human reading the data can tell at a glance
 * which seed-stream produced a row:
 *
 *   33333333-1111-VVVV-PPPP-NNNNNNNNNNNN  (weddings — VVVV venue index, PPPP slot, NNNN serial)
 *   33333333-2222-VVVV-PPPP-NNNNNNNNNNNN  (people)
 *   33333333-3333-VVVV-WWWW-NNNNNNNNNNNN  (touchpoints)
 *   33333333-4444-VVVV-WWWW-NNNNNNNNNNNN  (interactions)
 *   33333333-5555-VVVV-WWWW-NNNNNNNNNNNN  (engagement_events)
 *   33333333-6666-VVVV-WWWW-NNNNNNNNNNNN  (tours)
 *   33333333-7777-VVVV-MMMM-SSSSSSSSSSSS  (marketing_spend)
 *   33333333-8888-VVVV-MMMM-SSSSSSSSSSSS  (source_attribution)
 *   33333333-9999-VVVV-WWWW-NNNNNNNNNNNN  (lost_deals)
 *
 * The `33333333` prefix marks "demo enrichment seed (Stream VVV)" so the
 * existing seed.sql rows (44444444-...) and dynamic production rows
 * (random uuids) are visually distinct.
 */

// ---------------------------------------------------------------------------
// Demo venue configuration — single source of truth for the seed.
// Heavier counts on Hawthorne; lighter on the others. Matches the YC-demo
// brief: rich Hawthorne for the default cookie-pinned view, believable
// variations on the others so cross-venue scope shows real data too.
// ---------------------------------------------------------------------------

export interface DemoVenue {
  id: string
  slug: string
  name: string
  index: number // 1-4, used in UUID slot VVVV
  booked: number
  inFlight: number
  lost: number
  /** 0..1 — share of 2025 marketing spend channels relative to Hawthorne */
  spendScale: number
}

export const DEMO_VENUES: readonly DemoVenue[] = [
  {
    id: '22222222-2222-2222-2222-222222222201',
    slug: 'hawthorne-manor',
    name: 'Hawthorne Manor',
    index: 1,
    booked: 30,
    inFlight: 15,
    lost: 5,
    spendScale: 1.0,
  },
  {
    id: '22222222-2222-2222-2222-222222222202',
    slug: 'crestwood-farm',
    name: 'Crestwood Farm',
    index: 2,
    booked: 18,
    inFlight: 8,
    lost: 3,
    spendScale: 0.5,
  },
  {
    id: '22222222-2222-2222-2222-222222222203',
    slug: 'the-glass-house',
    name: 'The Glass House',
    index: 3,
    booked: 12,
    inFlight: 6,
    lost: 2,
    spendScale: 0.3,
  },
  {
    id: '22222222-2222-2222-2222-222222222204',
    slug: 'rose-hill-gardens',
    name: 'Rose Hill Gardens',
    index: 4,
    booked: 10,
    inFlight: 5,
    lost: 1,
    spendScale: 0.2,
  },
]

// ---------------------------------------------------------------------------
// Tiny deterministic RNG — Mulberry32. Seeded per-stream so the same input
// always produces the same output. We want byte-stable SQL.
// ---------------------------------------------------------------------------

export function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)] as T
}

export function int(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min
}

// ---------------------------------------------------------------------------
// UUID assembly helpers. We construct deterministic UUIDs by packing
// venue index / slot / serial into the well-defined hex slots. UUID v4
// shape is 8-4-4-4-12 = 36 chars total.
// ---------------------------------------------------------------------------

/** Format an integer to a fixed-width zero-padded hex string. */
function hex(n: number, width: number): string {
  const s = n.toString(16)
  if (s.length > width) throw new Error(`hex overflow: ${n} > ${width} chars`)
  return s.padStart(width, '0')
}

/**
 * Build a deterministic seed UUID.
 *
 * Slots (8-4-4-4-12):
 *   33333333          marker for "demo enrichment seed VVV"
 *   $stream-tag       4-hex stream selector (1111 weddings, 2222 people, ...)
 *   $venueIdx         4-hex venue index (0001..0004)
 *   $slot             4-hex per-row slot
 *   $serial           12-hex serial (zero-padded)
 */
export function seedUuid(streamTag: number, venueIdx: number, slot: number, serial: number): string {
  return [
    '33333333',
    hex(streamTag, 4),
    hex(venueIdx, 4),
    hex(slot, 4),
    hex(serial, 12),
  ].join('-')
}

// Stream tags for each table — pick non-overlapping 4-hex values so the
// inspect-by-eye property holds.
export const STREAM_TAGS = {
  WEDDING: 0x1111,
  PERSON: 0x2222,
  TOUCHPOINT: 0x3333,
  INTERACTION: 0x4444,
  ENGAGEMENT: 0x5555,
  TOUR: 0x6666,
  SPEND: 0x7777,
  ATTRIBUTION: 0x8888,
  LOST_DEAL: 0x9999,
} as const

// ---------------------------------------------------------------------------
// SQL string escape — single source of truth so we never forget to double
// up apostrophes inside hand-built INSERTs.
// ---------------------------------------------------------------------------

export function sqlStr(s: string | null | undefined): string {
  if (s === null || s === undefined) return 'NULL'
  return `'${String(s).replace(/'/g, "''")}'`
}

export function sqlNum(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'NULL'
  return String(n)
}

export function sqlDate(d: Date): string {
  // 'YYYY-MM-DD' for date columns
  return `'${d.toISOString().slice(0, 10)}'`
}

export function sqlTimestamptz(d: Date): string {
  // ISO with explicit UTC marker
  return `'${d.toISOString()}'`
}

// ---------------------------------------------------------------------------
// Date helpers — minimal, no library imports. We need: pick a random day
// in a window, add days, format.
// ---------------------------------------------------------------------------

export function addDays(d: Date, n: number): Date {
  const out = new Date(d.getTime())
  out.setUTCDate(out.getUTCDate() + n)
  return out
}

export function addMonths(d: Date, n: number): Date {
  const out = new Date(d.getTime())
  out.setUTCMonth(out.getUTCMonth() + n)
  return out
}

export function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0))
}

// ---------------------------------------------------------------------------
// Fictional name pools for partner1/partner2 + last names.
// All fictional — the demo brief says "Sage / Mia / Jordan etc.".
// ---------------------------------------------------------------------------

export const FIRST_NAMES_A = [
  'Sage', 'Mia', 'Jordan', 'Avery', 'Riley', 'Cameron', 'Quinn', 'Rowan',
  'Harper', 'Sawyer', 'Parker', 'Logan', 'Hayden', 'Blake', 'Reese',
  'Skyler', 'Emerson', 'Finley', 'Phoenix', 'Sage', 'River', 'Wren',
  'Eden', 'Marlow', 'Kit', 'Linden', 'Tatum', 'Ellery', 'Indie', 'Larkin',
] as const

export const FIRST_NAMES_B = [
  'Alex', 'Taylor', 'Casey', 'Morgan', 'Jamie', 'Drew', 'Charlie',
  'Devon', 'Kendall', 'Robin', 'Shawn', 'Toby', 'Adrian', 'Bailey',
  'Dakota', 'Elliot', 'Frankie', 'Gray', 'Indigo', 'Jules', 'Kai',
  'Lane', 'Micah', 'Noel', 'Oakley', 'Peyton', 'Remi', 'Story',
  'Sam', 'Theo',
] as const

export const LAST_NAMES = [
  'Bennett', 'Hayes', 'Brooks', 'Carter', 'Diaz', 'Foster', 'Greene',
  'Hill', 'Iverson', 'Jenkins', 'Knight', 'Larson', 'Mitchell', 'Nguyen',
  'Olsen', 'Patel', 'Quinn', 'Reyes', 'Sanchez', 'Thompson', 'Underwood',
  'Vasquez', 'Walsh', 'Xiao', 'Young', 'Zimmerman', 'Anderson', 'Baker',
  'Chen', 'Davis',
] as const

// ---------------------------------------------------------------------------
// Source distribution per the brief. Returns one of the source enum keys
// or null. Distribution: ~50% honeybook (booked), ~20% the_knot, ~10%
// website, ~5% wedding_wire / weddingwire, ~5% venue_calculator, ~10% null.
// We use 'weddingwire' (no underscore) — that's the canonical key matching
// existing seed rows.
// ---------------------------------------------------------------------------

export type WeddingSource =
  | 'the_knot'
  | 'weddingwire'
  | 'website'
  | 'honeybook'
  | 'venue_calculator'
  | null

/** Pick a source for a BOOKED wedding (HoneyBook-heavy because that's
 *  where the contract gets signed in real life). */
export function pickBookedSource(rng: () => number): WeddingSource {
  const r = rng()
  if (r < 0.5) return 'honeybook'
  if (r < 0.7) return 'the_knot'
  if (r < 0.8) return 'website'
  if (r < 0.85) return 'weddingwire'
  if (r < 0.9) return 'venue_calculator'
  return null
}

/** Pick a source for IN-FLIGHT (inquiry/tour) — Knot-heavy because Knot
 *  inquiries are high-volume but low-conversion. */
export function pickInflightSource(rng: () => number): WeddingSource {
  const r = rng()
  if (r < 0.45) return 'the_knot'
  if (r < 0.6) return 'weddingwire'
  if (r < 0.75) return 'website'
  if (r < 0.85) return 'venue_calculator'
  if (r < 0.95) return 'honeybook'
  return null
}

/** Pick a source for a LOST wedding. Mostly Knot (high-volume churn). */
export function pickLostSource(rng: () => number): WeddingSource {
  const r = rng()
  if (r < 0.5) return 'the_knot'
  if (r < 0.7) return 'weddingwire'
  if (r < 0.85) return 'website'
  return null
}

// ---------------------------------------------------------------------------
// Email-from helpers — deterministic per-source addresses so the reply
// guard + tour-confirmation classifier have something to chew on.
// ---------------------------------------------------------------------------

export function fromEmailForSource(source: WeddingSource): string {
  switch (source) {
    case 'the_knot':
      return 'leads@theknot.com'
    case 'weddingwire':
      return 'leads@weddingwire.com'
    case 'website':
      return 'website@hawthornemanor.com' // venue's own domain — we'll override per-venue below
    case 'honeybook':
      return 'projects@honeybook.com'
    case 'venue_calculator':
      return 'contact@interactivecalculator.com'
    default:
      return 'unknown@example.com'
  }
}

/** Per-venue website-form sender (so different venues' website inquiries
 *  appear from their own domain). */
export function venueWebsiteEmail(slug: string): string {
  return `website@${slug.replace(/-/g, '')}.com`
}

// ---------------------------------------------------------------------------
// Inquiry-date allocator — spread across the last 18 months (relative to
// today, which is 2026-05-03 for this seed). We anchor on the seed file's
// fixed reference date so the seed is byte-stable across machines.
// ---------------------------------------------------------------------------

export const SEED_NOW = new Date(Date.UTC(2026, 4, 3, 12, 0, 0)) // 2026-05-03

/** Pick an inquiry timestamp uniformly across the past nMonths. */
export function pickInquiryDate(rng: () => number, nMonths = 18): Date {
  const window = nMonths * 30 // approximate days
  const offset = -Math.floor(rng() * window)
  return addDays(SEED_NOW, offset)
}

/** wedding_date is 6-12 months AFTER inquiry. Returns a date string only. */
export function pickWeddingDate(rng: () => number, inquiry: Date): Date {
  const offset = int(rng, 6 * 30, 12 * 30)
  return addDays(inquiry, offset)
}
