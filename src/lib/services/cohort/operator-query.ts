/**
 * Cohort-action executor — deterministic, no LLM.
 *
 * Takes a CohortQuery (the structured shape `lib/services/brain/cohort-
 * query.ts` produces from the operator's natural-language input) and
 * returns a typed CoupleListItem[] suitable for the verification UI.
 *
 * Step 2 of the cohort-action chain (BLOOM-TEST-QUESTIONS.md Q37). The
 * brain interprets intent; this executor runs the query against the
 * authoritative tables (weddings, engagement_events, interactions,
 * drafts, post_tour_sequence, people). NO LLM here — the executor must
 * be auditable + reproducible against the same inputs.
 *
 * Doctrine fit: structured signals decide ([[bloom-classifier-
 * unification]]). Whatever the brain returns, this is the deterministic
 * map to rows the operator can verify against the database.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { parseFlexibleEventDatetime } from '@/lib/services/event-time-flex'
import type { CohortQuery } from '@/lib/services/brain/cohort-query'

/**
 * One row on the verification UI. The operator looks at this list,
 * unchecks anyone who shouldn't be acted on, then hands the wedding_ids
 * back to `bulkDraftFollowUps`.
 */
export interface CoupleListItem {
  weddingId: string
  /** "Anya Brown & Brian Jones" — empty string when no people row exists. */
  displayName: string
  /** Lifecycle state (weddings.status). */
  lifecycleState: string | null
  /** Source label (weddings.source). */
  source: string | null
  /** The datetime the anchor event resolved to — tour completion time
   *  for tour anchors, inquiry timestamp for inquiry_received, etc. ISO. */
  anchorAt: string | null
  /** Human display string for the anchor — e.g. "Toured Sat May 24 1:15 PM". */
  anchorLabel: string
  /** Wedding's own date if known (weddings.wedding_date). */
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

interface RawWedding {
  id: string
  status: string | null
  source: string | null
  inquiry_date: string | null
  booked_at: string | null
  wedding_date: string | null
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
  return (
    ms >= Date.parse(win.fromIso) && ms <= Date.parse(win.toIso)
  )
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ExecuteCohortQueryOptions {
  query: CohortQuery
  venueId: string
  /** Cap on the number of couples returned. The verification UI gets
   *  unwieldy past a couple dozen. */
  limit?: number
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
  const sb = createServiceClient()
  const windowIso = buildWindowIso(query.time_window)

  // 1. Resolve wedding_ids that match the anchor + window.
  const weddingIds = await resolveAnchorWeddings(sb, venueId, query, windowIso)
  if (weddingIds.size === 0) {
    return { couples: [], totalMatched: 0, query }
  }

  // 2. Pull weddings for lifecycle + source filtering + display.
  const idArray = [...weddingIds.keys()]
  const { data: weddings } = await sb
    .from('weddings')
    .select('id, status, source, inquiry_date, booked_at, wedding_date')
    .eq('venue_id', venueId)
    .in('id', idArray)
  const weddingsById = new Map<string, RawWedding>()
  for (const w of (weddings ?? []) as RawWedding[]) {
    weddingsById.set(w.id, w)
  }

  // 3. Apply lifecycle + source filters.
  const passes = (w: RawWedding | undefined): boolean => {
    if (!w) return false
    const state = (w.status ?? '').toLowerCase()
    if (
      query.include_lifecycle_states.length > 0 &&
      !query.include_lifecycle_states.includes(state)
    ) {
      return false
    }
    if (
      query.include_lifecycle_states.length === 0 &&
      query.exclude_lifecycle_states.includes(state)
    ) {
      return false
    }
    if (
      query.source_filter.length > 0 &&
      (!w.source || !query.source_filter.includes(w.source.toLowerCase()))
    ) {
      return false
    }
    return true
  }
  const filteredIds = idArray.filter((id) => passes(weddingsById.get(id)))
  const totalMatched = filteredIds.length
  const visibleIds = filteredIds.slice(0, limit)

  if (visibleIds.length === 0) {
    return { couples: [], totalMatched, query }
  }

  // 4. Pull display names from people.
  const { data: people } = await sb
    .from('people')
    .select('wedding_id, first_name, last_name')
    .in('wedding_id', visibleIds)
  const namesByWedding = new Map<string, string[]>()
  for (const p of people ?? []) {
    const arr = namesByWedding.get(p.wedding_id as string) ?? []
    const name = `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim()
    if (name) arr.push(name)
    namesByWedding.set(p.wedding_id as string, arr)
  }

  // 5. Per-couple state checks: prior follow-up + in-flight post-tour
  //    sequence. The bulk-drafter reads these to decide skip vs draft;
  //    surfacing them on the verification UI lets the operator see the
  //    decision tree BEFORE confirming.
  const fourteenDaysAgoIso = new Date(
    Date.now() - 14 * 24 * 60 * 60 * 1000,
  ).toISOString()
  const { data: priorDrafts } = await sb
    .from('drafts')
    .select('wedding_id, sent_at, follow_up_step')
    .in('wedding_id', visibleIds)
    .eq('status', 'sent')
    .not('follow_up_step', 'is', null)
    .gte('sent_at', fourteenDaysAgoIso)
  const priorFollowUpByWedding = new Map<string, string>()
  for (const d of priorDrafts ?? []) {
    const wid = d.wedding_id as string
    const sentAt = (d.sent_at as string) ?? null
    if (!sentAt) continue
    const existing = priorFollowUpByWedding.get(wid)
    if (!existing || sentAt > existing) priorFollowUpByWedding.set(wid, sentAt)
  }
  // post_tour_sequence (mig 376) tracks the in-flight 3-email sequence
  // per tour. The sequence is "active" when the row exists AND neither
  // `paused_at` nor `sequence_completed_at` is set — the proactive cron
  // is still going to send another email; the operator-initiated path
  // should defer.
  const { data: sequences } = await sb
    .from('post_tour_sequence')
    .select('wedding_id, paused_at, sequence_completed_at')
    .in('wedding_id', visibleIds)
  const inSeqWeddings = new Set<string>()
  for (const row of sequences ?? []) {
    if (!row.paused_at && !row.sequence_completed_at) {
      inSeqWeddings.add(row.wedding_id as string)
    }
  }

  // 6. Assemble CoupleListItem rows.
  const couples: CoupleListItem[] = visibleIds.map((id) => {
    const w = weddingsById.get(id)!
    const anchorAt = weddingIds.get(id) ?? null
    const anchorDt = anchorAt ? new Date(anchorAt) : null
    const names = namesByWedding.get(id) ?? []
    return {
      weddingId: id,
      displayName: names.length > 0 ? names.join(' & ') : '(no name)',
      lifecycleState: w.status ?? null,
      source: w.source ?? null,
      anchorAt,
      anchorLabel: formatAnchorLabel(query.anchor, anchorDt),
      weddingDate: w.wedding_date ?? null,
      priorFollowUpAt: priorFollowUpByWedding.get(id) ?? null,
      inPostTourSequence: inSeqWeddings.has(id),
    }
  })

  // Stable display ordering — most recent anchor first.
  couples.sort((a, b) => {
    if (!a.anchorAt && !b.anchorAt) return 0
    if (!a.anchorAt) return 1
    if (!b.anchorAt) return -1
    return b.anchorAt.localeCompare(a.anchorAt)
  })

  return { couples, totalMatched, query }
}

// ---------------------------------------------------------------------------
// Anchor → wedding_id resolution
// ---------------------------------------------------------------------------

/**
 * Map an anchor + window to a Map<wedding_id, anchorIso>. The anchorIso
 * value is what we display + sort on. Each anchor has its own resolution
 * because they live in different tables.
 */
async function resolveAnchorWeddings(
  sb: ReturnType<typeof createServiceClient>,
  venueId: string,
  query: CohortQuery,
  windowIso: { fromIso: string; toIso: string } | null,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()

  switch (query.anchor) {
    case 'tour_completed':
    case 'tour_scheduled': {
      // Both tour anchors are stored on engagement_events.event_type with
      // the actual tour datetime on metadata.event_datetime (raw scheduling-
      // tool string) OR occurred_at (for tour_completed promoted by
      // chooseEventTime). We pull a broader set and filter in-memory by
      // window because metadata.event_datetime is jsonb text in any of
      // four formats (parseFlexibleEventDatetime handles them).
      const targetTypes =
        query.anchor === 'tour_completed'
          ? ['tour_completed', 'tour_scheduled']
          : ['tour_scheduled']
      const { data: events } = await sb
        .from('engagement_events')
        .select('wedding_id, event_type, metadata, occurred_at')
        .eq('venue_id', venueId)
        .in('event_type', targetTypes)
      const now = Date.now()
      for (const e of events ?? []) {
        const wid = e.wedding_id as string | null
        if (!wid) continue
        const meta = (e.metadata ?? {}) as Record<string, unknown>
        const rawDt =
          (typeof meta.event_datetime === 'string' && meta.event_datetime) ||
          (e.occurred_at as string | null) ||
          null
        const parsed = parseFlexibleEventDatetime(rawDt)
        if (!parsed) continue
        // Tour_completed: include events that already fired as completed
        // AND tour_scheduled events whose eventDatetime is in the past
        // (the lifecycle cron hasn't promoted them yet but the tour
        // happened).
        if (query.anchor === 'tour_completed') {
          if (e.event_type !== 'tour_completed' && parsed.getTime() > now) {
            continue
          }
        } else {
          // tour_scheduled: only future scheduled tours.
          if (parsed.getTime() <= now) continue
        }
        if (!withinWindow(parsed, windowIso)) continue
        const iso = parsed.toISOString()
        const existing = out.get(wid)
        // Most recent anchor wins per wedding (a couple might have
        // multiple tour events; show the latest).
        if (!existing || iso > existing) out.set(wid, iso)
      }
      break
    }
    case 'inquiry_received': {
      let q = sb
        .from('weddings')
        .select('id, inquiry_date')
        .eq('venue_id', venueId)
        .not('inquiry_date', 'is', null)
      if (windowIso) {
        q = q.gte('inquiry_date', windowIso.fromIso).lte('inquiry_date', windowIso.toIso)
      }
      const { data } = await q
      for (const w of data ?? []) {
        out.set(w.id as string, w.inquiry_date as string)
      }
      break
    }
    case 'booked': {
      let q = sb
        .from('weddings')
        .select('id, booked_at')
        .eq('venue_id', venueId)
        .not('booked_at', 'is', null)
      if (windowIso) {
        q = q.gte('booked_at', windowIso.fromIso).lte('booked_at', windowIso.toIso)
      }
      const { data } = await q
      for (const w of data ?? []) {
        out.set(w.id as string, w.booked_at as string)
      }
      break
    }
    case 'estimate_submitted': {
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
        if (!wid) continue
        const occurredAt = (e.occurred_at as string | null) ?? null
        if (!occurredAt) continue
        const existing = out.get(wid)
        if (!existing || occurredAt > existing) out.set(wid, occurredAt)
      }
      break
    }
    case 'no_reply': {
      // Couples with an inbound in the window AND no operator-authored
      // outbound after that inbound. Pulled as: inbound interactions in
      // window → group by wedding_id → check for a later outbound.
      let inboundQ = sb
        .from('interactions')
        .select('wedding_id, timestamp')
        .eq('venue_id', venueId)
        .eq('direction', 'inbound')
        .not('wedding_id', 'is', null)
      if (windowIso) {
        inboundQ = inboundQ
          .gte('timestamp', windowIso.fromIso)
          .lte('timestamp', windowIso.toIso)
      }
      const { data: inbounds } = await inboundQ
      const latestInbound = new Map<string, string>()
      for (const r of inbounds ?? []) {
        const wid = r.wedding_id as string
        const ts = r.timestamp as string
        const existing = latestInbound.get(wid)
        if (!existing || ts > existing) latestInbound.set(wid, ts)
      }
      if (latestInbound.size === 0) break
      const wIds = [...latestInbound.keys()]
      const { data: outs } = await sb
        .from('interactions')
        .select('wedding_id, timestamp, author_class')
        .eq('venue_id', venueId)
        .eq('direction', 'outbound')
        .in('wedding_id', wIds)
        .in('author_class', ['operator', 'sage', 'unknown'])
      const latestOut = new Map<string, string>()
      for (const r of outs ?? []) {
        const wid = r.wedding_id as string
        const ts = r.timestamp as string
        const existing = latestOut.get(wid)
        if (!existing || ts > existing) latestOut.set(wid, ts)
      }
      for (const [wid, inboundTs] of latestInbound) {
        const outTs = latestOut.get(wid)
        if (!outTs || outTs < inboundTs) {
          out.set(wid, inboundTs)
        }
      }
      break
    }
  }

  return out
}
