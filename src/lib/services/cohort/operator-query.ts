/**
 * Cohort-action executor — deterministic, no LLM.
 *
 * Takes a CohortQuery (the structured shape `lib/services/brain/cohort-
 * query.ts` produces from the operator's natural-language input) and
 * returns a typed CoupleListItem[] suitable for the verification UI.
 *
 * Step 2 of the cohort-action chain (BLOOM-TEST-QUESTIONS.md Q37). The
 * brain interprets intent; this executor runs the query. NO LLM here —
 * the executor must be auditable + reproducible against the same inputs.
 *
 * W2 spine migration (2026-09)
 * ----------------------------
 * This ran entirely off the legacy stack: `weddings` for lifecycle and
 * source, `people` for names, `interactions` for the no-reply anchor.
 * Meanwhile the cohort module beside it (`data.ts`) had been reading the
 * identity spine for months, so the same operator asking the same
 * question through two doors got two answers.
 *
 * It now reads `couples` / `touchpoints` / `couple_progression_events` /
 * `tours`, the same rows the canonical readers use, and follows
 * `data.ts` as the pattern.
 *
 * Two things deliberately did NOT change, because callers depend on them:
 *
 *   1. `CoupleListItem.weddingId` is still a wedding id. The next step in
 *      the chain (`bulkDraftFollowUps`) drafts against weddings, so the
 *      executor resolves each spine couple back through
 *      `couples.source_wedding_id` and skips couples that have no
 *      mirrored wedding — they cannot be drafted to yet, and returning
 *      them would put un-actionable rows on the verification UI.
 *
 *   2. The brain still speaks wedding-status vocabulary in its filters
 *      ('lost', 'cancelled', 'inquiry', ...) because its prompt says so.
 *      `matchesLifecycle` accepts BOTH vocabularies and maps between
 *      them, so the brain's contract holds without a prompt change. If
 *      the prompt is ever rewritten in spine vocabulary, the alias map
 *      keeps working and can then be deleted.
 *
 * Doctrine fit: structured signals decide ([[bloom-classifier-
 * unification]]). Whatever the brain returns, this is the deterministic
 * map to rows the operator can verify against the database.
 */

import { createServiceClient } from '@/lib/supabase/service'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CohortQuery } from '@/lib/services/brain/cohort-query'
import { isOutbound } from './direction'
import { isAcquisitionChannel } from '@/lib/services/attribution/couple-attribution'

/**
 * One row on the verification UI. The operator looks at this list,
 * unchecks anyone who shouldn't be acted on, then hands the wedding_ids
 * back to `bulkDraftFollowUps`.
 */
export interface CoupleListItem {
  /** Legacy wedding id. Still a wedding id because the drafter needs one. */
  weddingId: string
  /** "Anya Brown & Brian Jones" — from couples, not from people rows. */
  displayName: string
  /** Lifecycle state. Now `couples.lifecycle_state` (spine vocabulary:
   *  channel_scoped / resolved / booked / completed / ghost / agent). */
  lifecycleState: string | null
  /** Derived first-touch channel: the earliest acquisition touchpoint on
   *  the couple's ribbon. Not `weddings.source`, which is a stamped
   *  field a later import can overwrite. Null when every touchpoint is
   *  plumbing (gmail / sms / calendly / honeybook). */
  source: string | null
  /** The datetime the anchor event resolved to — tour time for tour
   *  anchors, first-touchpoint time for inquiry_received, etc. ISO. */
  anchorAt: string | null
  /** Human display string for the anchor — e.g. "Toured Sat May 24 1:15 PM". */
  anchorLabel: string
  /** Wedding date if known (couples.wedding_date). */
  weddingDate: string | null
  /** Last time we (the venue) sent a FOLLOW-UP draft to this couple.
   *  Distinct from "last time we replied to their inquiry" — the
   *  state-aware skip in step 4 reads this. */
  priorFollowUpAt: string | null
  /** Whether a post_tour_sequence row is currently in flight for this
   *  couple. Mig 376 — when true, the proactive cron is already
   *  managing follow-ups; the operator-initiated draft should skip. */
  inPostTourSequence: boolean
}

// ---------------------------------------------------------------------------
// Spine row shapes
// ---------------------------------------------------------------------------

