/**
 * Phase 1 Batch 1 — P1: inbound-email → NormalizedSignal adapter.
 *
 * Anchor: PHASE-1-BATCH-1.md §2 P1 + CASCADE-CANONICAL-WRITER.md.
 *
 * The live email pipeline (`processIncomingEmail`) constructs a
 * `NormalizedSignal` and hands it to `linkSignal` (the Forwards Linker)
 * so the cascade can rebuild couples/touchpoints in lockstep with the
 * legacy `interactions` insert.
 *
 * Before P1 this was an inline object literal at `pipeline.ts:4113`.
 * Batch-1 migrate sites M1/M6/M7 must all build the signal the *same*
 * way, so the literal is extracted here into a named, reusable adapter.
 *
 * NOTE — this is the LIVE inbound adapter. It is distinct from
 * `identity/sources/gmail.ts`'s `walk()`, which reads the historical
 * `interactions` table for the batch Backwards Tracer. `walk()` is a
 * DB-row → signal converter for the sweep; this file is a
 * parsed-email → signal converter for the live tick. They both yield
 * `NormalizedSignal` but have no shared code path and must not be
 * conflated.
 */

import type { NormalizedSignal } from './sources/types'

/** The parsed-email fields the adapter reads. Mirrors the subset of
 *  `IncomingEmail` (pipeline.ts) the inline literal touched. Kept as a
 *  local interface so this file does not import from `email/pipeline.ts`
 *  (which would create a cycle — pipeline.ts imports this). */
export interface EmailSignalInput {
  /** Parsed inbound email. */
  email: {
    messageId?: string | null
    threadId?: string | null
    subject?: string | null
  }
  /** The legacy `interactions` row id created for this email. Used as
   *  the external_id fallback and threaded into raw_payload. */
  interactionId: string
  /** ISO timestamp the email was sent (NOT ingest time). */
  emailDate: string
  /** Raw display name parsed off the `From:` header, if any. */
  rawFromName?: string | null
  /** Raw email address parsed off the `From:` header, if any. */
  rawFromEmail?: string | null
  /** The draft id generated in response, if any. */
  draftId?: string | null
  /** Legacy weddings.id this email is bound to, if the pipeline
   *  already resolved one. Passed as the matcher's anchor hint. */
  weddingId?: string | null
  /**
   * Channel-specific verb. Defaults to 'reply' for inbound email.
   * Outbound migrate sites (M6 isOwnOutbound, M7 sendApprovedDraft)
   * pass 'outbound' / 'venue_sent'.
   */
  actionType?: string
  /**
   * Per-signal tier. Defaults to 'high'.
   *
   * REVIEW (PHASE-1-BATCH-1.md §2 P1): the original inline literal
   * hard-coded 'high' for every inbound email. That matches the
   * sibling batch adapter `sources/gmail.ts`, which also assigns
   * inbound Gmail the 'high' tier ("full identity: email + often a
   * signature with name + phone"). So 'high' is the correct, doctrine-
   * consistent default for inbound email here.
   *
   * The open question is whether *outbound* venue-sent email should
   * be 'high' — `sources/gmail.ts` drops outbound to 'medium'
   * (a venue marketing send is not couple progression, per doctrine
   * §3). Rather than silently bake one answer in, the tier is exposed
   * as an optional param: M1 (inbound) keeps the 'high' default; M6/M7
   * (outbound) should pass 'medium' when they wire through this
   * adapter. Until those sites flip, behaviour is byte-identical to
   * the pre-P1 literal.
   */
  signalTier?: NormalizedSignal['signal_tier']
}

/**
 * Build the cascade `NormalizedSignal` for an email-pipeline event.
 *
 * Output is byte-identical to the pre-P1 inline literal when called
 * with only the required fields (actionType + signalTier defaulted).
 */
export function emailToNormalizedSignal(input: EmailSignalInput): NormalizedSignal {
  const {
    email,
    interactionId,
    emailDate,
    rawFromName = null,
    rawFromEmail = null,
    draftId = null,
    weddingId = null,
    actionType = 'reply',
    signalTier = 'high',
  } = input

  return {
    external_id: email.messageId ?? interactionId,
    channel: 'gmail',
    action_type: actionType,
    occurred_at: emailDate,
    signal_tier: signalTier,
    identity_hint: rawFromName ?? rawFromEmail ?? null,
    primary_name: rawFromName ?? null,
    primary_email: rawFromEmail ?? null,
    primary_phone: null,
    partner_name: null,
    partner_email: null,
    partner_phone: null,
    wedding_date: null,
    session_ip: null,
    session_fingerprint: null,
    raw_payload: {
      subject: email.subject,
      interaction_id: interactionId,
      draft_id: draftId,
      thread_id: email.threadId ?? null,
    },
    legacy_wedding_id: weddingId ?? null,
  }
}
