/**
 * Knot visitor-activity → identity matcher.
 *
 * Companion to migration 377 + `crm-import/knot-visitor-activity.ts`.
 * Runs AFTER the CSV import lands rows into `knot_visitor_activity`.
 *
 * What it does
 * ------------
 * For every NEWLY-INSERTED unmatched row (person_id IS NULL) in the
 * batch:
 *
 *   1. Search `people` for candidates by first_name + last initial
 *      (Knot redacts the surname to "L.", so we pattern-match the
 *      first letter via ILIKE).
 *   2. Cross-reference candidates against:
 *      - the people's wedding row's wedding_date proximity to
 *        action_at (within ±24 months — Knot history typically
 *        precedes the wedding by 6-18 months)
 *      - whether the wedding's existing attribution is already
 *        plausibly Knot-leaning (source='the_knot' OR a touchpoint
 *        already exists on channel='knot')
 *   3. Decide per the operator-confirmed bands:
 *      - exactly 1 strong candidate → BIND directly (write
 *        person_id + couple_id onto the row)
 *      - multiple candidates → write candidate_matches rows so the
 *        operator can resolve in /intel/identity-review
 *      - no candidates AND action ∈ {message, storefront_save} →
 *        promote to a GHOST via the cascade barrel (linkSignal). A
 *        couple who SAVED us deserves to be a record we can search
 *        for; a couple who VIEWED us once doesn't yet.
 *      - no candidates AND action ∈ {storefront_view,
 *        click_to_website, click_to_social} → leave UNBOUND.
 *
 *   4. AFTER a bind, run the verification-visit signal emitter:
 *      if the bound couple's wedding is in-pipeline AND action_at is
 *      AFTER the first inquiry touchpoint, emit an engagement_event
 *      row of event_type='knot_verification_visit' (~3 points). This
 *      is the NEW heat signal Bloom did not have before.
 *
 * Doctrine alignment
 * ------------------
 * - All ghost-record creation goes through `@/lib/spine/cascade`
 *   (linkSignal). The CI guard `check-cascade-only-writer.mjs` blocks
 *   direct inserts into `people` / `couples` / `touchpoints`
 *   anywhere outside the chokepoint surface; this file is OUTSIDE
 *   that surface (it is a matcher, not a writer of identity tables).
 * - candidate_matches rows: written through the existing
 *   `insertCandidateMatch` chokepoint on tracer.ts.
 * - engagement_events: read/write via the supabase client directly —
 *   the table is not part of the cascade-guarded set per
 *   check-cascade-only-writer.mjs (engagement_events.event_type has
 *   no CHECK constraint per migration 002, so the new event-type
 *   strings here lift cleanly).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { linkSignal } from '@/lib/spine/cascade'
import { insertCandidateMatch } from './tracer'
import { logEvent } from '@/lib/observability/logger'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface KnotVisitorMatchResult {
  totalUnmatched: number
  bound: number
  candidatesQueued: number
  ghostsPromoted: number
  leftUnbound: number
  verificationVisitsEmitted: number
  errors: string[]
  /** When the operator-named canary (Doug L.) is in the batch, this
   *  carries a per-row note about what happened to his rows so the
   *  operator can verify the path. Per the 2026-05-27 instruction. */
  dougTrace: string[]
}

// Pipeline statuses where a verification visit is a heat signal. Per
// the operator-shared insight: a Knot view from someone already in
// pipeline says "I'm verifying before I commit" — that is heat.
const IN_PIPELINE_STATUSES = new Set([
  'inquiry',
  'tour_scheduled',
  'tour_completed',
  'proposal_sent',
])

// Actions that justify creating a ghost record when no candidate
// person matches. Views and clicks are low-intent (treat as
// aggregate-only via the storefront-activity adapter); saves and
// messages show real consideration.
const GHOST_WORTHY_ACTIONS = new Set(['message', 'storefront_save'])

