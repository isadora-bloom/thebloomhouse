/**
 * Prior touches for one couple, off the spine ribbon.
 *
 * The person-keyed `getPriorTouches` (deleted 2026-09-16, it lived at
 * src/lib/services/intel/prior-touches.ts) answered the same question from
 * `tangential_signals` + `interactions` + `tours`, joined through a `people`
 * row. That was the right shape when a person was the unit. The couple is the unit now, and every one of those
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
import { loadCoupleKeyForWedding } from './couple-key'

export interface CouplePriorTouch {
  kind: 'touchpoint' | 'fragment' | 'tour'
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
    /** Fragments promoted onto this couple by handle. A pre-identity signal
     *  (a comment, a follow) writes no touchpoint, so the promoted fragment
     *  IS the record of that touch. Always the couple reaching towards the
     *  venue, so it counts like inbound. */
    fragments: number
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

interface FragmentRow {
  channel: string
  identity_hint: string | null
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
    counts: { inbound: 0, unstamped: 0, fragments: 0, tours: 0 },
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

  // Promoted fragments: the comment or follow that arrived before the
  // couple had a name, bound to them the moment their handle turned up on
  // an inquiry (fragment-sweep-handles.ts). No touchpoint was ever written
  // for it, so this read is the only way it reaches the chip and Sage.
  const { data: promoted } = await supabase
    .from('fragments')
    .select('channel, identity_hint, occurred_at, raw_payload')
    .eq('venue_id', venueId)
    .eq('promoted_to_couple_id', coupleId)
    .lt('occurred_at', before)
    .order('occurred_at', { ascending: false })
    .limit(RIBBON_SCAN)
  let fragments = 0
  for (const f of (promoted ?? []) as FragmentRow[]) {
    fragments++
    touches.push({
      kind: 'fragment',
      source: f.channel,
      date: f.occurred_at,
      summary:
        payloadString(f.raw_payload, 'text')?.slice(0, 80) ??
        `${f.identity_hint ? `${f.identity_hint} ` : ''}engaged on ${f.channel.replace(/_/g, ' ')}`,
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
  const total = inbound + unstamped + fragments + tours
  const warmth: CouplePriorTouches['warmth'] = total === 0 ? 'cold' : total < 3 ? 'warm' : 'hot'

  return {
    coupleId,
    warmth,
    touches: touches.slice(0, MAX_TOUCHES_RETURNED),
    counts: { inbound, unstamped, fragments, tours },
  }
}

/**
 * The same ribbon, keyed by a person. `people` is the legacy unit; the
 * person's wedding is the bridge to the couple mirrored from it. Null when
 * the person has no wedding, or the wedding has no live couple: the caller
 * reads that as "nothing on file", not as an error.
 *
 * Migration 400 retired the tangential pool, so a pre-identity signal (an
 * Instagram comment with a handle and no email) is a fragment now, and it
 * reaches this reader by being promoted onto the couple when the handle
 * turns up on one. The person-keyed reader never saw those.
 */
export async function loadCouplePriorTouchesForPerson(
  supabase: SupabaseClient,
  venueId: string,
  personId: string,
  opts: { before?: string } = {},
): Promise<CouplePriorTouches | null> {
  if (!venueId || !personId) return null
  const { data: person } = await supabase
    // legacy-read-ok: the person id is the key the caller holds; the
    // wedding id on it is the bridge to the couple. No intelligence read.
    .from('people')
    .select('wedding_id')
    .eq('id', personId)
    .eq('venue_id', venueId)
    .maybeSingle()
  const weddingId = (person?.wedding_id as string | null | undefined) ?? null
  if (!weddingId) return null
  const key = await loadCoupleKeyForWedding(supabase, venueId, weddingId)
  if (!key) return null
  return loadCouplePriorTouches(supabase, venueId, key.coupleId, {
    before: opts.before,
    sourceWeddingId: key.sourceWeddingId,
  })
}

/** Channel keys as a person would say them. */
export function humanChannel(source: string): string {
  switch (source) {
    case 'gmail': return 'Email'
    case 'knot': case 'the_knot': return 'The Knot'
    case 'weddingwire': case 'wedding_wire': return 'WeddingWire'
    case 'instagram': return 'Instagram'
    case 'tiktok': return 'TikTok'
    case 'web': case 'website': return 'the website'
    case 'sms': return 'Text message'
    case 'tour': return 'Tour'
    default: {
      const s = source.replace(/_/g, ' ')
      return s.charAt(0).toUpperCase() + s.slice(1)
    }
  }
}

/**
 * The touches as one compact line for Sage's prompt context, channel
 * first: "Instagram: commented on the autumn ceremony post (Sep 7); The
 * Knot: inquiry (Sep 16)".
 */
export function narrateCoupleTouches(touches: Array<Pick<CouplePriorTouch, 'summary' | 'date' | 'source'>>): string {
  if (touches.length === 0) return ''
  return touches
    .map((t) => {
      const d = t.date ? new Date(t.date) : null
      const when = d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''
      return `${humanChannel(t.source)}: ${t.summary}${when ? ` (${when})` : ''}`
    })
    .join('; ')
}
