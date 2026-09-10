/**
 * Cohort-action bulk drafter — state-aware follow-up generator.
 *
 * Step 4 of the cohort-action chain (BLOOM-TEST-QUESTIONS.md Q37). The
 * operator has confirmed a list of wedding IDs via the verification UI.
 * For each one, this drafter:
 *
 *   1. Checks the suppression state. If ANY of the following hit, skip
 *      with a clear reason instead of drafting:
 *        - a follow-up DRAFT was sent on this wedding in the last
 *          FOLLOW_UP_SUPPRESS_DAYS days (drafts.status='sent' with
 *          follow_up_step IS NOT NULL)
 *        - a post_tour_sequence row is in-flight (mig 376) — the
 *          proactive cron is already managing follow-ups for this couple
 *        - an operator-authored outbound on the wedding in the last
 *          FOLLOW_UP_SUPPRESS_DAYS days (the operator already replied
 *          via Gmail directly, sometimes outside Bloom)
 *        - couple.ai_opted_out / lost_locked_by_operator is true
 *   2. Otherwise, calls generateFollowUp() to produce a fresh draft
 *      and inserts it into the drafts table as status='pending'.
 *
 * The state check is the critical link in Q37 — duplicate sends erode
 * trust + waste the relationship. Mirroring the suppression logic the
 * follow-up-sequences cron uses keeps the operator-initiated path and
 * the proactive path consistent.
 *
 * Split for W15 (NOVEMBER-PLAN.md wave 2, 2026-09-09)
 * --------------------------------------------------
 * The state read and the draft composition are now two exported
 * functions with no writes of their own:
 *
 *   loadFollowUpState()   reads the suppression signals for a batch and
 *                         returns one row per wedding, first blocking
 *                         reason included. Takes its Supabase client and
 *                         its clock as arguments so a caller with a
 *                         request-scoped client, or a unit test with a
 *                         fake one, can use it.
 *   composeFollowUpDraft() calls the inquiry brain and hands back the
 *                         subject, body and confidence. It does not
 *                         touch the drafts table.
 *
 * bulkDraftFollowUps() is those two plus the insert, and behaves exactly
 * as it did before the split. The tool source in
 * src/lib/intel/tool-sources/follow-ups.ts uses the two halves to
 * propose drafts to the operator without writing anything, which is what
 * lets "Ask your data" answer Q34 and Q37 honestly.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import {
  generateFollowUp,
  BRAIN_PROMPT_VERSION as INQUIRY_BRAIN_PROMPT_VERSION,
} from '@/lib/services/brain/inquiry'

/** How long a prior touch suppresses a fresh follow-up, in days. */
export const FOLLOW_UP_SUPPRESS_DAYS = 7

/** Subject line every cohort follow-up draft carries. */
export const FOLLOW_UP_SUBJECT = 'Following up on your inquiry'

/** Message thrown when the brain hands back nothing usable. Named so the
 *  caller can report it as itself rather than as a generic exception. */
export const EMPTY_DRAFT_ERROR = 'brain returned empty draft'

export interface BulkFollowUpOptions {
  venueId: string
  weddingIds: string[]
  /** Correlation id from the cohort-action API call (T1-G). */
  correlationId?: string
}

export type FollowUpSkipReason =
  | 'recent_follow_up_sent'
  | 'in_post_tour_sequence'
  | 'recent_operator_outbound'
  | 'ai_opted_out'
  | 'lost_locked_by_operator'
  | 'no_contact_email'
  | 'no_couple_inbound'

export interface BulkFollowUpResult {
  drafted: Array<{
    weddingId: string
    draftId: string
    toEmail: string
    daysSinceLastContact: number
  }>
  skipped: Array<{
    weddingId: string
    reason: FollowUpSkipReason
    detail: string
  }>
  failed: Array<{ weddingId: string; reason: string }>
}

/** One wedding's follow-up state, every signal the suppression gate uses
 *  kept separately so a caller can explain itself rather than only obey. */
export interface FollowUpState {
  weddingId: string
  /** False when no wedding row exists for this id under this venue. */
  found: boolean
  aiOptedOut: boolean
  lostLockedByOperator: boolean
  /** Most recent Sage-generated follow-up that actually went out, inside
   *  the suppression window. Null when there is none. */
  lastFollowUpSentAt: string | null
  /** The step an in-flight post_tour_sequence row will send next, or null
   *  when no sequence is running. */
  sequenceNextStep: string | null
  /** Most recent operator-authored outbound inside the window. */
  lastOperatorOutboundAt: string | null
  lastInboundAt: string | null
  lastInboundFrom: string | null
  /** Reach-back address: people.email first, then the latest inbound. */
  contactEmail: string | null
  daysSinceLastContact: number
  /** The first blocking reason in the order the drafter applies them.
   *  Null means clear to draft. */
  suppression: { reason: FollowUpSkipReason; detail: string } | null
}