// Verification-visit event-type strings. engagement_events.event_type
// has no CHECK constraint (mig 002), so adding new string values is
// non-breaking.
const VERIFICATION_VISIT_EVENT_TYPE = 'knot_verification_visit'
const VERIFICATION_VISIT_POINTS = 3

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface KnotVisitorActivityRow {
  id: string
  visitor_name: string
  visitor_first_name: string | null
  visitor_last_initial: string | null
  action_taken: string
  action_at: string
  city: string | null
  state: string | null
}

interface PersonCandidate {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  wedding_id: string | null
  wedding_status: string | null
  wedding_date: string | null
  wedding_source: string | null
}

// ---------------------------------------------------------------------------
// Helper — load unmatched rows in a batch (or all unmatched at the venue
// if no batchId given). Bounded read so a huge backfill doesn't melt.
// ---------------------------------------------------------------------------

const MAX_ROWS_PER_SWEEP = 2_000

async function loadUnmatchedRows(
  supabase: SupabaseClient,
  venueId: string,
  batchId: string | null,
): Promise<KnotVisitorActivityRow[]> {
  let q = supabase
    .from('knot_visitor_activity')
    .select(
      'id, visitor_name, visitor_first_name, visitor_last_initial, action_taken, action_at, city, state',
    )
    .eq('venue_id', venueId)
    .is('person_id', null)
    .order('action_at', { ascending: false })
    .limit(MAX_ROWS_PER_SWEEP)
  if (batchId) q = q.eq('import_batch_id', batchId)
  const { data, error } = await q
  if (error) {
    logEvent({
      level: 'warn',
      msg: 'knot_visitor_match.load_unmatched_failed',
      venueId,
      data: { error: error.message },
    })
    return []
  }
  return (data ?? []) as KnotVisitorActivityRow[]
}

// ---------------------------------------------------------------------------
// Helper — find candidate people for a (first_name, last_initial) tuple,
// scoped to one venue. Returns the people + a lookup of their wedding
// row's status / date / source so the caller can apply temporal
// corroboration.
// ---------------------------------------------------------------------------

async function findCandidatePeople(args: {
  supabase: SupabaseClient
  venueId: string
  firstName: string
  lastInitial: string | null
}): Promise<PersonCandidate[]> {
  const { supabase, venueId, firstName, lastInitial } = args

  // First-name + last-initial composite. ILIKE against the trimmed
  // first letter — exact equality on first_name would miss "Douglas"
  // when the CSV said "Doug" (we only match the trimmed first name as
  // a prefix to keep the noise floor low: 3-character minimum on the
  // ILIKE is safer than full-token equality but tighter than a free
  // substring search).
  const firstPrefix = `${firstName}%`
  const lastPrefix = lastInitial ? `${lastInitial}%` : null

  let q = supabase
    .from('people')
    .select(
      'id, first_name, last_name, email, wedding_id, weddings!people_wedding_id_fkey(status, wedding_date, source)',
    )
    .eq('venue_id', venueId)
    .ilike('first_name', firstPrefix)

  if (lastPrefix) q = q.ilike('last_name', lastPrefix)

  const { data, error } = await q.limit(50)
  if (error) {
    // Don't abort the whole sweep on one query failure — log and skip.
    logEvent({
      level: 'warn',
      msg: 'knot_visitor_match.find_people_failed',
      venueId,
      data: { error: error.message, firstName, lastInitial },
    })
    return []
  }

  type Row = {
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
    wedding_id: string | null
    weddings: { status: string | null; wedding_date: string | null; source: string | null } | null
  }
  return ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    first_name: r.first_name,
    last_name: r.last_name,
    email: r.email,
    wedding_id: r.wedding_id,
    wedding_status: r.weddings?.status ?? null,
    wedding_date: r.weddings?.wedding_date ?? null,
    wedding_source: r.weddings?.source ?? null,
  }))
}

// ---------------------------------------------------------------------------
// Helper — temporal-corroboration score. Knot history typically arrives
// 0-24 months BEFORE the wedding date. We score a candidate as "strong"
// when the action_at is within that window relative to the candidate's
// wedding_date. Bonus when the candidate's wedding source is already
// 'the_knot' (the CSV is plausibly the same channel).
// ---------------------------------------------------------------------------

