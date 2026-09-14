/**
 * The one nudge a couple sees on their own portal home.
 *
 * W52 of NOVEMBER-PLAN.md wave 7. Bloom knows, from the venue's own
 * booked weddings, roughly where the replies usually stand at each
 * distance from the day. A couple sitting well behind that has a problem
 * they cannot see, because they have nothing to compare against and no
 * reason to think a third of a guest list going quiet is unusual.
 *
 * The hard part is saying so without saying it.
 *
 * `src/config/prompts/couple-rules.ts` TENANT ISOLATION bans sharing a
 * venue-specific cross-couple pattern with a couple, in either direction:
 * "most couples here have sent theirs by now" leaks the cohort and
 * shames them in the same sentence. So the cohort decides ONLY whether
 * the nudge appears and how firm it sounds. The words the couple reads
 * are about their own guest list and their own calendar, and never
 * mention anybody else, a share, a median, or a comparison.
 *
 * That split is why the aggregate lives in an adapter and the copy lives
 * in the builder: `loadRsvpPaceCohort` returns numbers no couple ever
 * sees, and `buildRsvpNudge` returns words that carry none of them.
 *
 * Spine-only. Reads `couples` (venue's booked couples and their wedding
 * dates) and `guest_list` (RSVP state, keyed by the wedding id the spine
 * carries as `source_wedding_id`). Never reads `weddings`.
 *
 * Pure builder unit-tested in ./__tests__/couple-nudge.test.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

// ─────────────────────────────────────────────────────────────────────
// Bands
// ─────────────────────────────────────────────────────────────────────

export interface PaceBand {
  key: string
  /** Inclusive lower bound, days until the wedding. */
  fromDays: number
  /** Inclusive upper bound, or null for "everything further out". */
  toDays: number | null
}

/**
 * Distance-from-the-day bands. CHOSEN for this surface, and chosen coarse
 * on purpose: invitations tend to go out around two months before and
 * replies are usually asked for around a month before, so the interesting
 * boundaries are roughly there. Nothing in the spine records when a venue
 * tells its couples to send invitations, so a finer split would be a
 * guess wearing a threshold's clothes.
 */
export const PACE_BANDS: readonly PaceBand[] = [
  { key: 'final-month', fromDays: 0, toDays: 30 },
  { key: 'two-months', fromDays: 31, toDays: 60 },
  { key: 'four-months', fromDays: 61, toDays: 120 },
  { key: 'further-out', fromDays: 121, toDays: null },
]

export function bandFor(daysUntil: number): PaceBand | null {
  if (daysUntil < 0) return null
  return (
    PACE_BANDS.find((b) => daysUntil >= b.fromDays && (b.toDays === null || daysUntil <= b.toDays)) ??
    null
  )
}

/** Weddings a band needs before its median is worth acting on. CHOSEN:
 *  below five, the "usual" is one couple's admin habits. */
export const MIN_WEDDINGS_PER_BAND = 5

/** Guests a wedding needs before it counts towards a band. A four-person
 *  elopement replies in a day and would drag every median upwards. */
export const MIN_GUESTS_PER_WEDDING = 10

// ─────────────────────────────────────────────────────────────────────
// The cohort read. None of this reaches a couple.
// ─────────────────────────────────────────────────────────────────────

export interface BandPace {
  band: string
  /** Weddings behind the figure. */
  n: number
  enoughData: boolean
  /** Median share of guests replied, 0-1. Null when `enoughData` is
   *  false — never a fake zero. */
  medianRepliedShare: number | null
}

export interface RsvpPaceCohort {
  bands: BandPace[]
  generatedAt: string
}

interface RawCoupleRow {
  source_wedding_id: string | null
  wedding_date: string | null
}

interface RawGuestRow {
  wedding_id: string | null
  rsvp_status: string | null
}

const COUPLE_FETCH_LIMIT = 5000
const GUEST_FETCH_LIMIT = 50000

/** A reply is any state that is not still waiting. "Maybe" is a reply:
 *  the guest answered, they are just undecided. */
