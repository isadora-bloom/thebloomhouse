/**
 * Nightly reconciliation: what have they told us that is not on the day?
 *
 * The shape of the job
 * --------------------
 * For one wedding, gather every commitment the venue has captured — the
 * intentions and special requests lifted out of conversations by
 * `capture.ts`, plus the planning notes the chatbot and contract writers
 * already produced — and ask, of each one, whether the couple's day-of
 * timeline has anything covering it. Whatever is left over is the queue
 * the coordinator reads.
 *
 * Why a judge and not a matcher
 * -----------------------------
 * "We're having a groom's cake" against a timeline entry called "Cake
 * cutting" is a match. Against "Cake cutting (bride's cake only)" it is
 * not. No amount of string distance gets that right, and the house rule
 * is already written down: no regex on user text. So this uses the same
 * shape as the identity judge — one model call, a small bounded question,
 * a rationale that a coordinator can argue with.
 *
 * One call per wedding, not one per commitment. The whole unmatched list
 * and the whole timeline go in together, which is both cheaper and more
 * accurate: the model can see that two intentions map to the same event.
 *
 * Caching
 * -------
 * Every stored row carries `judge_cache_key`, a hash of the quote plus
 * the timeline it was judged against. If neither has changed since last
 * night, the answer cannot have changed, so the commitment is dropped
 * from the batch before the call is made. On a stable wedding the nightly
 * sweep therefore costs nothing at all.
 *
 * What it will not touch
 * ----------------------
 * A row a coordinator has resolved — added to the timeline, or dismissed
 * — is left exactly as it is. Dismissal is a decision, and a sweep that
 * quietly reopened it every night would be worse than not having the
 * queue.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { callAIJson } from '@/lib/ai/client'
import { writeOrLog } from '@/lib/db/write-or-log'
import { logEvent } from '@/lib/observability/logger'
import { redactError } from '@/lib/observability/redact'
import { commitmentKey, judgeCacheKey } from './keys'
import { readTimelineEntries, timelineTitles } from './timeline-read'

export const COMMITMENT_JUDGE_PROMPT_VERSION = 'commitments.judge.v1.0'

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/**
 * Weddings judged per sweep run. The sweep piggybacks on an existing
 * nightly cron tick that also runs the data-integrity invariants, so it
 * has to finish inside the same function time limit. Weddings skipped
 * tonight are picked up tomorrow — the cache means an untouched wedding
 * costs nothing, so the backlog drains rather than recirculating.
 */
const DEFAULT_WEDDING_BUDGET = 200

/** Commitments shown to the judge in one call. Keeps the prompt bounded. */
const MAX_QUOTES_PER_CALL = 40

/** Timeline entries shown to the judge. A full day is well under this. */
const MAX_TIMELINE_ENTRIES = 80

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CommitmentKind = 'intention' | 'special_request' | 'planning_note'

/** One thing the couple told the venue, before it has been judged. */
export interface CapturedCommitment {
  quote: string
  kind: CommitmentKind
  sourceInteractionId: string | null
  sourcePlanningNoteId: string | null
}

export interface JudgeVerdict {
  /** Echoed back so verdicts can be matched to their quote. */
  quote: string
  /** True when something on the timeline already covers this. */
  covered: boolean
  /** Which entry covers it. Null when nothing does. */
  matchedEventTitle: string | null
  /** One sentence. Shown to the coordinator beside the row. */
  reason: string
}

/**
 * The judge, as an interface so tests can pass a deterministic fake
 * instead of a model. `reconcileWedding` never constructs one itself.
 */
export type CommitmentJudge = (args: {
  venueId: string
  quotes: string[]
  timeline: string[]
}) => Promise<JudgeVerdict[]>

export interface ReconcileWeddingResult {
  weddingId: string
  /** Commitments found for this wedding, before caching is applied. */
  captured: number
  /** Commitments actually sent to the judge. */
  judged: number
  /** Commitments whose cached verdict was reused. */
  cached: number
  /** Rows now sitting on the queue as unmatched. */
  unmatched: number
  /** Rows left alone because a coordinator had already resolved them. */
  resolved: number
  /** Set when the wedding was skipped without judging. */
  skipped: 'no_commitments' | 'timeline_unreadable' | null
}