function scoreCandidate(args: {
  candidate: PersonCandidate
  actionAt: string
}): number {
  let score = 0

  // Last-initial match alone is the floor. The caller already
  // filtered by last initial, so every candidate that reached here
  // has at least one signal of identity overlap.
  score += 10

  // Temporal corroboration. Knot funnel activity typically lives
  // 0-24 months before the wedding.
  if (args.candidate.wedding_date) {
    const wedAt = Date.parse(args.candidate.wedding_date)
    const actAt = Date.parse(args.actionAt)
    if (Number.isFinite(wedAt) && Number.isFinite(actAt)) {
      const monthsBefore = (wedAt - actAt) / (1000 * 60 * 60 * 24 * 30.44)
      // Strict-window weighting: 0-24 months before is +40, beyond
      // that range it's 0. We don't penalise — Knot activity after a
      // wedding is real verification (couples revisit profiles after
      // events to leave reviews).
      if (monthsBefore >= 0 && monthsBefore <= 24) score += 40
      else if (monthsBefore < 0 && monthsBefore >= -6) score += 15
    }
  }

  // Source corroboration. If the wedding's existing attribution is
  // already 'the_knot', the visitor activity is much more likely to
  // be the same couple.
  if (args.candidate.wedding_source === 'the_knot') score += 30

  return score
}