function hasReplied(status: string | null): boolean {
  const s = (status ?? '').trim().toLowerCase()
  return s.length > 0 && s !== 'pending'
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function daysUntil(weddingDateIso: string | null | undefined, now: number): number | null {
  if (!weddingDateIso) return null
  const t = Date.parse(weddingDateIso.length === 10 ? `${weddingDateIso}T12:00:00Z` : weddingDateIso)
  if (!Number.isFinite(t)) return null
  return Math.round((t - now) / 86_400_000)
}

function emptyCohort(): RsvpPaceCohort {
  return {
    bands: PACE_BANDS.map((b) => ({ band: b.key, n: 0, enoughData: false, medianRepliedShare: null })),
    generatedAt: new Date().toISOString(),
  }
}

/**
 * Where the venue's guest lists usually stand at each distance from the
 * day. Injectable client so the unit test drives it with a fake.
 *
 * Aggregate only: it returns four medians and four counts, and not one
 * row that could be traced to a couple. Nothing here is ever rendered to
 * a couple; it only decides whether `buildRsvpNudge` speaks.
 */
export async function loadRsvpPaceCohort(
  supabase: SupabaseClient,
  venueId: string,
  now: number,
  excludeWeddingId?: string | null,
): Promise<RsvpPaceCohort> {
  if (!venueId) return emptyCohort()

  const { data: coupleData, error: coupleErr } = await supabase
    .from('couples')
    .select('source_wedding_id, wedding_date')
    .eq('venue_id', venueId)
    .eq('lifecycle_state', 'booked')
    .is('merged_into_id', null)
    .limit(COUPLE_FETCH_LIMIT)
  if (coupleErr) throw new Error(`loadRsvpPaceCohort: couples ${coupleErr.message}`)

  // Wedding id -> which band that wedding sat in. A couple's own wedding
  // is excluded so the comparison is never partly against themselves.
  const bandByWedding = new Map<string, string>()
  for (const c of (coupleData ?? []) as RawCoupleRow[]) {
    const wid = c.source_wedding_id
    if (!wid || wid === excludeWeddingId) continue
    const d = daysUntil(c.wedding_date, now)
    if (d === null) continue
    const band = bandFor(d)
    if (band) bandByWedding.set(wid, band.key)
  }

  if (bandByWedding.size === 0) return emptyCohort()

  const { data: guestData, error: guestErr } = await supabase
    .from('guest_list')
    .select('wedding_id, rsvp_status')
    .eq('venue_id', venueId)
    .limit(GUEST_FETCH_LIMIT)
  if (guestErr) throw new Error(`loadRsvpPaceCohort: guest_list ${guestErr.message}`)

  const tally = new Map<string, { total: number; replied: number }>()
  for (const g of (guestData ?? []) as RawGuestRow[]) {
    const wid = g.wedding_id
    if (!wid || !bandByWedding.has(wid)) continue
    const t = tally.get(wid) ?? { total: 0, replied: 0 }
    t.total++
    if (hasReplied(g.rsvp_status)) t.replied++
    tally.set(wid, t)
  }

  const sharesByBand = new Map<string, number[]>()
  for (const [wid, t] of tally) {
    if (t.total < MIN_GUESTS_PER_WEDDING) continue
    const band = bandByWedding.get(wid)
    if (!band) continue
    const list = sharesByBand.get(band) ?? []
    list.push(t.replied / t.total)
    sharesByBand.set(band, list)
  }

  const bands: BandPace[] = PACE_BANDS.map((b) => {
    const shares = sharesByBand.get(b.key) ?? []
    const enoughData = shares.length >= MIN_WEDDINGS_PER_BAND
    return {
      band: b.key,
      n: shares.length,
      enoughData,
      medianRepliedShare: enoughData ? median(shares) : null,
    }
  })

  return { bands, generatedAt: new Date().toISOString() }
}

export async function getRsvpPaceCohort(
  venueId: string,
  now: number,
  excludeWeddingId?: string | null,
): Promise<RsvpPaceCohort> {
  if (!venueId) return emptyCohort()
  const { createServiceClient } = await import('@/lib/supabase/service')
  return loadRsvpPaceCohort(createServiceClient(), venueId, now, excludeWeddingId)
}

// ─────────────────────────────────────────────────────────────────────
// The nudge. This is the only part a couple reads.
// ─────────────────────────────────────────────────────────────────────

export interface CoupleNudge {
  /** Short label above the line. */
  label: string
  /** The nudge itself. About their own guest list, never about anybody
   *  else's, and never a number that came out of the cohort. */
  body: string
  cta: string
  href: string
  tone: 'gentle' | 'firm'
}

export interface RsvpNudgeInput {
  /** Their own wedding date. */
  weddingDate: string | null | undefined
  /** Their own guest list. */
  guestsTotal: number
  guestsReplied: number
  cohort: RsvpPaceCohort
  now: number
}

/** How far behind the usual pace a couple has to be before the nudge is
 *  worth interrupting them for. CHOSEN: a tenth is inside the noise of a
 *  small guest list, so the bar is a fifth. */
export const BEHIND_BY = 0.2

/** How far behind before the nudge stops being an aside. CHOSEN: at half
 *  the usual pace, the guest list is the thing standing between them and
 *  a seating plan. */
export const WELL_BEHIND_BY = 0.4

/**
 * Pure. Decides whether to nudge and what to say.
 *
 * Returns null, and the card renders nothing, when: the wedding date is
 * unknown, the day has passed, the guest list is too small to say
 * anything about, the venue's own history is too thin to know what
 * "behind" means, or they are not behind. Silence is the default.
 *
 * The cohort figure is used in the comparison on the line above the copy
 * and appears nowhere in the copy itself. That is the whole point of this
 * function.
 */
export function buildRsvpNudge(input: RsvpNudgeInput): CoupleNudge | null {
  const days = daysUntil(input.weddingDate, input.now)
  if (days === null || days < 0) return null
  if (input.guestsTotal < MIN_GUESTS_PER_WEDDING) return null

  const band = bandFor(days)
  if (!band) return null

  const pace = input.cohort.bands.find((b) => b.band === band.key)
  if (!pace || !pace.enoughData || pace.medianRepliedShare === null) return null

  const ourShare = input.guestsReplied / input.guestsTotal
  const gap = pace.medianRepliedShare - ourShare
  if (gap < BEHIND_BY) return null

  const waiting = input.guestsTotal - input.guestsReplied
  const tone: CoupleNudge['tone'] = gap >= WELL_BEHIND_BY ? 'firm' : 'gentle'

  const whenPhrase =
    days === 0
      ? 'today'
      : days === 1
        ? 'tomorrow'
        : days <= 31
          ? `in ${days} days`
          : days <= 60
            ? 'in a couple of months'
            : 'later in the year'

  const body =
    tone === 'firm'
      ? `${waiting} of your ${input.guestsTotal} guests still have not said yes or no, and the day is ${whenPhrase}. Chasing them now is the kindest thing you can do to your own seating plan.`
      : `${waiting} of your ${input.guestsTotal} guests have not replied yet. A short reminder now usually does it, and it keeps the numbers from bunching up later.`

  return {
    label: 'Your guest list',
    body,
    cta: 'Open your guest list',
    href: '/guests',
    tone,
  }
}
