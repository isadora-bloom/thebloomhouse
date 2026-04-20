/**
 * AI disclosure utilities — required on every outbound Sage message.
 *
 * Commit 2: now templated with per-venue Sage name + venue name. Callers
 * who know the venue pass it in; callers who don't get a safe default.
 * The marker bumps to v2 so old stored footers are still recognised as
 * disclosed (via the v1 substring match) and we don't double-append on
 * migration.
 *
 * Why hard-coded and unconditional: legal (EU AI Act Art. 50, CA SB 1001)
 * and Anthropic Usage Policy both require disclosure. Having ONE helper
 * that every Sage outbound path must call means no venue configuration,
 * no A/B test, and no "temporarily off" flag can bypass it.
 */

export const AI_DISCLOSURE_MARKER_V1 = '[sage-ai-disclosure-v1]'
export const AI_DISCLOSURE_MARKER_V2 = '[sage-ai-disclosure-v2]'

// Versioned markers let us upgrade the footer copy without double-appending
// to threads that already carry an older marker.
const ALL_MARKERS = [AI_DISCLOSURE_MARKER_V1, AI_DISCLOSURE_MARKER_V2]

export interface DisclosureContext {
  /** Per-venue Sage name (venue_config.ai_name). Defaults to "Sage". */
  sageName?: string | null
  /** Venue display name. Defaults to "the venue". */
  venueName?: string | null
  /** Role label — must contain "AI". Defaults to "AI assistant". */
  role?: string | null
}

function buildFooter(ctx: DisclosureContext): string {
  const name = (ctx.sageName && ctx.sageName.trim()) || 'Sage'
  const venue = (ctx.venueName && ctx.venueName.trim()) || 'the venue'
  const role = (ctx.role && ctx.role.trim()) || 'AI assistant'
  // Defensive: if someone overrode role with a value that doesn't mention
  // AI, fall back to "AI assistant" in the footer so disclosure stays clear.
  const safeRole = /\bAI\b/i.test(role) ? role : 'AI assistant'
  return `
––
Replies on this thread are drafted by ${name}, ${venue}'s ${safeRole}, and reviewed by a human from the team before anything important is confirmed. Reply here any time to reach the team directly.
${AI_DISCLOSURE_MARKER_V2}`.trimEnd()
}

/** Append the AI disclosure footer to an email body. Idempotent across
 *  both v1 and v2 markers so migration and retries don't double-disclose. */
export function appendAIDisclosure(body: string, ctx: DisclosureContext = {}): string {
  if (ALL_MARKERS.some((m) => body.includes(m))) return body
  const trimmed = body.trimEnd()
  return `${trimmed}\n\n${buildFooter(ctx)}\n`
}

/** One-shot helper for outbound send sites. Looks up the venue's Sage
 *  identity once and returns a DisclosureContext ready to pass to
 *  appendAIDisclosure. If the lookup fails we return an empty context —
 *  the footer still goes on, just with safe defaults ("Sage" / "the venue").
 *  Disclosure is never skipped. */
export async function fetchDisclosureContext(venueId: string): Promise<DisclosureContext> {
  try {
    // Lazy import to avoid circular deps with the service client at module load
    const { createServiceClient } = await import('@/lib/supabase/service')
    const supabase = createServiceClient()

    const [{ data: cfg }, { data: venue }] = await Promise.all([
      supabase.from('venue_ai_config').select('ai_name, ai_role').eq('venue_id', venueId).maybeSingle(),
      supabase.from('venues').select('name').eq('id', venueId).maybeSingle(),
    ])

    return {
      sageName: (cfg?.ai_name as string | undefined) ?? null,
      role: (cfg?.ai_role as string | undefined) ?? null,
      venueName: (venue?.name as string | undefined) ?? null,
    }
  } catch {
    return {}
  }
}

/** Strip any disclosure footer from a body — useful for re-rendering a
 *  draft after the venue changes its Sage name. Handles both marker
 *  versions. Returns the original body if no marker is present. */
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
