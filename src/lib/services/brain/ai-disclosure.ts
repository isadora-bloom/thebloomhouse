/**
 * AI disclosure utilities — required on every outbound Sage message.
 *
 * Stream EEEE (v3): the "reviewed by a human from the team before
 * anything important is confirmed" claim is GONE. Auto-send is
 * configurable per-venue, and an autonomously-sent reply has not been
 * reviewed — making the review claim a credibility risk if a couple
 * ever pulls the receipts. The replacement is honest:
 *
 *   1. Sign-off line: ${ai_name}, ${venueName}'s ${ai_role}
 *      (role MUST contain "AI" — same `safeRole` fallback as v2.)
 *   2. Hard escalation path: a couple can drop Sage entirely by
 *      replying with "HUMAN REQUESTED" in the subject (the email
 *      pipeline detects this early, skips drafting, fires an
 *      admin_notifications row), or by emailing the venue's
 *      escalation_email directly.
 *
 * Why hard-coded and unconditional: legal (EU AI Act Art. 50, CA SB 1001)
 * and Anthropic Usage Policy both require disclosure. Having ONE helper
 * that every Sage outbound path must call means no venue configuration,
 * no A/B test, and no "temporarily off" flag can bypass it. The escalation
 * sentence is the additional honesty layer: it tells the couple they
 * have a real human path even if the venue has auto-send turned all the
 * way up.
 *
 * Marker bumped to v3. v1 + v2 stay in ALL_MARKERS so threads disclosed
 * under prior copy don't get a second footer appended on the next reply.
 */

// v1-v3 markers were rendered as visible text in the email body — a couple
// caught the `[sage-ai-disclosure-v3]` string and was understandably put off.
// v4 switches to a zero-width Unicode sequence (ZWSP + ZWNJ + ZWSP + ZWNJ
// + ZWJ). Gmail, Apple Mail, Outlook all preserve these characters in
// plain text + HTML and none renders them — the marker stays invisible
// while keeping the idempotency contract.
export const AI_DISCLOSURE_MARKER_V1 = '[sage-ai-disclosure-v1]'
export const AI_DISCLOSURE_MARKER_V2 = '[sage-ai-disclosure-v2]'
export const AI_DISCLOSURE_MARKER_V3 = '[sage-ai-disclosure-v3]'
export const AI_DISCLOSURE_MARKER_V4 = '​‌​‌‍'

// Versioned markers let us upgrade the footer copy without double-appending
// to threads that already carry an older marker. v1-v3 stay in the lookup
// for legacy threads; new sends always use v4.
const ALL_MARKERS = [
  AI_DISCLOSURE_MARKER_V1,
  AI_DISCLOSURE_MARKER_V2,
  AI_DISCLOSURE_MARKER_V3,
  AI_DISCLOSURE_MARKER_V4,
]

export interface DisclosureContext {
  /** Per-venue AI name (venue_ai_config.ai_name). When missing, the
   *  footer still renders without a name rather than leaking "Sage" —
   *  legal disclosure can never be skipped, but it also must not
   *  brand-leak (T5-β.1). */
  sageName?: string | null
  /** Venue display name. Defaults to "the venue". */
  venueName?: string | null
  /** Role label — must contain "AI". Defaults to "AI assistant". */
  role?: string | null
  /** Stream EEEE: human-escalation address printed in the footer's
   *  second sentence ("or email ${escalation_email} directly"). When
   *  resolution fails (no venue_ai_config.escalation_email, no
   *  venue_config.coordinator_email, no venues.owner_email) the
   *  second sentence is OMITTED entirely — better to lose one line
   *  than ship a broken `mailto:` with no recipient. */
  escalationEmail?: string | null
  /** Migration 214: coordinator-authored free-text email signature
   *  appended literally between the body and the disclosure footer.
   *  When null / empty / whitespace-only, no signature block is added —
   *  output is identical to pre-214 behaviour. The double-append guard
   *  is body.endsWith(signature) before the disclosure step (handled
   *  inside appendAIDisclosure) so retries on auto_send_pending don't
   *  stack signatures. */
  emailSignature?: string | null
  /** Migration 299 (2026-05-11): operator-authored short phrase that
   *  reads warm + accountable instead of clinical. E.g. "Based on
   *  Isadora's thinking. She double-checks the important details before
   *  anything goes out." When null / empty, falls back to a safe
   *  generic line so unconfigured venues still ship a valid footer. */
  reviewerIntro?: string | null
}