// ---------------------------------------------------------------------------
// The default judge
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM_PROMPT = `You are checking a wedding venue's day-of timeline against things the couple has told the venue.

You are given TIMELINE: the events planned for the wedding day. And COMMITMENTS: sentences the couple wrote to the venue at some point.

For each commitment, decide whether the timeline already accounts for it.

Answer with a JSON array. One object per commitment, in the same order, with these fields:
- quote: the commitment text, copied back exactly
- covered: true if some timeline event already accounts for this commitment, false if nothing does
- matchedEventTitle: the timeline event that covers it, copied exactly, or null when covered is false
- reason: one short sentence saying why. Plain words.

Rules:
- A commitment is covered only if an event on the timeline would actually make it happen. "We're having a groom's cake" is NOT covered by "Cake cutting" if that event is about the wedding cake and says nothing about a second cake. Say so in the reason.
- A commitment about something that needs no event on the day is covered. "We've booked our photographer" is a decision, not a thing that has to appear on the timeline as its own entry, if the timeline already has photography time.
- A commitment that is vague or not about the wedding day at all is covered, with a reason saying it needs no event.
- Never invent a timeline event. matchedEventTitle must be copied from TIMELINE or be null.
- Prefer false when you are unsure. A coordinator dismissing a row costs seconds; a missed groom's cake costs the day.`

async function callJudge(args: {
  venueId: string
  quotes: string[]
  timeline: string[]
}): Promise<JudgeVerdict[]> {
  const timelineBlock =
    args.timeline.length > 0
      ? args.timeline.map((t, i) => `${i + 1}. ${t}`).join('\n')
      : '(nothing on the timeline yet)'

  const commitmentsBlock = args.quotes.map((q, i) => `${i + 1}. ${q}`).join('\n')

  const raw = await callAIJson<unknown>({
    systemPrompt: JUDGE_SYSTEM_PROMPT,
    userPrompt: `TIMELINE:\n${timelineBlock}\n\nCOMMITMENTS:\n${commitmentsBlock}`,
    maxTokens: 2000,
    temperature: 0.1,
    venueId: args.venueId,
    taskType: 'commitment_reconciliation',
    // Haiku: bounded structured judgement over a short list, the same
    // workload class as signal extraction.
    tier: 'haiku',
    promptVersion: COMMITMENT_JUDGE_PROMPT_VERSION,
  })

  return coerceVerdicts(raw, args.quotes)
}

/**
 * Turn whatever the model returned into one verdict per quote.
 *
 * Defaults to NOT covered for anything the model failed to answer. That
 * puts an extra row on the coordinator's queue, which is the failure we
 * want: a spurious row gets dismissed in a second, a dropped one is the
 * bug this whole workstream exists to fix.
 */
export function coerceVerdicts(raw: unknown, quotes: string[]): JudgeVerdict[] {
  const byQuote = new Map<string, JudgeVerdict>()

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      const quote = typeof row.quote === 'string' ? row.quote.trim() : ''
      if (!quote) continue
      const title =
        typeof row.matchedEventTitle === 'string' && row.matchedEventTitle.trim().length > 0
          ? row.matchedEventTitle.trim()
          : null
      const covered = row.covered === true && title !== null
      byQuote.set(commitmentKey(quote), {
        quote,
        covered,
        matchedEventTitle: covered ? title : null,
        reason: typeof row.reason === 'string' ? row.reason.trim() : '',
      })
    }
  }

  return quotes.map((quote) => {
    const hit = byQuote.get(commitmentKey(quote))
    if (hit) return { ...hit, quote }
    return {
      quote,
      covered: false,
      matchedEventTitle: null,
      reason: 'The check did not return an answer for this one, so it stays on the queue.',
    }
  })
}

// ---------------------------------------------------------------------------
// Gathering what they told us
// ---------------------------------------------------------------------------

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed.length > 0) out.push(trimmed)
  }
  return out
}

/**
 * Every commitment captured for one wedding.
 *
 * Two sources, both venue-filtered:
 *
 *   planning_notes         the writers in intel/planning-extraction.ts —
 *                          the chatbot, contract PDFs, and (since W50)
 *                          coordinator-venue conversations.
 *
 *   interactions.extracted_facts
 *                          intentions and special requests stamped onto
 *                          the interaction itself. Read defensively: the
 *                          column is jsonb and nothing guarantees a shape.
 *
 * Deduplicated by commitment key, so the same sentence captured by both
 * routes produces one row, not two.
 */