interface SpineCouple {
  id: string
  source_wedding_id: string | null
  primary_contact_name: string | null
  partner_contact_name: string | null
  lifecycle_state: string | null
  wedding_date: string | null
}

interface SpineTouchpoint {
  couple_id: string | null
  channel: string
  action_type: string
  occurred_at: string
  raw_payload: Record<string, unknown> | null
  /** Present on the row but unused by direction(); typed so the shared
   *  isOutbound helper accepts it. */
  id: string
  signal_tier: string
  confidence_tier: string | null
}

// ---------------------------------------------------------------------------
// Lifecycle vocabulary
// ---------------------------------------------------------------------------

/** Legacy `weddings.status` value → the spine lifecycle state it means.
 *  The brain's prompt is written in the left-hand vocabulary. */
const LEGACY_STATUS_TO_SPINE: Record<string, string[]> = {
  inquiry: ['channel_scoped', 'resolved'],
  tour_scheduled: ['resolved'],
  tour_completed: ['resolved'],
  proposal_sent: ['resolved'],
  contracted: ['booked'],
  booked: ['booked'],
  completed: ['completed'],
  lost: ['ghost'],
  cancelled: ['ghost'],
}

/** True when a spine lifecycle state satisfies one of the filter terms,
 *  in either vocabulary. An unrecognised term matches nothing, which is
 *  the safe direction for an exclude list and the safe direction for an
 *  include list too (an include list of nonsense returns nobody rather
 *  than everybody). */
function matchesLifecycle(spineState: string | null, terms: string[]): boolean {
  if (!spineState) return false
  const state = spineState.toLowerCase()
  for (const raw of terms) {
    const term = raw.toLowerCase()
    if (term === state) return true
    if (LEGACY_STATUS_TO_SPINE[term]?.includes(state)) return true
  }
  return false
}

/** Channel aliases so a brain filter of 'the_knot' still matches a spine
 *  touchpoint on channel 'knot'. */
const CHANNEL_ALIASES: Record<string, string> = {
  the_knot: 'knot',
  knot: 'knot',
  wedding_wire: 'weddingwire',
  weddingwire: 'weddingwire',
  venue_calculator: 'website',
  website: 'website',
}