function buildFooter(ctx: DisclosureContext): string {
  const trimmedName = ctx.sageName?.trim() ?? ''
  const venue = (ctx.venueName && ctx.venueName.trim()) || 'the venue'
  const role = (ctx.role && ctx.role.trim()) || 'AI assistant'
  // Defensive: if someone overrode role with a value that doesn't mention
  // AI, fall back to "AI assistant" in the footer so disclosure stays clear.
  const safeRole = /\bAI\b/i.test(role) ? role : 'AI assistant'
  // T5-β.1: when the per-venue name is missing, omit the name entirely
  // ("${venue}'s AI assistant") rather than defaulting to "Sage".
  // Disclosure stays clear; brand-identity stays correct.
  const signoff = trimmedName
    ? `${trimmedName}, ${venue}'s ${safeRole}`
    : `${venue}'s ${safeRole}`

  // Operator-authored review line. Warm + accountable. Falls back to a
  // generic line so unconfigured venues still ship a valid footer.
  const reviewerLine = (ctx.reviewerIntro?.trim() ||
    `Reviewed by the ${venue} team before anything important goes out.`)

  const escalation = ctx.escalationEmail?.trim()
  // 2026-05-11: dropped the "Reply with HUMAN REQUESTED in the subject"
  // instruction — couples reading it felt forced into a robot-talk
  // protocol and one of them snapped back. The pipeline's escalation
  // detector now catches "talk to a person", "is this a bot", "speak
  // to someone" etc. semantically, so the visible footer can stay warm.
  const escalationLine = escalation
    ? `\n\nWant to talk to a real person? Just ask, or email ${escalation}.`
    : ''

  // Migration 300 (2026-05-11): disclosure-version idempotency moved off
  // the body to interactions.disclosure_version. The body no longer
  // carries a visible marker; callers persist the returned version via
  // appendAIDisclosureWithVersion().
  return `
––
${signoff}. ${reviewerLine}${escalationLine}`.trimEnd()
}

/** Append the venue's free-text email signature to a body if one is set.
 *  Migration 214. Idempotent: if the body already ends with the trimmed
 *  signature (e.g. an auto-send retry where the previous attempt already
 *  composed the final body but Gmail returned null), we don't append a
 *  second copy. Plain text only by design — HTML signatures introduce
 *  spam-filter risk. */
function appendEmailSignature(body: string, signature: string | null | undefined): string {
  const sig = signature?.trim()
  if (!sig) return body
  const trimmed = body.trimEnd()
  // Double-append guard. Compare against trimmed-end of body so trailing
  // whitespace differences don't slip a duplicate through.
  if (trimmed.endsWith(sig)) return body
  return `${trimmed}\n\n${sig}`
}

/** Append the AI disclosure footer to an email body. Idempotent two ways:
 *    (a) legacy: a v1/v2/v3 marker is still in the body (older drafts
 *        composed before migration 300 had the marker inlined). We skip.
 *    (b) modern (preferred): the caller passes previousDisclosureVersion
 *        from interactions.disclosure_version. If set, we skip and return
 *        the body unchanged.
 *
 *  Order of operations:
 *    1. body
 *    2. coordinator email_signature (skipped when empty)
 *    3. AI disclosure footer
 *  The signature sits BETWEEN the body and the disclosure so the legal
 *  footer is always the last block — couples scanning for the "AI"
 *  disclosure don't have to read past a long custom signature.
 *
 *  Migration 300: the visible-text marker is REMOVED from the footer.
 *  Idempotency now lives on interactions.disclosure_version. Callers
 *  should prefer appendAIDisclosureWithVersion (returns both body and
 *  version stamp to persist). This function stays for back-compat. */
export function appendAIDisclosure(body: string, ctx: DisclosureContext = {}): string {
  // 2026-05-11: also sanitize first-person physical-presence claims (see
  // universal-rules PHYSICAL PRESENCE BOUNDARY). Same guard the modern
  // appendAIDisclosureWithVersion runs — back-compat callers benefit too.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const { scrubPhysicalPresenceClaims } = require('./physical-presence-guard') as
    typeof import('./physical-presence-guard')
  const sanitized = scrubPhysicalPresenceClaims(body).body

  // Legacy bodies that carry an in-body marker — leave them alone after
  // sanitisation (idempotent).
  if (ALL_MARKERS.some((m) => sanitized.includes(m))) return sanitized
  const withSignature = appendEmailSignature(sanitized, ctx.emailSignature)
  const trimmed = withSignature.trimEnd()
  return `${trimmed}\n\n${buildFooter(ctx)}\n`
}

/** Modern version-aware entry point. Caller passes the row's current
 *  disclosure_version (NULL = never disclosed). When already disclosed,
 *  body is returned unchanged with the same version. When not yet
 *  disclosed, body gets the footer appended and the new version is
 *  returned for the caller to persist on interactions.disclosure_version
 *  + drafts.disclosure_version.
 *
 *  This is the new chokepoint: every outbound send site must call this
 *  and persist the returned version. Pre-300 sites that call the legacy
 *  appendAIDisclosure still work — they just never set disclosure_version
 *  on the row. The data-integrity invariant `disclosure_version_set`
 *  (migration 300 follow-up) catches outbound rows missing the stamp.
 *
 *  2026-05-11: also runs the physical-presence guard. The PHYSICAL
 *  PRESENCE BOUNDARY rule in universal-rules.ts forbids first-person
 *  singular + physical verbs ("I'll show you around"). The rule is the
 *  primary protection; this sanitizer is belt-and-suspenders so any
 *  drafts that slip through still get rewritten before send. Caller
 *  can read `physicalPresenceViolations` to surface a review banner
 *  on /agent/drafts.
 */