export async function gatherCommitments(
  supabase: SupabaseClient,
  venueId: string,
  weddingId: string,
): Promise<CapturedCommitment[]> {
  const byKey = new Map<string, CapturedCommitment>()

  const { data: notes } = await supabase
    .from('planning_notes')
    .select('id, content, category, source_interaction_id')
    .eq('venue_id', venueId)
    .eq('wedding_id', weddingId)

  for (const row of (notes ?? []) as Array<Record<string, unknown>>) {
    const content = typeof row.content === 'string' ? row.content.trim() : ''
    if (content.length === 0) continue
    const key = commitmentKey(content)
    if (byKey.has(key)) continue
    byKey.set(key, {
      quote: content,
      kind: 'planning_note',
      sourceInteractionId:
        typeof row.source_interaction_id === 'string' ? row.source_interaction_id : null,
      sourcePlanningNoteId: typeof row.id === 'string' ? row.id : null,
    })
  }

  const { data: interactions } = await supabase
    .from('interactions')
    .select('id, extracted_facts')
    .eq('venue_id', venueId)
    .eq('wedding_id', weddingId)
    .not('extracted_facts', 'is', null)

  for (const row of (interactions ?? []) as Array<Record<string, unknown>>) {
    const facts = row.extracted_facts
    if (!facts || typeof facts !== 'object') continue
    const typed = facts as Record<string, unknown>
    const interactionId = typeof row.id === 'string' ? row.id : null

    const add = (quote: string, kind: CommitmentKind) => {
      const key = commitmentKey(quote)
      if (byKey.has(key)) return
      byKey.set(key, {
        quote,
        kind,
        sourceInteractionId: interactionId,
        sourcePlanningNoteId: null,
      })
    }

    for (const q of readStringList(typed.intentions)) add(q, 'intention')
    for (const q of readStringList(typed.special_requests)) add(q, 'special_request')
    for (const q of readStringList(typed.specialRequests)) add(q, 'special_request')
  }

  return [...byKey.values()]
}

// ---------------------------------------------------------------------------
// Reconciling one wedding
// ---------------------------------------------------------------------------

interface ExistingRow {
  commitment_key: string
  status: string
  judge_cache_key: string | null
  matched_event_title: string | null
  judge_reason: string | null
}

const RESOLVED_STATUSES = new Set(['added', 'dismissed'])

export async function reconcileWedding(args: {
  supabase: SupabaseClient
  venueId: string
  weddingId: string
  judge: CommitmentJudge
}): Promise<ReconcileWeddingResult> {
  const { supabase, venueId, weddingId, judge } = args
  const base: ReconcileWeddingResult = {
    weddingId,
    captured: 0,
    judged: 0,
    cached: 0,
    unmatched: 0,
    resolved: 0,
    skipped: null,
  }

  const commitments = await gatherCommitments(supabase, venueId, weddingId)
  base.captured = commitments.length
  if (commitments.length === 0) return { ...base, skipped: 'no_commitments' }

  const { entries, readable } = await readTimelineEntries(supabase, weddingId)
  if (!readable) {
    // A failed read is not an empty timeline. Marking every commitment
    // unmatched off a broken query would fill the queue with noise the
    // coordinator then has to dismiss by hand.
    return { ...base, skipped: 'timeline_unreadable' }
  }
  const titles = timelineTitles(entries).slice(0, MAX_TIMELINE_ENTRIES)

  const { data: existingRaw } = await supabase
    .from('commitment_reconciliation')
    .select('commitment_key, status, judge_cache_key, matched_event_title, judge_reason')
    .eq('venue_id', venueId)
    .eq('wedding_id', weddingId)

  const existing = new Map<string, ExistingRow>()
  for (const row of (existingRaw ?? []) as unknown as ExistingRow[]) {
    existing.set(row.commitment_key, row)
  }

  // Split into: leave alone, reuse the cached verdict, ask the judge.
  const toJudge: CapturedCommitment[] = []
  const reuse: Array<{ commitment: CapturedCommitment; row: ExistingRow }> = []

  for (const commitment of commitments) {
    const key = commitmentKey(commitment.quote)
    const prior = existing.get(key)

    if (prior && RESOLVED_STATUSES.has(prior.status)) {
      base.resolved++
      continue
    }

    const cacheKey = judgeCacheKey(commitment.quote, titles)
    if (prior && prior.judge_cache_key === cacheKey) {
      reuse.push({ commitment, row: prior })
      continue
    }

    toJudge.push(commitment)
  }

  base.cached = reuse.length

  let verdicts: JudgeVerdict[] = []
  if (toJudge.length > 0) {
    const batch = toJudge.slice(0, MAX_QUOTES_PER_CALL)
    verdicts = await judge({
      venueId,
      quotes: batch.map((c) => c.quote),
      timeline: titles,
    })
    base.judged = batch.length
  }

  const verdictByKey = new Map<string, JudgeVerdict>()
  for (const v of verdicts) verdictByKey.set(commitmentKey(v.quote), v)

  const now = new Date().toISOString()
  const rows: Array<Record<string, unknown>> = []

  const push = (
    commitment: CapturedCommitment,
    covered: boolean,
    matchedEventTitle: string | null,
    reason: string | null,
  ) => {
    if (!covered) base.unmatched++
    rows.push({
      venue_id: venueId,
      wedding_id: weddingId,
      commitment_key: commitmentKey(commitment.quote),
      quote: commitment.quote,
      kind: commitment.kind,
      source_interaction_id: commitment.sourceInteractionId,
      source_planning_note_id: commitment.sourcePlanningNoteId,
      status: covered ? 'matched' : 'unmatched',
      matched_event_title: matchedEventTitle,
      judge_reason: reason,
      judge_cache_key: judgeCacheKey(commitment.quote, titles),
      last_checked_at: now,
    })
  }

  for (const { commitment, row } of reuse) {
    push(
      commitment,
      row.status === 'matched',
      row.matched_event_title,
      row.judge_reason,
    )
  }

  for (const commitment of toJudge.slice(0, MAX_QUOTES_PER_CALL)) {
    const v = verdictByKey.get(commitmentKey(commitment.quote))
    push(
      commitment,
      v?.covered ?? false,
      v?.matchedEventTitle ?? null,
      v?.reason ?? null,
    )
  }

  if (rows.length > 0) {
    await writeOrLog(
      supabase
        .from('commitment_reconciliation')
        .upsert(rows, { onConflict: 'wedding_id,commitment_key' }),
      { op: 'commitment_reconciliation.upsert', venueId },
    )
  }

  return base
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

export interface SweepResult {
  venues: number
  weddings: number
  judged: number
  cached: number
  unmatched: number
  skipped: number
  errors: number
}

/**
 * Which weddings have anything worth reconciling.
 *
 * Derived from planning_notes rather than from the weddings table on
 * purpose. A wedding nobody has told us anything about has nothing to
 * reconcile, so walking every wedding would be a query per venue for no
 * result — and this module deliberately holds no read of `weddings` at
 * all, per the legacy-reads ratchet.
 */
async function weddingsWithCommitments(
  supabase: SupabaseClient,
  venueId: string,
  limit: number,
): Promise<string[]> {
  const { data } = await supabase
    .from('planning_notes')
    .select('wedding_id')
    .eq('venue_id', venueId)
    .limit(5000)

  const seen = new Set<string>()
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    if (typeof row.wedding_id === 'string') seen.add(row.wedding_id)
    if (seen.size >= limit) break
  }
  return [...seen]
}

