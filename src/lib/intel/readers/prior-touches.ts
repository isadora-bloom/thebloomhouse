/**
 * Prior touches for one couple, off the spine ribbon.
 *
 * The person-keyed `getPriorTouches` (src/lib/services/intel/prior-touches.ts)
 * answers the same question from `tangential_signals` + `interactions` +
 * `tours`, joined through a `people` row. That was the right shape when a
 * person was the unit. The couple is the unit now, and every one of those
 * signals lands on `touchpoints` as it arrives, so the ribbon already IS
 * the prior-touch list: the social like, the storefront view, the Knot
 * message and the email are rows in one table, in order, already bound to
 * the couple by the linker.
 *
 * Reading the ribbon instead of re-joining three legacy tables also fixes
 * a quiet under-count: a signal that arrived before the couple had a
 * `people` row had no `matched_person_id`, so the person-keyed reader
 * never saw it, and the panel said "no prior touches" about a couple with
 * eight of them.
 *
 * Shape note: the returned summary matches `PriorTouchSummary` field for
 * field except that it is keyed on `coupleId`, because that is what it
 * was actually looked up by. The panel only reads `touches`, so nothing
 * on screen changes except the numbers getting better.
 *
 * Injectable client, no service-role import, no network. Unit-tested in
 * ./__tests__/prior-touches.test.ts against the in-memory fake.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface CouplePriorTouch {
  kind: 'touchpoint' | 'tour'
  /** Spine channel, or 'tour'. Rendered through the shared source label. */
  source: string
  /** ISO. */
  date: string
  summary: string
}

export interface CouplePriorTouches {
  coupleId: string
  warmth: 'cold' | 'warm' | 'hot'
  touches: CouplePriorTouch[]
  counts: {
    /** Inbound ribbon entries. The couple reaching towards the venue. */
    inbound: number
    /** Ribbon entries with no write-time direction stamp (migration 381).
     *  Listed, but never counted as inbound — direction is not inferred. */
    unstamped: number
    tours: number
  }
}

const MAX_TOUCHES_RETURNED = 12
/** Ribbon pull cap. A couple with more than this many touchpoints is
 *  already far past "warm", so the extra rows change no answer. */
const RIBBON_SCAN = 200

interface RibbonRow {
  id: string
  channel: string
  action_type: string
  direction: string | null
  occurred_at: string
  raw_payload: Record<string, unknown> | null
}

interface TourRow {
  scheduled_at: string | null
  tour_type: string | null
  outcome: string | null
}

function payloadString(raw: Record<string, unknown> | null, key: string): string | null {
  if (!raw) return null
  const v = raw[key]
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

function humanAction(channel: string, actionType: string): string {
  const verb = actionType.replace(/_/g, ' ')
  const where = channel.replace(/_/g, ' ')
  return `${verb.charAt(0).toUpperCase()}${verb.slice(1)} on ${where}`
}

/**
 * Every prior touch on one couple, venue-scoped, before `before`.
 *
 * `sourceWeddingId` is optional and only used to pick up tours, which are
 * still keyed on the wedding id. When it is null the tour count is 0 and
 * the summary says so by omission rather than by guessing.
 */
export async function loadCouplePriorTouches(
  supabase: SupabaseClient,
  venueId: string,
  coupleId: string,
  opts: { before?: string; sourceWeddingId?: string | null } = {},
): Promise<CouplePriorTouches> {
  const empty: CouplePriorTouches = {
    coupleId,
    warmth: 'cold',
    touches: [],
    counts: { inbound: 0, unstamped: 0, tours: 0 },
  }
  if (!venueId || !coupleId) return empty

  const before = opts.before ?? new Date().toISOString()

  const { data: ribbon } = await supabase
    .from('touchpoints')
    .select('id, channel, action_type, direction, occurred_at, raw_payload')
    .eq('venue_id', venueId)
    .eq('couple_id', coupleId)
    .lt('occurred_at', before)
    .order('occurred_at', { ascending: false })
    .limit(RIBBON_SCAN)

  const touches: CouplePriorTouch[] = []
  let inbound = 0
  let unstamped = 0

  for (const r of (ribbon ?? []) as RibbonRow[]) {
    // Outbound is venue activity. A twelve-step nurture sequence going
    // out is not the couple reaching towards us, and counting it as
    // warmth is how a cold lead came to look hot.
    if (r.direction === 'outbound') continue
    if (r.direction === 'inbound') inbound++
    else unstamped++
    touches.push({
      kind: 'touchpoint',
      source: r.channel,
      date: r.occurred_at,
      summary:
        payloadString(r.raw_payload, 'subject') ??
        payloadString(r.raw_payload, 'body_preview')?.slice(0, 80) ??
        humanAction(r.channel, r.action_type),
    })
  }

  let tours = 0
  if (opts.sourceWeddingId) {
    const { data: tourRows } = await supabase
      .from('tours')
      .select('scheduled_at, tour_type, outcome')
      .eq('venue_id', venueId)
      .eq('wedding_id', opts.sourceWeddingId)
      .lt('scheduled_at', before)
      .order('scheduled_at', { ascending: false })
    for (const t of (tourRows ?? []) as TourRow[]) {
      if (!t.scheduled_at) continue
      tours++
      touches.push({
        kind: 'tour',
        source: 'tour',
        date: t.scheduled_at,
        summary: `${t.tour_type ?? 'Tour'}${t.outcome ? ` — ${t.outcome}` : ''}`,
      })
    }
  }

  touches.sort((a, b) => (b.date || '').localeCompare(a.date || ''))

  // Same warmth ladder the person-keyed reader used, so the chip does
  // not change meaning when the source underneath it changes.
  const total = inbound + unstamped + tours
  const warmth: CouplePriorTouches['warmth'] = total === 0 ? 'cold' : total < 3 ? 'warm' : 'hot'

  return {
    coupleId,
    warmth,
    touches: touches.slice(0, MAX_TOUCHES_RETURNED),
    counts: { inbound, unstamped, tours },
  }
}