interface WeddingForDraft {
  id: string
  status: string | null
  ai_opted_out: boolean | null
  lost_locked_by_operator: boolean | null
}

interface PersonContact {
  wedding_id: string
  email: string | null
  first_name: string | null
  last_name: string | null
}

// ---------------------------------------------------------------------------
// loadFollowUpState: reads only, no AI, no writes
// ---------------------------------------------------------------------------

/**
 * Read every suppression signal for a batch of weddings in one pass.
 *
 * One query per signal type rather than N queries per wedding: cheap and
 * bounded whatever the cohort size. The clock is an argument so a caller
 * can pin it; the drafter passes Date.now().
 */
export async function loadFollowUpState(
  supabase: SupabaseClient,
  venueId: string,
  weddingIds: string[],
  nowMs: number,
): Promise<Map<string, FollowUpState>> {
  const ids = [...new Set(weddingIds)]
  const out = new Map<string, FollowUpState>()
  if (ids.length === 0) return out

  const sinceIso = new Date(
    nowMs - FOLLOW_UP_SUPPRESS_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()

  const { data: weddings } = await supabase
    .from('weddings')
    .select('id, status, ai_opted_out, lost_locked_by_operator')
    .eq('venue_id', venueId)
    .in('id', ids)
  const weddingsById = new Map<string, WeddingForDraft>()
  for (const w of (weddings ?? []) as WeddingForDraft[]) weddingsById.set(w.id, w)

  const { data: priorFollowUps } = await supabase
    .from('drafts')
    .select('wedding_id, sent_at, follow_up_step')
    .eq('venue_id', venueId)
    .in('wedding_id', ids)
    .eq('status', 'sent')
    .not('follow_up_step', 'is', null)
    .gte('sent_at', sinceIso)
  const recentFollowUpByWedding = new Map<string, string>()
  for (const d of priorFollowUps ?? []) {
    const wid = d.wedding_id as string
    const sentAt = (d.sent_at as string) ?? null
    if (!sentAt) continue
    const existing = recentFollowUpByWedding.get(wid)
    if (!existing || sentAt > existing) recentFollowUpByWedding.set(wid, sentAt)
  }

  // post_tour_sequence (mig 376): an in-flight row is one where neither
  // paused_at nor sequence_completed_at is set. The next step the cron
  // will try is the lowest-numbered email_N_sent_at that's still NULL.
  const { data: sequences } = await supabase
    .from('post_tour_sequence')
    .select('wedding_id, paused_at, sequence_completed_at, email_1_sent_at, email_2_sent_at, email_3_sent_at')
    .in('wedding_id', ids)
  const inFlightSeqByWedding = new Map<string, { nextStep: string }>()
  for (const row of sequences ?? []) {
    if (row.paused_at || row.sequence_completed_at) continue
    const nextStep = !row.email_1_sent_at
      ? 'email_1 (T+24h thank-you)'
      : !row.email_2_sent_at
        ? 'email_2 (T+3d check-in)'
        : !row.email_3_sent_at
          ? 'email_3 (T+7d nurture)'
          : 'final'
    inFlightSeqByWedding.set(row.wedding_id as string, { nextStep })
  }

  const { data: operatorOuts } = await supabase
    .from('interactions')
    .select('wedding_id, timestamp, author_class')
    .eq('venue_id', venueId)
    .eq('direction', 'outbound')
    .in('wedding_id', ids)
    .in('author_class', ['operator', 'unknown'])
    .gte('timestamp', sinceIso)
  const recentOperatorOutByWedding = new Map<string, string>()
  for (const r of operatorOuts ?? []) {
    const wid = r.wedding_id as string
    const ts = r.timestamp as string
    const existing = recentOperatorOutByWedding.get(wid)
    if (!existing || ts > existing) recentOperatorOutByWedding.set(wid, ts)
  }

  // For each wedding, find the latest inbound for the daysSinceLastContact
  // computation AND the couple's reach-back email (people row preferred,
  // falling back to the most-recent inbound from_email).
  const { data: latestInbounds } = await supabase
    .from('interactions')
    .select('wedding_id, timestamp, from_email')
    .eq('venue_id', venueId)
    .eq('direction', 'inbound')
    .in('wedding_id', ids)
    .order('timestamp', { ascending: false })
  const latestInboundByWedding = new Map<
    string,
    { ts: string; from: string | null }
  >()
  for (const r of latestInbounds ?? []) {
    const wid = r.wedding_id as string
    if (latestInboundByWedding.has(wid)) continue
    latestInboundByWedding.set(wid, {
      ts: r.timestamp as string,
      from: (r.from_email as string | null) ?? null,
    })
  }

  const { data: peopleRows } = await supabase
    .from('people')
    .select('wedding_id, email, first_name, last_name')
    .in('wedding_id', ids)
  const personByWedding = new Map<string, PersonContact>()
  for (const p of (peopleRows ?? []) as PersonContact[]) {
    if (personByWedding.has(p.wedding_id)) continue
    if (p.email && p.email.includes('@')) personByWedding.set(p.wedding_id, p)
  }

  for (const weddingId of ids) {
    const w = weddingsById.get(weddingId)
    const inbound = latestInboundByWedding.get(weddingId) ?? null
    const person = personByWedding.get(weddingId) ?? null
    const contactEmail = person?.email ?? inbound?.from ?? null

    // daysSinceLastContact: days since most-recent inbound. Fall back to
    // 7 days when no inbound timestamp exists (rare — usually means CSV
    // import with no message).
    let daysSinceLastContact = 7
    if (inbound?.ts) {
      const lastMs = Date.parse(inbound.ts)
      if (Number.isFinite(lastMs)) {
        daysSinceLastContact = Math.max(1, Math.round((nowMs - lastMs) / 86_400_000))
      }
    }

    const lastFollowUpSentAt = recentFollowUpByWedding.get(weddingId) ?? null
    const seq = inFlightSeqByWedding.get(weddingId) ?? null
    const lastOperatorOutboundAt = recentOperatorOutByWedding.get(weddingId) ?? null

    // Blocking order is the drafter's order and must stay that way: the
    // reason the operator is shown is the first one that fired, not an
    // arbitrary pick from a set.
    let suppression: FollowUpState['suppression'] = null
    if (w?.ai_opted_out === true) {
      suppression = {
        reason: 'ai_opted_out',
        detail:
          'Couple opted out of AI drafting. Operator must clear the flag manually before Sage can write.',
      }
    } else if (w?.lost_locked_by_operator === true) {
      suppression = {
        reason: 'lost_locked_by_operator',
        detail: 'Wedding was written off by operator. Unlock first if you want to re-engage.',
      }
    } else if (lastFollowUpSentAt) {
      suppression = {
        reason: 'recent_follow_up_sent',
        detail: `Sage already sent a follow-up on ${lastFollowUpSentAt.slice(0, 10)} (within the last ${FOLLOW_UP_SUPPRESS_DAYS} days). Send a second-touch manually or wait out the window.`,
      }
    } else if (seq) {
      suppression = {
        reason: 'in_post_tour_sequence',
        detail: `Post-tour sequence is already in flight; the cron's next send is ${seq.nextStep}. Don't double-send — pause the sequence on the lead page if you want to take over manually.`,
      }
    } else if (lastOperatorOutboundAt) {
      suppression = {
        reason: 'recent_operator_outbound',
        detail: `Operator-authored outbound on ${lastOperatorOutboundAt.slice(0, 10)} (within last ${FOLLOW_UP_SUPPRESS_DAYS} days). You already replied — Sage stays out.`,
      }
    } else if (!contactEmail) {
      suppression = {
        reason: 'no_contact_email',
        detail:
          'No email on file for this couple. Add a contact email before drafting a follow-up.',
      }
    }

    out.set(weddingId, {
      weddingId,
      found: Boolean(w),
      aiOptedOut: w?.ai_opted_out === true,
      lostLockedByOperator: w?.lost_locked_by_operator === true,
      lastFollowUpSentAt,
      sequenceNextStep: seq?.nextStep ?? null,
      lastOperatorOutboundAt,
      lastInboundAt: inbound?.ts ?? null,
      lastInboundFrom: inbound?.from ?? null,
      contactEmail,
      daysSinceLastContact,
      suppression,
    })
  }

  return out
}

// ---------------------------------------------------------------------------
// composeFollowUpDraft: AI call, still no draft row
// ---------------------------------------------------------------------------

export interface ComposeFollowUpInput {
  venueId: string
  weddingId: string
  contactEmail: string
  daysSinceLastContact: number
  correlationId?: string
}

export interface ComposedFollowUp {
  subject: string
  body: string
  confidence: number
  promptVersion: string
}

/**
 * Compose one follow-up through the inquiry brain and hand it back.
 *
 * Nothing is persisted to `drafts` and nothing is sent. The brain itself
 * still records its own cost row and an anti-repetition `phrase_usage`
 * row, exactly as it does on the write path; those are the drafter's
 * ledgers, not the operator's outbox.
 */
export async function composeFollowUpDraft(
  input: ComposeFollowUpInput,
): Promise<ComposedFollowUp> {
  const result = await generateFollowUp({
    venueId: input.venueId,
    contactEmail: input.contactEmail,
    weddingId: input.weddingId,
    daysSinceLastContact: input.daysSinceLastContact,
    correlationId: input.correlationId,
  })
  if (!result.draft || result.draft.trim().length === 0) {
    throw new Error(EMPTY_DRAFT_ERROR)
  }
  return {
    subject: FOLLOW_UP_SUBJECT,
    body: result.draft,
    confidence: result.confidence,
    promptVersion: INQUIRY_BRAIN_PROMPT_VERSION,
  }
}

// ---------------------------------------------------------------------------
// bulkDraftFollowUps: state + compose + the write
// ---------------------------------------------------------------------------

export async function bulkDraftFollowUps(
  options: BulkFollowUpOptions,
): Promise<BulkFollowUpResult> {
  const { venueId, correlationId } = options
  const weddingIds = [...new Set(options.weddingIds)]
  const out: BulkFollowUpResult = { drafted: [], skipped: [], failed: [] }
  if (weddingIds.length === 0) return out

  const sb = createServiceClient()
  const state = await loadFollowUpState(sb, venueId, weddingIds, Date.now())

  // -------------------------------------------------------------------------
  // Per-wedding decision loop. Sequential because each call writes a draft;
  // a tight Promise.all on the composer would blow Anthropic's per-venue
  // rate limit on large cohorts.
  // -------------------------------------------------------------------------
  for (const weddingId of weddingIds) {
    const s = state.get(weddingId)
    if (!s || !s.found) {
      out.failed.push({ weddingId, reason: 'wedding row not found' })
      continue
    }
    if (s.suppression) {
      out.skipped.push({
        weddingId,
        reason: s.suppression.reason,
        detail: s.suppression.detail,
      })
      continue
    }
    const contactEmail = s.contactEmail
    if (!contactEmail) {
      // Unreachable in practice: loadFollowUpState raises no_contact_email
      // above. Kept so the type narrows and a future change to the order
      // cannot silently draft to nobody.
      out.skipped.push({
        weddingId,
        reason: 'no_contact_email',
        detail: 'No email on file for this couple. Add a contact email before drafting a follow-up.',
      })
      continue
    }

    try {
      const composed = await composeFollowUpDraft({
        venueId,
        weddingId,
        contactEmail,
        daysSinceLastContact: s.daysSinceLastContact,
        correlationId,
      })

      // Persist as a pending draft. context_type=inquiry / brain_used=
      // inquiry / follow_up_step labels the surface so the suppression
      // gate on future runs can see this draft.
      const { data: inserted, error: insertErr } = await sb
        .from('drafts')
        .insert({
          venue_id: venueId,
          wedding_id: weddingId,
          interaction_id: null,
          to_email: contactEmail,
          subject: composed.subject,
          draft_body: composed.body,
          original_sage_body: composed.body,
          status: 'pending',
          context_type: 'inquiry',
          brain_used: 'inquiry',
          follow_up_step: 'operator_initiated_cohort',
          confidence_score: composed.confidence,
          auto_sent: false,
          prompt_version_used: composed.promptVersion,
          correlation_id: correlationId ?? null,
        })
        .select('id')
        .single()

      if (insertErr || !inserted) {
        out.failed.push({
          weddingId,
          reason: `draft insert failed: ${insertErr?.message ?? 'unknown'}`,
        })
        continue
      }

      out.drafted.push({
        weddingId,
        draftId: inserted.id as string,
        toEmail: contactEmail,
        daysSinceLastContact: s.daysSinceLastContact,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      out.failed.push({
        weddingId,
        reason: msg === EMPTY_DRAFT_ERROR ? EMPTY_DRAFT_ERROR : `exception: ${msg}`,
      })
    }
  }

  return out
}