function normaliseChannel(raw: string | null): string | null {
  if (!raw) return null
  const c = raw.toLowerCase()
  return CHANNEL_ALIASES[c] ?? c
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function withinWindow(
  dt: Date | null,
  win: { fromIso: string; toIso: string } | null,
): boolean {
  if (!win) return true
  if (!dt) return false
  const ms = dt.getTime()
  return ms >= Date.parse(win.fromIso) && ms <= Date.parse(win.toIso)
}

function buildWindowIso(
  raw: { from: string; to: string } | null,
): { fromIso: string; toIso: string } | null {
  if (!raw) return null
  // Inclusive: from = 00:00:00 local; to = 23:59:59.999 local of last day.
  return {
    fromIso: `${raw.from}T00:00:00`,
    toIso: `${raw.to}T23:59:59.999`,
  }
}

function formatAnchorLabel(anchor: string, dt: Date | null): string {
  if (!dt) return anchor
  const display = dt.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  switch (anchor) {
    case 'tour_completed':
      return `Toured ${display}`
    case 'tour_scheduled':
      return `Tour scheduled ${display}`
    case 'inquiry_received':
      return `Inquired ${display}`
    case 'estimate_submitted':
      return `Estimate ${display}`
    case 'no_reply':
      return `Awaiting reply ${display}`
    case 'booked':
      return `Booked ${display}`
    default:
      return display
  }
}

function coupleName(primary: string | null, partner: string | null): string {
  if (primary && partner) return `${primary} & ${partner}`
  return primary ?? partner ?? '(no name)'
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ExecuteCohortQueryOptions {
  query: CohortQuery
  venueId: string
  /** Cap on the number of couples returned. The verification UI gets
   *  unwieldy past a couple dozen. */
  limit?: number
  /** Injectable client, for tests. Defaults to the service client. */
  supabase?: SupabaseClient
}

export interface CohortExecutionResult {
  /** The couples that match the query. */
  couples: CoupleListItem[]
  /** Total number of couples that matched BEFORE limit truncation. */
  totalMatched: number
  /** Echoed back so the caller can show the interpretation banner. */
  query: CohortQuery
}

export async function executeCohortQuery(
  options: ExecuteCohortQueryOptions,
): Promise<CohortExecutionResult> {
  const { query, venueId } = options
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200))
  const sb = options.supabase ?? createServiceClient()
  const windowIso = buildWindowIso(query.time_window)

  // 1. The venue's live couples. Merged-away couples are tombstones
  //    (migration 379) and never appear on an action list.
  const { data: coupleData } = await sb
    .from('couples')
    .select(
      'id, source_wedding_id, primary_contact_name, partner_contact_name, lifecycle_state, wedding_date',
    )
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
    .limit(5000)
  const couples = (coupleData ?? []) as SpineCouple[]
  if (couples.length === 0) return { couples: [], totalMatched: 0, query }

  const byCoupleId = new Map(couples.map((c) => [c.id, c]))

  // 2. The full touchpoint stream for the venue, indexed per couple in
  //    occurred_at order. Every anchor except estimate_submitted is
  //    answerable from this plus tours and progression events.
  const { data: tpData } = await sb
    .from('touchpoints')
    .select(
      'id, couple_id, channel, action_type, occurred_at, signal_tier, confidence_tier, raw_payload',
    )
    .eq('venue_id', venueId)
    .not('couple_id', 'is', null)
    .order('occurred_at', { ascending: true })
    .limit(50000)
  const tpByCouple = new Map<string, SpineTouchpoint[]>()
  for (const t of (tpData ?? []) as SpineTouchpoint[]) {
    if (!t.couple_id || !byCoupleId.has(t.couple_id)) continue
    const arr = tpByCouple.get(t.couple_id)
    if (arr) arr.push(t)
    else tpByCouple.set(t.couple_id, [t])
  }

  // 3. Anchor resolution → Map<couple_id, anchorIso>.
  const anchorByCouple = await resolveAnchorCouples(
    sb,
    venueId,
    query,
    windowIso,
    couples,
    tpByCouple,
  )
  if (anchorByCouple.size === 0) return { couples: [], totalMatched: 0, query }

  // 4. Lifecycle + source filters, in spine terms.
  const passes = (c: SpineCouple): boolean => {
    if (query.include_lifecycle_states.length > 0) {
      if (!matchesLifecycle(c.lifecycle_state, query.include_lifecycle_states)) {
        return false
      }
    } else if (matchesLifecycle(c.lifecycle_state, query.exclude_lifecycle_states)) {
      return false
    }
    if (query.source_filter.length > 0) {
      const derived = normaliseChannel(firstTouchChannel(tpByCouple.get(c.id) ?? []))
      if (!derived) return false
      const wanted = query.source_filter
        .map((s) => normaliseChannel(s))
        .filter((s): s is string => s !== null)
      if (!wanted.includes(derived)) return false
    }
    return true
  }

  const matched: Array<{ couple: SpineCouple; anchorAt: string }> = []
  for (const [coupleId, anchorAt] of anchorByCouple) {
    const c = byCoupleId.get(coupleId)
    if (!c) continue
    // No mirrored wedding means the drafter has nothing to draft against.
    // Dropping the row is honest; showing an un-actionable one is not.
    if (!c.source_wedding_id) continue
    if (!passes(c)) continue
    matched.push({ couple: c, anchorAt })
  }

  const totalMatched = matched.length
  // Most recent anchor first, then truncate — so the limit keeps the
  // rows an operator most likely wants rather than an arbitrary slice.
  matched.sort((a, b) => b.anchorAt.localeCompare(a.anchorAt))
  const visible = matched.slice(0, limit)
  if (visible.length === 0) return { couples: [], totalMatched, query }

  const visibleWeddingIds = visible.map((m) => m.couple.source_wedding_id as string)

  // 5. Per-couple state checks: prior follow-up + in-flight post-tour
  //    sequence. Both are drafter state, keyed on wedding_id, and have
  //    no spine equivalent — the drafter itself is still wedding-keyed.
  //    Surfacing them lets the operator see the decision tree BEFORE
  //    confirming.
  const fourteenDaysAgoIso = new Date(Date.now() - 14 * 86_400_000).toISOString()
  const [draftsRes, seqRes] = await Promise.all([
    sb
      .from('drafts')
      .select('wedding_id, sent_at, follow_up_step')
      .in('wedding_id', visibleWeddingIds)
      .eq('status', 'sent')
      .not('follow_up_step', 'is', null)
      .gte('sent_at', fourteenDaysAgoIso),
    sb
      .from('post_tour_sequence')
      .select('wedding_id, paused_at, sequence_completed_at')
      .in('wedding_id', visibleWeddingIds),
  ])

  const priorFollowUpByWedding = new Map<string, string>()
  for (const d of draftsRes.data ?? []) {
    const wid = d.wedding_id as string
    const sentAt = (d.sent_at as string) ?? null
    if (!sentAt) continue
    const existing = priorFollowUpByWedding.get(wid)
    if (!existing || sentAt > existing) priorFollowUpByWedding.set(wid, sentAt)
  }

  const inSeqWeddings = new Set<string>()
  for (const row of seqRes.data ?? []) {
    if (!row.paused_at && !row.sequence_completed_at) {
      inSeqWeddings.add(row.wedding_id as string)
    }
  }

  // 6. Assemble CoupleListItem rows.
  const out: CoupleListItem[] = visible.map(({ couple: c, anchorAt }) => {
    const weddingId = c.source_wedding_id as string
    const anchorDt = anchorAt ? new Date(anchorAt) : null
    return {
      weddingId,
      displayName: coupleName(c.primary_contact_name, c.partner_contact_name),
      lifecycleState: c.lifecycle_state ?? null,
      source: firstTouchChannel(tpByCouple.get(c.id) ?? []),
      anchorAt,
      anchorLabel: formatAnchorLabel(query.anchor, anchorDt),
      weddingDate: c.wedding_date ?? null,
      priorFollowUpAt: priorFollowUpByWedding.get(weddingId) ?? null,
      inPostTourSequence: inSeqWeddings.has(weddingId),
    }
  })

  return { couples: out, totalMatched, query }
}

