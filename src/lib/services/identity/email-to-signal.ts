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
 *
 * 2026-05-26 — Relay-resolved identity override (operator-impact fix).
 * ---------------------------------------------------------------------
 * For relay-resolved emails (venue_calculator submissions, Calendly-via-
 * Gmail forwards, Zola/Knot/WeddingWire inquiries), the From header
 * carries the venue's OWN address (e.g. `hello@rixeymanor.com`) — NOT
 * the prospect's. Feeding `rawFromEmail` into the cascade signal makes
 * the matcher score `primary_email='hello@rixeymanor.com'` against
 * every couple — useless and actively harmful (collapses unrelated
 * prospects under one venue-self identity).
 *
 * The legacy `findOrCreateContact` path already does the right thing —
 * it swaps `fromEmail` for `formLead.leadEmail` / `schedulingEvent.
 * inviteeEmail` before resolving the contact. The cascade-side
 * `linkSignal` call did NOT — the resolved identity was computed in
 * pipeline.ts and never forwarded to the adapter.
 *
 * The adapter now accepts optional `resolvedEmail` / `resolvedName` /
 * `resolvedPhone` fields. When supplied, they take precedence over
 * `rawFromName` / `rawFromEmail` for the matcher-facing
 * `primary_email` / `primary_name` / `primary_phone` / `identity_hint`.
 * The raw From values are preserved in `raw_payload` for the audit
 * trail. `channelOverride` + `actionTypeOverride` let callers replace
 * the defaults (`'gmail'` / `'reply'`) with the canonical channel for
 * the resolved relay (`'calendly'`, `'knot'`, `'weddingwire'`, `'zola'`,
 * `'website'`) and an appropriate verb (`'tour_booked'`,
 * `'channel_inquiry'`, `'calculator_submitted'`).
 *
 * Backward compatible — callers that don't supply the resolved* fields
 * keep the pre-existing behaviour byte-identical.
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
  /**
   * Post-relay-resolution prospect email (e.g. `formLead.leadEmail`
   * or `schedulingEvent.inviteeEmail`). When set, becomes the
   * matcher-facing `primary_email` instead of `rawFromEmail`. The
   * raw value is preserved in `raw_payload.raw_from_email` for audit.
   *
   * THIS IS THE FIX. Without it the cascade matcher scored relay-
   * resolved emails against `hello@<venue>.com` and split the spine
   * couple in two (one for the calculator submission, one for the
   * Calendly tour notification — same prospect, two unbridged
   * couples).
   */
  resolvedEmail?: string | null
  /** Post-relay-resolution prospect display name (e.g.
   *  `formLead.leadName` or `schedulingEvent.inviteeName`). */
  resolvedName?: string | null
  /** Post-relay-resolution prospect phone, when the relay exposes
   *  one (Calendly `extras.phone` is the typical source; FormRelay
   *  does not currently carry a phone field). */
  resolvedPhone?: string | null
  /**
   * Override the default `'gmail'` channel. Used by relay-resolved
   * signals so the cascade tags the touchpoint with the canonical
   * channel of the underlying relay (`'calendly'`, `'knot'`,
   * `'weddingwire'`, `'zola'`, `'website'`) instead of the carrier
   * Gmail. Channel taxonomy is defined in `sources/types.ts`.
   */
  channelOverride?: string
  /**
   * Override the default action_type (`'reply'` for inbound). For
   * relay-resolved signals this becomes the verb that drives
   * `progression.ts` mapping (e.g. `'tour_booked'` for Calendly,
   * `'channel_inquiry'` for Knot/WW/Zola, `'calculator_submitted'`
   * for venue_calculator).
   */
  actionTypeOverride?: string
  /**
   * Phase 1.1.b (N3 / GC-10 — no silent drops): the full email body and
   * RFC2822 headers, forwarded into `raw_payload` so the SPINE is
   * self-sufficient — it no longer depends on the legacy `interactions`
   * row for body/header content (the circular-dependency that made
   * `interactions` undeletable, gap G1). Optional + backward-compatible:
   * when omitted, raw_payload carries null and behaviour is byte-identical
   * to the pre-1.1 literal.
   */
  fullBody?: string | null
  rfc2822Headers?: Record<string, unknown> | string | null
}

/**
 * Build the cascade `NormalizedSignal` for an email-pipeline event.
 *
 * Output is byte-identical to the pre-P1 inline literal when called
 * with only the required fields (actionType + signalTier defaulted,
 * resolved* + *Override fields omitted).
 *
 * Identity priority for matcher-facing primary_* fields:
 *   1. resolvedEmail / resolvedName / resolvedPhone (when supplied)
 *   2. rawFromName / rawFromEmail (default, byte-identical legacy)
 *
 * Channel + action_type priority:
 *   1. channelOverride / actionTypeOverride (when supplied)
 *   2. 'gmail' / actionType param (default 'reply')
 *
 * raw_payload always carries the From-header values for audit trail.
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
    resolvedEmail = null,
    resolvedName = null,
    resolvedPhone = null,
    channelOverride,
    actionTypeOverride,
    fullBody = null,
    rfc2822Headers = null,
  } = input

  // Identity resolution — relay-resolved values win when present.
  // null/undefined falls through to the raw From header, preserving
  // legacy behaviour for genuine inbound (no formLead, no
  // schedulingEvent) and for outbound (raw From explicitly nulled).
  const primaryEmail = resolvedEmail ?? rawFromEmail
  const primaryName = resolvedName ?? rawFromName
  const primaryPhone = resolvedPhone ?? null
  const identityHint = primaryName ?? primaryEmail ?? null

  // Channel + verb — overrides take precedence so a Calendly-via-Gmail
  // forward lands on touchpoints.channel='calendly' (matching the batch
  // Calendly adapter at sources/calendly.ts), not on 'gmail'. This
  // matters for progression.ts dispatch (e.g. 'tour_booked' on
  // channel='calendly' fires the right progression event).
  const channel = channelOverride ?? 'gmail'
  const finalActionType = actionTypeOverride ?? actionType

  // Whether identity was relay-resolved — emitted in raw_payload for
  // forensics. A relay-resolved signal whose later matching fails is
  // a different failure shape than a raw-From signal whose matching
  // fails; this flag lets operator queries distinguish them without
  // re-parsing the body.
  const identityResolved = Boolean(resolvedEmail || resolvedName || resolvedPhone)

  return {
    external_id: email.messageId ?? interactionId,
    channel,
    action_type: finalActionType,
    occurred_at: emailDate,
    signal_tier: signalTier,
    identity_hint: identityHint,
    primary_name: primaryName,
    primary_email: primaryEmail,
    primary_phone: primaryPhone,
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
      // 2026-05-26: preserve raw From for audit trail when identity
      // was relay-resolved. The cascade matcher reads primary_* only;
      // these fields exist purely for operator forensics
      // (`why did this signal bind to that couple?`).
      raw_from_email: rawFromEmail,
      raw_from_name: rawFromName,
      identity_resolved: identityResolved,
      // Phase 1.1.b (N3 / GC-10): full-fidelity body + headers carried
      // into the spine so the legacy `interactions` row can be retired
      // (gap G1). null until the call site forwards them — byte-identical
      // legacy behaviour in the meantime.
      full_body: fullBody,
      rfc2822_headers: rfc2822Headers,
    },
    legacy_wedding_id: weddingId ?? null,
  }
}