const STRONG_BIND_THRESHOLD = 50

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function matchKnotVisitorsToPeople(args: {
  venueId: string
  batchId?: string | null
  supabase: SupabaseClient
}): Promise<KnotVisitorMatchResult> {
  const { supabase, venueId } = args
  const batchId = args.batchId ?? null

  const result: KnotVisitorMatchResult = {
    totalUnmatched: 0,
    bound: 0,
    candidatesQueued: 0,
    ghostsPromoted: 0,
    leftUnbound: 0,
    verificationVisitsEmitted: 0,
    errors: [],
    dougTrace: [],
  }

  const rows = await loadUnmatchedRows(supabase, venueId, batchId)
  result.totalUnmatched = rows.length
  if (rows.length === 0) return result

  for (const row of rows) {
    const isDoug =
      row.visitor_first_name?.toLowerCase() === 'doug' &&
      row.visitor_last_initial?.toUpperCase() === 'L'

    try {
      // Only attempt people lookup when we have a usable first name.
      // Knot exports occasionally drop the visitor name field entirely
      // (anonymised view); those rows stay unbound.
      if (!row.visitor_first_name) {
        result.leftUnbound += 1
        continue
      }

      const candidates = await findCandidatePeople({
        supabase,
        venueId,
        firstName: row.visitor_first_name,
        lastInitial: row.visitor_last_initial,
      })

      // Score every candidate against this row's action_at + source.
      const scored = candidates
        .map((c) => ({ c, score: scoreCandidate({ candidate: c, actionAt: row.action_at }) }))
        .sort((a, b) => b.score - a.score)

      const strongCandidates = scored.filter((s) => s.score >= STRONG_BIND_THRESHOLD)

      if (strongCandidates.length === 1) {
        // EXACTLY one strong candidate — bind directly.
        const winner = strongCandidates[0]!.c
        await bindRowToPerson({
          supabase,
          venueId,
          rowId: row.id,
          person: winner,
        })
        result.bound += 1
        if (isDoug) {
          result.dougTrace.push(
            `Doug row ${row.id} (${row.action_taken} @ ${row.action_at}) auto-bound to person ${winner.id} (${winner.first_name} ${winner.last_name}, wedding ${winner.wedding_id})`,
          )
        }

        // Verification-visit detection — fire ONLY when the wedding is
        // in-pipeline AND the action post-dates the inquiry.
        const emitted = await maybeEmitVerificationVisit({
          supabase,
          venueId,
          row,
          person: winner,
        })
        if (emitted) result.verificationVisitsEmitted += 1
      } else if (strongCandidates.length > 1) {
        // MULTIPLE strong candidates — surface for operator review via
        // candidate_matches. We use the existing chokepoint
        // (insertCandidateMatch on tracer.ts) so the rows show up in
        // /intel/identity-review next to all the other ambiguous
        // identity proposals.
        //
        // We don't have a couple_id to propose AGAINST until the
        // operator binds first; insertCandidateMatch is keyed on
        // (primary_record_id, secondary_record_id). The cleanest shape:
        // the knot_visitor_activity row id is the primary (typed as
        // 'touchpoint' from the candidate_matches CHECK enum — it IS
        // a touchpoint in the doctrine sense), each candidate person's
        // wedding-row's couple is the secondary.
        for (const s of strongCandidates.slice(0, 5)) {
          if (!s.c.wedding_id) continue
          // Resolve the wedding's couple_id (couples.source_wedding_id).
          const { data: couple } = await supabase
            .from('couples')
            .select('id')
            .eq('venue_id', venueId)
            .eq('source_wedding_id', s.c.wedding_id)
            .maybeSingle()
          if (!couple?.id) continue
          await insertCandidateMatch(
            supabase,
            venueId,
            row.id,
            'touchpoint',
            couple.id,
            'couple',
            'medium',
            `knot_visitor_activity: visitor "${row.visitor_name}" matches ${s.c.first_name} ${s.c.last_name} (score=${s.score})`,
          )
        }
        result.candidatesQueued += 1
        if (isDoug) {
          result.dougTrace.push(
            `Doug row ${row.id} produced ${strongCandidates.length} strong candidates — queued for operator review`,
          )
        }
      } else if (GHOST_WORTHY_ACTIONS.has(row.action_taken)) {
        // NO strong candidate AND this is a ghost-worthy action. Promote
        // via the cascade barrel — `linkSignal` is THE entry point for
        // new identities, and the matcher inside it will still try
        // every cascade stage (so if there IS a stage-1 email match
        // somewhere, it lands the row correctly; otherwise it falls
        // through to fragment/mint per the route-by-tier table).
        try {
          const linkRes = await linkSignal({
            supabase,
            venueId,
            signal: {
              external_id: `knot_visitor:${row.id}`,
              channel: 'knot',
              action_type:
                row.action_taken === 'message'
                  ? 'knot_message'
                  : 'knot_save',
              occurred_at: row.action_at,
              signal_tier: row.action_taken === 'message' ? 'high' : 'medium',
              identity_hint: row.visitor_name,
              primary_name:
                [row.visitor_first_name, row.visitor_last_initial]
                  .filter(Boolean)
                  .join(' ') || row.visitor_name,
              raw_payload: {
                source: 'knot_visitor_activity',
                knot_visitor_activity_id: row.id,
                visitor_first_name: row.visitor_first_name,
                visitor_last_initial: row.visitor_last_initial,
                action_taken: row.action_taken,
                city: row.city,
                state: row.state,
              },
              author_class: 'couple',
            },
            source: 'knot_visitor_activity',
          })
          // The cascade may MINT (cold-start / sufficient identity) OR
          // FRAGMENT (identity-poor). Either way we count it as a
          // promotion attempt — the row no longer sits in the void.
          if (linkRes.action === 'minted' || linkRes.action === 'attached' || linkRes.action === 'cold_start') {
            result.ghostsPromoted += 1
            if (linkRes.matched_couple_id) {
              // The cascade matched/minted a couple. Backlink the
              // knot_visitor_activity row so subsequent runs and the
              // verification-visit emitter can reach it.
              await supabase
                .from('knot_visitor_activity')
                .update({ couple_id: linkRes.matched_couple_id })
                .eq('id', row.id)
                .eq('venue_id', venueId)
            }
            if (isDoug) {
              result.dougTrace.push(
                `Doug row ${row.id} (${row.action_taken}) routed through cascade → action=${linkRes.action} couple=${linkRes.matched_couple_id ?? 'fragment'}`,
              )
            }
          } else {
            result.leftUnbound += 1
            if (isDoug) {
              result.dougTrace.push(
                `Doug row ${row.id} cascade returned ${linkRes.action} — fragment-only, no person yet`,
              )
            }
          }
        } catch (err) {
          result.errors.push(
            `linkSignal failed for row ${row.id}: ${err instanceof Error ? err.message : 'unknown'}`,
          )
        }
      } else {
        // Low-intent unmatched (view / click) — sit in the table, leave
        // unbound. The aggregate funnel is the value here; identity is
        // not worth a synthetic ghost for a single anonymous view.
        result.leftUnbound += 1
        if (isDoug) {
          result.dougTrace.push(
            `Doug row ${row.id} (${row.action_taken}) left unbound — low-intent action`,
          )
        }
      }
    } catch (err) {
      result.errors.push(
        `row ${row.id}: ${err instanceof Error ? err.message : 'unknown'}`,
      )
    }
  }

  logEvent({
    level: 'info',
    msg: 'knot_visitor_match.sweep_complete',
    venueId,
    data: {
      batch_id: batchId,
      total_unmatched: result.totalUnmatched,
      bound: result.bound,
      candidates_queued: result.candidatesQueued,
      ghosts_promoted: result.ghostsPromoted,
      left_unbound: result.leftUnbound,
      verification_visits_emitted: result.verificationVisitsEmitted,
      errors: result.errors.length,
      doug_traces: result.dougTrace.length,
    },
  })

  return result
}

