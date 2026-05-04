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

export const AI_DISCLOSURE_MARKER_V1 = '[sage-ai-disclosure-v1]'
export const AI_DISCLOSURE_MARKER_V2 = '[sage-ai-disclosure-v2]'
export const AI_DISCLOSURE_MARKER_V3 = '[sage-ai-disclosure-v3]'

// Versioned markers let us upgrade the footer copy without double-appending
// to threads that already carry an older marker.
const ALL_MARKERS = [
  AI_DISCLOSURE_MARKER_V1,
  AI_DISCLOSURE_MARKER_V2,
  AI_DISCLOSURE_MARKER_V3,
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

  const escalation = ctx.escalationEmail?.trim()
  // Stream EEEE: never ship a broken `mailto:` link. If no address
  // resolves, drop the second sentence rather than shipping
  // "or email  directly".
  const escalationLine = escalation
    ? `\n\nNeed a human? Reply with "HUMAN REQUESTED" in the subject, or email ${escalation} directly.`
    : ''

  return `
––
${signoff}${escalationLine}
${AI_DISCLOSURE_MARKER_V3}`.trimEnd()
}

/** Append the AI disclosure footer to an email body. Idempotent across
 *  v1 / v2 / v3 markers so migration and retries don't double-disclose. */
export function appendAIDisclosure(body: string, ctx: DisclosureContext = {}): string {
  if (ALL_MARKERS.some((m) => body.includes(m))) return body
  const trimmed = body.trimEnd()
  return `${trimmed}\n\n${buildFooter(ctx)}\n`
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
        .select('ai_name, ai_role, escalation_email')
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
