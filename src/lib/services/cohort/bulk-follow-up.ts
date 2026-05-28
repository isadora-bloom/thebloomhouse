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
 */

import { createServiceClient } from '@/lib/supabase/service'
import {
  generateFollowUp,
  BRAIN_PROMPT_VERSION as INQUIRY_BRAIN_PROMPT_VERSION,
} from '@/lib/services/brain/inquiry'

const FOLLOW_UP_SUPPRESS_DAYS = 7

export interface BulkFollowUpOptions {
  venueId: string
  weddingIds: string[]
  /** Correlation id from the cohort-action API call (T1-G). */
  correlationId?: string
}

export interface BulkFollowUpResult {
  drafted: Array<{
    weddingId: string
    draftId: string
    toEmail: string
    daysSinceLastContact: number
  }>
  skipped: Array<{
    weddingId: string
    reason:
      | 'recent_follow_up_sent'
      | 'in_post_tour_sequence'
      | 'recent_operator_outbound'
      | 'ai_opted_out'
      | 'lost_locked_by_operator'
      | 'no_contact_email'
      | 'no_couple_inbound'
    detail: string
  }>
  failed: Array<{ weddingId: string; reason: string }>
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

export async function bulkDraftFollowUps(
  options: BulkFollowUpOptions,
): Promise<BulkFollowUpResult> {
  const { venueId, correlationId } = options
  const weddingIds = [...new Set(options.weddingIds)]
  const out: BulkFollowUpResult = { drafted: [], skipped: [], failed: [] }
  if (weddingIds.length === 0) return out

  const sb = createServiceClient()
  const sinceIso = new Date(
    Date.now() - FOLLOW_UP_SUPPRESS_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()

  // Pre-load every state-check signal for the full batch — one query per
  // signal type instead of N queries per wedding. Cheap + bounded.
  const { data: weddings } = await sb
    .from('weddings')
    .select('id, status, ai_opted_out, lost_locked_by_operator')
    .eq('venue_id', venueId)
    .in('id', weddingIds)
  const weddingsById = new Map<string, WeddingForDraft>()
  for (const w of (weddings ?? []) as WeddingForDraft[]) weddingsById.set(w.id, w)

  const { data: priorFollowUps } = await sb
    .from('drafts')
    .select('wedding_id, sent_at, follow_up_step')
    .eq('venue_id', venueId)
    .in('wedding_id', weddingIds)
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
  const { data: sequences } = await sb
    .from('post_tour_sequence')
    .select('wedding_id, paused_at, sequence_completed_at, email_1_sent_at, email_2_sent_at, email_3_sent_at')
    .in('wedding_id', weddingIds)
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

  const { data: operatorOuts } = await sb
    .from('interactions')
    .select('wedding_id, timestamp, author_class')
    .eq('venue_id', venueId)
    .eq('direction', 'outbound')
    .in('wedding_id', weddingIds)
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
  const { data: latestInbounds } = await sb
    .from('interactions')
    .select('wedding_id, timestamp, from_email')
    .eq('venue_id', venueId)
    .eq('direction', 'inbound')
    .in('wedding_id', weddingIds)
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

  const { data: peopleRows } = await sb
    .from('people')
    .select('wedding_id, email, first_name, last_name')
    .in('wedding_id', weddingIds)
  const personByWedding = new Map<string, PersonContact>()
  for (const p of (peopleRows ?? []) as PersonContact[]) {
    if (personByWedding.has(p.wedding_id)) continue
    if (p.email && p.email.includes('@')) personByWedding.set(p.wedding_id, p)
  }

  // -------------------------------------------------------------------------
  // Per-wedding decision loop. Sequential because each call writes a draft;
  // a tight Promise.all on generateFollowUp would blow Anthropic's per-
  // venue rate limit on large cohorts.
  // -------------------------------------------------------------------------
  for (const weddingId of weddingIds) {
    const w = weddingsById.get(weddingId)
    if (!w) {
      out.failed.push({ weddingId, reason: 'wedding row not found' })
      continue
    }
    if (w.ai_opted_out === true) {
      out.skipped.push({
        weddingId,
        reason: 'ai_opted_out',
        detail: 'Couple opted out of AI drafting. Operator must clear the flag manually before Sage can write.',
      })
      continue
    }
    if (w.lost_locked_by_operator === true) {
      out.skipped.push({
        weddingId,
        reason: 'lost_locked_by_operator',
        detail: 'Wedding was written off by operator. Unlock first if you want to re-engage.',
      })
      continue
    }
    const priorAt = recentFollowUpByWedding.get(weddingId)
    if (priorAt) {
      out.skipped.push({
        weddingId,
        reason: 'recent_follow_up_sent',
        detail: `Sage already sent a follow-up on ${priorAt.slice(0, 10)} (within the last ${FOLLOW_UP_SUPPRESS_DAYS} days). Send a second-touch manually or wait out the window.`,
      })
      continue
    }
    const seq = inFlightSeqByWedding.get(weddingId)
    if (seq) {
      out.skipped.push({
        weddingId,
        reason: 'in_post_tour_sequence',
        detail: `Post-tour sequence is already in flight; the cron's next send is ${seq.nextStep}. Don't double-send — pause the sequence on the lead page if you want to take over manually.`,
      })
      continue
    }
    const opOutAt = recentOperatorOutByWedding.get(weddingId)
    if (opOutAt) {
      out.skipped.push({
        weddingId,
        reason: 'recent_operator_outbound',
        detail: `Operator-authored outbound on ${opOutAt.slice(0, 10)} (within last ${FOLLOW_UP_SUPPRESS_DAYS} days). You already replied — Sage stays out.`,
      })
      continue
    }

    // Reach-back address: people.email first (most stable), then latest
    // inbound's from_email. If neither is routable, skip.
    const person = personByWedding.get(weddingId) ?? null
    const inbound = latestInboundByWedding.get(weddingId) ?? null
    const contactEmail = person?.email ?? inbound?.from ?? null
    if (!contactEmail) {
      out.skipped.push({
        weddingId,
        reason: 'no_contact_email',
        detail: 'No email on file for this couple. Add a contact email before drafting a follow-up.',
      })
      continue
    }

    // daysSinceLastContact: days since most-recent inbound. Fall back to
    // 7 days when no inbound timestamp exists (rare — usually means CSV
    // import with no message).
    let daysSinceLastContact = 7
    if (inbound?.ts) {
      const lastMs = Date.parse(inbound.ts)
      if (Number.isFinite(lastMs)) {
        daysSinceLastContact = Math.max(
          1,
          Math.round((Date.now() - lastMs) / 86_400_000),
        )
      }
    }

    try {
      const result = await generateFollowUp({
        venueId,
        contactEmail,
        weddingId,
        daysSinceLastContact,
        correlationId,
      })
      if (!result.draft || result.draft.trim().length === 0) {
        out.failed.push({ weddingId, reason: 'brain returned empty draft' })
        continue
      }
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
          subject: 'Following up on your inquiry',
          draft_body: result.draft,
          original_sage_body: result.draft,
          status: 'pending',
          context_type: 'inquiry',
          brain_used: 'inquiry',
          follow_up_step: 'operator_initiated_cohort',
          confidence_score: result.confidence,
          auto_sent: false,
          prompt_version_used: INQUIRY_BRAIN_PROMPT_VERSION,
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
        daysSinceLastContact,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      out.failed.push({ weddingId, reason: `exception: ${msg}` })
    }
  }

  return out
}