// ---------------------------------------------------------------------------
// Bind helper — updates the knot_visitor_activity row with the resolved
// person/couple ids. NOT a chokepoint write — knot_visitor_activity is
// not in the guarded table set.
// ---------------------------------------------------------------------------

async function bindRowToPerson(args: {
  supabase: SupabaseClient
  venueId: string
  rowId: string
  person: PersonCandidate
}): Promise<void> {
  // Resolve the wedding's couple_id via the couples.source_wedding_id
  // mirror established in Phase A (mig 346).
  let coupleId: string | null = null
  if (args.person.wedding_id) {
    const { data } = await args.supabase
      .from('couples')
      .select('id')
      .eq('venue_id', args.venueId)
      .eq('source_wedding_id', args.person.wedding_id)
      .maybeSingle()
    coupleId = (data?.id as string | undefined) ?? null
  }

  const { error } = await args.supabase
    .from('knot_visitor_activity')
    .update({ person_id: args.person.id, couple_id: coupleId })
    .eq('id', args.rowId)
    .eq('venue_id', args.venueId)

  if (error) {
    logEvent({
      level: 'warn',
      msg: 'knot_visitor_match.bind_failed',
      venueId: args.venueId,
      data: { row_id: args.rowId, person_id: args.person.id, error: error.message },
    })
  }
}

// ---------------------------------------------------------------------------
// Verification-visit emitter. Fires when:
//   - The bound couple's wedding is in IN_PIPELINE_STATUSES
//   - The visitor's action_at is AFTER the wedding's earliest inquiry
//     touchpoint (so a fresh inquiry's first-ever Knot view doesn't
//     fake-fire a verification — that view IS the inquiry).
// ---------------------------------------------------------------------------