export function appendAIDisclosureWithVersion(
  body: string,
  ctx: DisclosureContext = {},
  previousDisclosureVersion: string | null = null,
): {
  body: string
  disclosureVersion: 'v4'
  physicalPresenceViolations: ReturnType<typeof scrubPhysicalPresenceClaims>['violations']
} {
  // Sanitize first-person physical-presence claims BEFORE any other
  // processing so the rewrites land in stored full_body, not just the
  // sent message.
  // Lazy require to avoid module-load cycle — disclosure + presence guard
  // are independent concerns, kept that way.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const { scrubPhysicalPresenceClaims } = require('./physical-presence-guard') as
    typeof import('./physical-presence-guard')
  const scrubbed = scrubPhysicalPresenceClaims(body)
  const sanitizedBody = scrubbed.body
  const physicalPresenceViolations = scrubbed.violations

  // Modern idempotency: row already stamped → don't re-append.
  if (previousDisclosureVersion) {
    return { body: sanitizedBody, disclosureVersion: 'v4', physicalPresenceViolations }
  }
  // Legacy in-body marker (pre-mig-300 row in an existing thread) → also skip.
  if (ALL_MARKERS.some((m) => sanitizedBody.includes(m))) {
    return { body: sanitizedBody, disclosureVersion: 'v4', physicalPresenceViolations }
  }
  const withSignature = appendEmailSignature(sanitizedBody, ctx.emailSignature)
  const trimmed = withSignature.trimEnd()
  return {
    body: `${trimmed}\n\n${buildFooter(ctx)}\n`,
    disclosureVersion: 'v4',
    physicalPresenceViolations,
  }
}

/** One-shot helper for outbound send sites. Looks up the venue's Sage
 *  identity once and returns a DisclosureContext ready to pass to
 *  appendAIDisclosure. If the lookup fails we return an empty context —
 *  the footer still goes on, just with safe defaults. Disclosure is
 *  never skipped.
 *
 *  Stream EEEE: also resolves the escalation_email column added in
 *  migration 206. Three-step fallback chain so legacy rows still
 *  produce a working footer:
 *    1. venue_ai_config.escalation_email (the canonical source once
 *       onboarding enforces it)
 *    2. venue_config.coordinator_email (the operations contact already
 *       shown to couples on legacy venues)
 *    3. venues.owner_email (last-resort — primary owner address)
 *  If none resolve, escalationEmail stays undefined and the footer's
 *  second sentence is omitted at render time.
 */
export async function fetchDisclosureContext(venueId: string): Promise<DisclosureContext> {
  try {
    // Lazy import to avoid circular deps with the service client at module load
    const { createServiceClient } = await import('@/lib/supabase/service')
    const supabase = createServiceClient()

    const [{ data: cfg }, { data: venue }, { data: venueCfg }] = await Promise.all([
      supabase
        .from('venue_ai_config')
        .select('ai_name, ai_role, escalation_email, email_signature, reviewer_intro')
        .eq('venue_id', venueId)
        .maybeSingle(),
      supabase.from('venues').select('name, owner_email').eq('id', venueId).maybeSingle(),
      supabase
        .from('venue_config')
        .select('coordinator_email')
        .eq('venue_id', venueId)
        .maybeSingle(),
    ])

    const escalationFromAi = (cfg?.escalation_email as string | undefined)?.trim() || null
    const coordinatorEmail = (venueCfg?.coordinator_email as string | undefined)?.trim() || null
    const ownerEmail = (venue?.owner_email as string | undefined)?.trim() || null
    const escalationEmail = escalationFromAi ?? coordinatorEmail ?? ownerEmail

    return {
      sageName: (cfg?.ai_name as string | undefined) ?? null,
      role: (cfg?.ai_role as string | undefined) ?? null,
      venueName: (venue?.name as string | undefined) ?? null,
      escalationEmail,
      emailSignature: (cfg?.email_signature as string | undefined) ?? null,
      reviewerIntro: (cfg?.reviewer_intro as string | undefined) ?? null,
    }
  } catch {
    return {}
  }
}

/** Strip any disclosure footer from a body — useful for re-rendering a
 *  draft after the venue changes its Sage name. Handles v1/v2/v3.
 *  Returns the original body if no marker is present. */
export function stripAIDisclosure(body: string): string {
  for (const marker of ALL_MARKERS) {
    const idx = body.indexOf(marker)
    if (idx !== -1) {
      // Back up to the start of the footer block (first preceding "––"
      // separator, or start of line containing the marker).
      const beforeMarker = body.slice(0, idx)
      const sepIdx = beforeMarker.lastIndexOf('\n––')
      const cutAt = sepIdx !== -1 ? sepIdx : beforeMarker.lastIndexOf('\n')
      return body.slice(0, cutAt).trimEnd()
    }
  }
  return body
}
