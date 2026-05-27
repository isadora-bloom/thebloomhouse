/**
 * Bloom House — pre-draft skip gates.
 *
 * Anchor docs:
 *   - bloom-constitution.md (operator authority — when the human is
 *     handling the thread or the couple has opted out, Sage stays out)
 *   - feedback_deep_fix_vs_bandaid.md Pattern 1 (LLM-as-primitive doesn't
 *     mean LLM-as-default; gates are deterministic where the signal is
 *     deterministic)
 *
 * The classification + drafting layers are reactive — they generate a
 * reply given an inbound. These gates are PREVENTIVE — they decide
 * whether Sage should generate anything at all for the current inbound.
 *
 * Three gates today:
 *
 *   1. ai_opted_out (weddings.ai_opted_out, mig 303)
 *      Sticky per-couple opt-out. Triggered the first time any inbound
 *      on the wedding fires escalation_requested. Persists until the
 *      operator explicitly clears it on the lead detail page. Hard
 *      block: no draft, no auto-send, never override.
 *
 *   2. operator_handling_thread
 *      If the same Gmail thread carries a recent outbound that was
 *      authored by a human (author_class IN ('operator', 'unknown')
 *      where unknown = not yet classified, conservative default), Sage
 *      stays out of the thread. The coordinator picked it up and Sage
 *      drafting more replies is noise, not help.
 *
 *   3. wedding_recently_handled_by_operator (2026-05-27)
 *      Same idea as #2 but wedding-scoped, not thread-scoped. Closes
 *      the gap where the operator replied via Gmail directly to a
 *      couple's original inquiry in thread A, then a fresh inquiry /
 *      Knot reminder / new-channel touch arrives in thread B for the
 *      SAME couple. #2 misses it (different thread_id); #3 catches it
 *      by checking interactions across the whole wedding. Same
 *      author_class filter as #2 — only human-authored outbound counts;
 *      Sage's own auto-sends (author_class='sage') don't trigger.
 *      Recipient-agnostic: an operator outbound to a vendor on the
 *      wedding will fire this gate too. False-positive cost is low
 *      (operator can manually draft); false-negative cost is the
 *      duplicate-reply pattern the user reported.
 *
 * All gates run BEFORE the brain to save tokens. The pipeline calls
 * `evaluateDraftSkipGates` once after the interaction is persisted +
 * before the brain dispatch.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

const OPERATOR_HANDLING_WINDOW_DAYS = 7
const WEDDING_HANDLING_WINDOW_DAYS = 7
const MS_PER_DAY = 24 * 60 * 60 * 1000

export type DraftSkipReason =
  | 'ai_opted_out'
  | 'operator_handling_thread'
  | 'wedding_recently_handled_by_operator'
  | 'none'

export interface DraftSkipDecision {
  skip: boolean
  reason: DraftSkipReason
  /** Operator-readable explanation, used in admin_notifications + on the
   *  drafts page when explaining why a draft wasn't generated. */
  message: string
  /** When `operator_handling_thread` fired, this is the timestamp of the
   *  most recent operator outbound that triggered the gate. NULL otherwise. */
  triggeringOutboundAt: string | null
}

const NO_SKIP: DraftSkipDecision = {
  skip: false,
  reason: 'none',
  message: '',
  triggeringOutboundAt: null,
}

export interface EvaluateDraftSkipGatesArgs {
  supabase: SupabaseClient
  venueId: string
  /** Nullable — pre-zero inbounds (no wedding row yet) bypass the
   *  wedding-level gate by definition. */
  weddingId: string | null
  /** Nullable — inbounds without a Gmail thread (CSV imports, web-form,
   *  Calendly webhook) skip the thread-level gate. */
  gmailThreadId: string | null
}