async function maybeEmitVerificationVisit(args: {
  supabase: SupabaseClient
  venueId: string
  row: KnotVisitorActivityRow
  person: PersonCandidate
}): Promise<boolean> {
  if (!args.person.wedding_id || !args.person.wedding_status) return false
  if (!IN_PIPELINE_STATUSES.has(args.person.wedding_status)) return false

  // Find the earliest inquiry touchpoint on this wedding.
  // wedding_touchpoints (legacy table, mig 079) carries `inquiry` as
  // `touch_type`; the new spine `touchpoints` table carries inquiry
  // via action_type='form_submit' or via couple_progression_events
  // (event_type='new_channel_inquiry'). Easiest cross-spine signal:
  // look at weddings.inquiry_date directly.
  const { data: wedding } = await args.supabase
    .from('weddings')
    .select('inquiry_date')
    .eq('id', args.person.wedding_id)
    .eq('venue_id', args.venueId)
    .maybeSingle()

  const firstInquiry = wedding?.inquiry_date ? Date.parse(wedding.inquiry_date as string) : null
  const actionAt = Date.parse(args.row.action_at)
  if (!Number.isFinite(actionAt)) return false

  // Visit BEFORE the inquiry: this IS the initial discovery, not a
  // verification visit. Skip.
  if (firstInquiry != null && Number.isFinite(firstInquiry) && actionAt < firstInquiry) {
    return false
  }

  // Idempotency — don't double-emit the same row's verification event.
  // We key on (wedding_id, event_type, metadata.knot_visitor_activity_id).
  // engagement_events has no UNIQUE on this shape, so we do a read-
  // before-write peek. Race-tolerated: the worst case is a duplicate
  // 3-point heat bump, which the heat-mapping dedup re-collapses on
  // the next recompute pass.
  const { data: existing } = await args.supabase
    .from('engagement_events')
    .select('id')
    .eq('venue_id', args.venueId)
    .eq('wedding_id', args.person.wedding_id)
    .eq('event_type', VERIFICATION_VISIT_EVENT_TYPE)
    .contains('metadata', { knot_visitor_activity_id: args.row.id })
    .maybeSingle()
  if (existing?.id) return false

  const daysSinceFirstInquiry =
    firstInquiry != null && Number.isFinite(firstInquiry)
      ? Math.round((actionAt - firstInquiry) / (1000 * 60 * 60 * 24))
      : null

  const { error } = await args.supabase.from('engagement_events').insert({
    venue_id: args.venueId,
    wedding_id: args.person.wedding_id,
    event_type: VERIFICATION_VISIT_EVENT_TYPE,
    points: VERIFICATION_VISIT_POINTS,
    metadata: {
      knot_visitor_activity_id: args.row.id,
      knot_action_taken: args.row.action_taken,
      days_since_first_inquiry: daysSinceFirstInquiry,
      person_id: args.person.id,
    },
  })

  if (error) {
    logEvent({
      level: 'warn',
      msg: 'knot_visitor_match.verification_visit_insert_failed',
      venueId: args.venueId,
      data: { row_id: args.row.id, wedding_id: args.person.wedding_id, error: error.message },
    })
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// View-to-message lag metric — small read-only helper. Returns the
// per-person Knot journey (first view, first message, total visits,
// days view→message). Intelligence-ready — a future /intel surface
// could chart it. UI surface is deferred per the task brief.
// ---------------------------------------------------------------------------

export interface VisitorJourneyMetrics {
  totalVisits: number
  totalMessages: number
  firstViewAt: string | null
  firstMessageAt: string | null
  daysViewToMessage: number | null
  lastActionAt: string | null
}

export async function getVisitorJourneyMetrics(args: {
  venueId: string
  personId: string
  supabase: SupabaseClient
}): Promise<VisitorJourneyMetrics> {
  const { data, error } = await args.supabase
    .from('knot_visitor_activity')
    .select('action_taken, action_at')
    .eq('venue_id', args.venueId)
    .eq('person_id', args.personId)
    .order('action_at', { ascending: true })

  const empty: VisitorJourneyMetrics = {
    totalVisits: 0,
    totalMessages: 0,
    firstViewAt: null,
    firstMessageAt: null,
    daysViewToMessage: null,
    lastActionAt: null,
  }
  if (error || !data) return empty

  let totalVisits = 0
  let totalMessages = 0
  let firstViewAt: string | null = null
  let firstMessageAt: string | null = null
  let lastActionAt: string | null = null

  for (const r of data as Array<{ action_taken: string; action_at: string }>) {
    totalVisits += 1
    lastActionAt = r.action_at
    if (r.action_taken === 'storefront_view' && !firstViewAt) firstViewAt = r.action_at
    if (r.action_taken === 'message') {
      totalMessages += 1
      if (!firstMessageAt) firstMessageAt = r.action_at
    }
  }

  let daysViewToMessage: number | null = null
  if (firstViewAt && firstMessageAt) {
    const vAt = Date.parse(firstViewAt)
    const mAt = Date.parse(firstMessageAt)
    if (Number.isFinite(vAt) && Number.isFinite(mAt) && mAt >= vAt) {
      daysViewToMessage = Math.round((mAt - vAt) / (1000 * 60 * 60 * 24))
    }
  }

  return {
    totalVisits,
    totalMessages,
    firstViewAt,
    firstMessageAt,
    daysViewToMessage,
    lastActionAt,
  }
}