/**
 * Nightly reconciliation across every venue.
 *
 * Runs inside the `data_integrity_sweep` cron tick. Venue-scoped
 * throughout: the wedding list, the commitments and the timeline are all
 * read under one venue id, and the write carries it. One venue's failure
 * is caught and counted so it cannot stop the next venue's sweep.
 */
export async function sweepCommitmentReconciliationAllVenues(options?: {
  weddingBudget?: number
  judge?: CommitmentJudge
}): Promise<SweepResult> {
  const supabase = createServiceClient()
  const judge = options?.judge ?? callJudge
  let budget = options?.weddingBudget ?? DEFAULT_WEDDING_BUDGET

  const result: SweepResult = {
    venues: 0,
    weddings: 0,
    judged: 0,
    cached: 0,
    unmatched: 0,
    skipped: 0,
    errors: 0,
  }

  const { data: venues, error } = await supabase
    .from('venues')
    .select('id')
    .order('id', { ascending: true })

  if (error || !venues) return result

  for (const venue of venues as Array<{ id: string }>) {
    if (budget <= 0) break
    result.venues++
    let weddingIds: string[] = []
    try {
      weddingIds = await weddingsWithCommitments(supabase, venue.id, budget)
    } catch (err) {
      result.errors++
      logEvent({
        level: 'warn',
        msg: 'commitments.sweep_venue_failed',
        event_type: 'commitment_reconciliation',
        outcome: 'fail',
        venueId: venue.id,
        data: { error: redactError(err) },
      })
      continue
    }

    for (const weddingId of weddingIds) {
      if (budget <= 0) break
      budget--
      try {
        const one = await reconcileWedding({
          supabase,
          venueId: venue.id,
          weddingId,
          judge,
        })
        result.weddings++
        result.judged += one.judged
        result.cached += one.cached
        result.unmatched += one.unmatched
        if (one.skipped) result.skipped++
      } catch (err) {
        result.errors++
        logEvent({
          level: 'warn',
          msg: 'commitments.sweep_wedding_failed',
          event_type: 'commitment_reconciliation',
          outcome: 'fail',
          venueId: venue.id,
          data: { weddingId, error: redactError(err) },
        })
      }
    }
  }

  return result
}