export async function evaluateDraftSkipGates(
  args: EvaluateDraftSkipGatesArgs,
): Promise<DraftSkipDecision> {
  const { supabase, venueId, weddingId, gmailThreadId } = args

  // Gate 1: ai_opted_out (sticky per-couple).
  if (weddingId) {
    const { data: wedding } = await supabase
      .from('weddings')
      .select('ai_opted_out, ai_opted_out_at, ai_opted_out_reason')
      .eq('id', weddingId)
      .maybeSingle()
    if (wedding?.ai_opted_out === true) {
      return {
        skip: true,
        reason: 'ai_opted_out',
        message:
          'This couple opted out of AI drafting. Sage will not generate replies until the operator clears the flag on the lead.',
        triggeringOutboundAt: (wedding.ai_opted_out_at as string | null) ?? null,
      }
    }
  }

  // Gate 2: operator already handling this thread. Catches the case
  // where the coordinator manually replied via /agent/send or /agent/
  // reply and Sage would otherwise draft a duplicate response to the
  // next inbound. We look at author_class IN ('operator', 'unknown') —
  // the 'unknown' bucket is the conservative default for outbound the
  // Wave-27 Haiku classifier has not finished classifying yet.
  // Sage's own auto-sends classify (or default-stamp) as 'sage' and do
  // not trigger this gate.
  if (gmailThreadId) {
    const sinceIso = new Date(
      Date.now() - OPERATOR_HANDLING_WINDOW_DAYS * MS_PER_DAY,
    ).toISOString()
    const { data: priorOutbound } = await supabase
      .from('interactions')
      .select('id, timestamp, author_class')
      .eq('venue_id', venueId)
      .eq('gmail_thread_id', gmailThreadId)
      .eq('direction', 'outbound')
      .in('author_class', ['operator', 'unknown'])
      .gte('timestamp', sinceIso)
      .order('timestamp', { ascending: false })
      .limit(1)
    if (priorOutbound && priorOutbound.length > 0) {
      const row = priorOutbound[0] as { timestamp: string }
      return {
        skip: true,
        reason: 'operator_handling_thread',
        message:
          `Skipping draft — the coordinator replied on this thread recently. Sage stays out so the human is the only voice the couple hears until the conversation moves on (${OPERATOR_HANDLING_WINDOW_DAYS}-day window).`,
        triggeringOutboundAt: row.timestamp,
      }
    }
  }

  // Gate 3: wedding-scoped, cross-thread. Catches the gap where the
  // operator replied via Gmail directly on the couple's first inquiry
  // (thread A) and then a Knot reminder / new-channel touch / fresh
  // form-relay arrives in thread B — gate 2 fires on gmail_thread_id
  // equality and misses it. Looking at any outbound on the wedding
  // closes that gap. Same author_class filter — Sage's auto-sends
  // (class 'sage') do NOT trigger this gate. Recipient-agnostic: an
  // operator outbound to a vendor on the wedding will fire too. False-
  // positive cost is low; false-negative cost is the duplicate-reply
  // pattern.
  if (weddingId) {
    const sinceIso = new Date(
      Date.now() - WEDDING_HANDLING_WINDOW_DAYS * MS_PER_DAY,
    ).toISOString()
    const { data: priorOutbound } = await supabase
      .from('interactions')
      .select('id, timestamp, author_class, gmail_thread_id')
      .eq('venue_id', venueId)
      .eq('wedding_id', weddingId)
      .eq('direction', 'outbound')
      .in('author_class', ['operator', 'unknown'])
      .gte('timestamp', sinceIso)
      .order('timestamp', { ascending: false })
      .limit(1)
    if (priorOutbound && priorOutbound.length > 0) {
      const row = priorOutbound[0] as { timestamp: string; gmail_thread_id: string | null }
      // Re-check: if the operator's prior outbound is on the SAME thread
      // as the current inbound, gate 2 already fired (and we wouldn't be
      // here). This branch fires only when it's a DIFFERENT thread —
      // which is the gap we're closing. Skip the no-op match where the
      // gmail_thread_id happens to coincide (defensive — gate 2 should
      // have returned first).
      if (!gmailThreadId || row.gmail_thread_id !== gmailThreadId) {
        return {
          skip: true,
          reason: 'wedding_recently_handled_by_operator',
          message:
            `Skipping draft — the coordinator replied on a different thread for this couple recently. Sage stays out so the human is the only voice the couple hears until the conversation moves on (${WEDDING_HANDLING_WINDOW_DAYS}-day window, wedding-wide).`,
          triggeringOutboundAt: row.timestamp,
        }
      }
    }
  }

  return NO_SKIP
}

/**
 * Set the sticky ai_opted_out flag on a wedding + cancel any pending
 * drafts that haven't been sent yet. Called from the pipeline when a
 * fresh escalation_requested fires, so the next inbound on the same
 * wedding is gated automatically.
 *
 * Idempotent — re-running on an already-opted-out wedding is a no-op.
 */
export async function markWeddingAiOptedOut(args: {
  supabase: SupabaseClient
  weddingId: string
  reason: string
  decidedAt?: string
}): Promise<{ updated: boolean; draftsCancelled: number }> {
  const { supabase, weddingId, reason } = args
  const decidedAt = args.decidedAt ?? new Date().toISOString()

  const { data: current } = await supabase
    .from('weddings')
    .select('ai_opted_out')
    .eq('id', weddingId)
    .maybeSingle()
  if (current?.ai_opted_out === true) {
    return { updated: false, draftsCancelled: 0 }
  }

  const { error: updErr } = await supabase
    .from('weddings')
    .update({
      ai_opted_out: true,
      ai_opted_out_at: decidedAt,
      ai_opted_out_reason: reason,
    })
    .eq('id', weddingId)
  if (updErr) {
    console.warn('[draft-skip-gates] markWeddingAiOptedOut update failed:', updErr.message)
    return { updated: false, draftsCancelled: 0 }
  }

  // Cancel any pending or approved-not-yet-sent drafts on this wedding.
  const { data: cancelled } = await supabase
    .from('drafts')
    .update({
      status: 'rejected',
      feedback_notes: `auto-rejected: couple opted out of AI drafting (${reason})`,
    })
    .eq('wedding_id', weddingId)
    .in('status', ['pending', 'approved', 'auto_send_pending'])
    .select('id')

  return { updated: true, draftsCancelled: cancelled?.length ?? 0 }
}