// ---------------------------------------------------------------------------
// Derived first touch
// ---------------------------------------------------------------------------

/** The earliest acquisition (non-plumbing) channel on the ribbon. The
 *  touchpoint list arrives occurred_at-ascending, so the first match
 *  wins. Null when the couple only ever appeared through plumbing —
 *  honest, rather than crediting gmail with the acquisition. */
function firstTouchChannel(tps: SpineTouchpoint[]): string | null {
  for (const t of tps) {
    if (isOutbound(t)) continue
    if (isAcquisitionChannel(t.channel)) return t.channel
  }
  return null
}

// ---------------------------------------------------------------------------
// Anchor → couple resolution
// ---------------------------------------------------------------------------

interface TourRow {
  wedding_id: string | null
  scheduled_at: string | null
  outcome: string | null
}

const DEAD_TOUR_OUTCOMES = new Set(['cancelled', 'no_show'])

/**
 * Map an anchor + window to a Map<couple_id, anchorIso>. The anchorIso
 * value is what we display and sort on.
 */
async function resolveAnchorCouples(
  sb: SupabaseClient,
  venueId: string,
  query: CohortQuery,
  windowIso: { fromIso: string; toIso: string } | null,
  couples: SpineCouple[],
  tpByCouple: Map<string, SpineTouchpoint[]>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const coupleByWedding = new Map<string, SpineCouple>()
  for (const c of couples) {
    if (c.source_wedding_id) coupleByWedding.set(c.source_wedding_id, c)
  }

  switch (query.anchor) {
    case 'tour_completed':
    case 'tour_scheduled': {
      // `tours` is where the real scheduled_at lives, and it is the same
      // table getDailyList reads for "tours this week". It has no
      // couple_id column, so it joins through couples.source_wedding_id.
      const { data } = await sb
        .from('tours')
        .select('wedding_id, scheduled_at, outcome')
        .eq('venue_id', venueId)
        .limit(5000)
      const now = Date.now()
      for (const t of (data ?? []) as TourRow[]) {
        if (!t.wedding_id || !t.scheduled_at) continue
        if (t.outcome && DEAD_TOUR_OUTCOMES.has(t.outcome)) continue
        const couple = coupleByWedding.get(t.wedding_id)
        if (!couple) continue
        const dt = new Date(t.scheduled_at)
        if (Number.isNaN(dt.getTime())) continue
        if (query.anchor === 'tour_completed') {
          // Held, or scheduled for a time that has now passed. The
          // lifecycle cron may not have stamped an outcome yet; the
          // clock is the more reliable signal.
          const held = t.outcome === 'completed' || t.outcome === 'attended'
          if (!held && dt.getTime() > now) continue
        } else if (dt.getTime() <= now) {
          continue // tour_scheduled means still ahead of us
        }
        if (!withinWindow(dt, windowIso)) continue
        const iso = dt.toISOString()
        const existing = out.get(couple.id)
        if (!existing || iso > existing) out.set(couple.id, iso)
      }
      break
    }

    case 'inquiry_received': {
      // The couple's first inbound touchpoint. This is when they
      // actually reached out, as opposed to weddings.inquiry_date, which
      // a CSV re-import can restamp.
      for (const c of couples) {
        const tps = tpByCouple.get(c.id) ?? []
        const first = tps.find((t) => !isOutbound(t))
        if (!first) continue
        const dt = new Date(first.occurred_at)
        if (Number.isNaN(dt.getTime())) continue
        if (!withinWindow(dt, windowIso)) continue
        out.set(c.id, dt.toISOString())
      }
      break
    }

    case 'booked': {
      // The signing event on the progression log, which is inbound-only
      // by doctrine and therefore records the couple's own act rather
      // than an operator's status edit.
      const coupleIds = couples.map((c) => c.id)
      const CHUNK = 300
      for (let i = 0; i < coupleIds.length; i += CHUNK) {
        const slice = coupleIds.slice(i, i + CHUNK)
        const { data } = await sb
          .from('couple_progression_events')
          .select('couple_id, occurred_at, event_type')
          .in('couple_id', slice)
          .eq('event_type', 'contract_signed')
        for (const e of data ?? []) {
          const cid = e.couple_id as string
          const occurredAt = (e.occurred_at as string) ?? null
          if (!occurredAt) continue
          if (!withinWindow(new Date(occurredAt), windowIso)) continue
          const existing = out.get(cid)
          if (!existing || occurredAt > existing) out.set(cid, occurredAt)
        }
      }
      break
    }

    case 'estimate_submitted': {
      // Calculator submissions still land on engagement_events; the
      // spine has no equivalent action type yet. Kept as-is rather than
      // guessed at, and resolved back through the wedding mirror. When
      // the calculator writes touchpoints this branch folds into the
      // touchpoint scan above.
      let q = sb
        .from('engagement_events')
        .select('wedding_id, occurred_at')
        .eq('venue_id', venueId)
        .eq('event_type', 'estimate_submitted')
      if (windowIso) {
        q = q.gte('occurred_at', windowIso.fromIso).lte('occurred_at', windowIso.toIso)
      }
      const { data } = await q
      for (const e of data ?? []) {
        const wid = e.wedding_id as string | null
        const occurredAt = (e.occurred_at as string | null) ?? null
        if (!wid || !occurredAt) continue
        const couple = coupleByWedding.get(wid)
        if (!couple) continue
        const existing = out.get(couple.id)
        if (!existing || occurredAt > existing) out.set(couple.id, occurredAt)
      }
      break
    }

    case 'no_reply': {
      // Couples whose latest inbound touchpoint has no venue-originated
      // touchpoint after it. Direction is derived by the shared
      // `isOutbound` helper — touchpoints have no direction column and
      // this is the one place the rule lives.
      for (const c of couples) {
        const tps = tpByCouple.get(c.id) ?? []
        let latestInbound: string | null = null
        let latestOutbound: string | null = null
        for (const t of tps) {
          if (isOutbound(t)) {
            if (!latestOutbound || t.occurred_at > latestOutbound) {
              latestOutbound = t.occurred_at
            }
          } else if (!latestInbound || t.occurred_at > latestInbound) {
            latestInbound = t.occurred_at
          }
        }
        if (!latestInbound) continue
        if (latestOutbound && latestOutbound >= latestInbound) continue
        if (!withinWindow(new Date(latestInbound), windowIso)) continue
        out.set(c.id, latestInbound)
      }
      break
    }
  }

  return out
}
