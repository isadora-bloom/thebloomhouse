/**
 * Wave 23 — Platform-agnostic listing-broadcast detector.
 *
 * Generalises Wave 16's knot-template-detector.ts. The mechanics are
 * unchanged — same scoring caps, same personalisation-deficit
 * computation, same body-prep strategy — but the patterns are
 * partitioned by `platform`. The classifier dispatches to this module
 * with the platform inferred from the attribution_event's
 * source_platform (or, when missing, from the inquiry's from_email
 * domain).
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic identity reconstruction; the
 *     detector reads the actual inquiry body and matches against
 *     operator-curated patterns. No self-report trust.)
 *   - bloom-may9-llm-vs-template.md (deterministic where signals are
 *     clear. Template detection IS the deterministic layer; the LLM
 *     judge only handles ambiguous templateScore 40-59 zone.)
 *   - feedback_no_regex_on_user_text.md (regex on user-controlled text
 *     is a hazard. We accept that hazard for broadcast-template
 *     detection because the patterns ARE the platform's strings, not
 *     the user's — every listing platform appends fixed phrases to its
 *     templated sends. Pattern weights stay conservative, and the
 *     primary detector is exact-phrase substring, not regex.)
 *   - feedback_deep_fix_vs_bandaid.md (Wave 16 was the layer fix
 *     grounded in Rixey's Knot corpus; Wave 23 generalises the layer
 *     rather than tacking on per-venue overrides.)
 *
 * What this service does
 * ----------------------
 * Given an interaction (the inquiry email from theknot.com /
 * weddingwire.com / herecomestheguide.com / brides.com / zola.com /
 * junebugweddings.com / caratsandcake.com / stylemepretty.com) AND a
 * declared platform, score how likely it is that the body matches the
 * platform's broadcast template.
 *
 * Two detection axes (unchanged from Wave 16):
 *   1. PRESENCE of broadcast markers (templated phrases, generic
 *      openers, platform footers). Each matched pattern contributes
 *      its weight; total is capped.
 *   2. ABSENCE of personalisation. Computed in code:
 *      - No venue name mention in the first 800 chars
 *      - Very short body (< 200 chars stripped)
 *      - No specific feature/detail mention (date, guest count,
 *        ceremony type)
 *      Personalisation deficit caps at 30 and adds to templateScore.
 *
 * Per-platform pattern partitioning
 * ---------------------------------
 * The detector loads ONLY patterns for the supplied platform (plus
 * platform-agnostic globals stored with platform='other' if any
 * coordinator declared them that way). This avoids the cross-platform
 * false-positive class where a WeddingWire pattern fires on a Knot
 * inquiry that happens to share a phrase, inflating templateScore for
 * the wrong reasons. Per-platform loads also mean a venue using only
 * HCTG can grow its HCTG corpus without touching Knot scores.
 *
 * Idempotent and side-effect free: pure scoring function with one DB
 * read for the patterns.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Canonical platform tokens matching the listing_platform_patterns
 *  CHECK constraint in migration 289. 'unknown' is the return value of
 *  inferPlatformFromInteraction when no domain matches — callers MUST
 *  decide whether to skip classification or fall back to 'other'. */
export type ListingPlatform =
  | 'the_knot'
  | 'weddingwire'
  | 'hctg'
  | 'brides_com'
  | 'zola'
  | 'junebug'
  | 'carats_cake'
  | 'style_me_pretty'
  | 'other'

export type ListingPlatformOrUnknown = ListingPlatform | 'unknown'

export interface DetectorInteraction {
  /** Plain-text body. Subject-line text MAY be prepended by the caller. */
  body: string | null
  body_preview?: string | null
  subject?: string | null
  /** The from_email of the inbound; used by inferPlatformFromInteraction. */
  from_email?: string | null
  /** The venue name, used to detect "did the couple actually reference
   *  this venue?" — absence is a personalisation deficit. */
  venueName?: string | null
}

export interface ListingDetectorInput {
  /** Venue scope. Venue-specific patterns + globals are loaded. */
  venueId: string
  /** Which platform's patterns to evaluate against. */
  platform: ListingPlatform
  interaction: DetectorInteraction
  supabase?: SupabaseClient
}

export interface ListingDetectorOutput {
  /** 0-100, aggregated score across all matched patterns + personalisation deficit. */
  templateScore: number
  /** The pattern_value strings that fired. */
  matchedPatterns: string[]
  /** Components for debugging / audit: phrase-match contribution, regex contribution, personalisation deficit. */
  components: {
    phraseScore: number
    regexScore: number
    personalisationDeficit: number
  }
  /** Hard threshold flag: templateScore >= 60. */
  isLikelyBroadcast: boolean
  /** Which platform the detector ran for. Echoed for caller convenience
   *  (the classifier persists this into the intent_class_signals jsonb). */
  platform: ListingPlatform
}

interface PatternRow {
  id: string
  venue_id: string | null
  platform: string
  pattern_type: 'exact_phrase' | 'regex' | 'similarity_threshold'
  pattern_value: string
  weight: number
  enabled: boolean
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard threshold above which we flag a broadcast candidate. Below
 *  this, the intent classifier looks at post-inquiry engagement; above
 *  this, the classifier applies the "broadcast AND no post-inquiry
 *  engagement = broadcast" rule. Calibrated to the Rixey Knot corpus
 *  in Wave 16; per-platform calibration may bump this per-platform
 *  once new corpora arrive (currently uniform). */
const BROADCAST_THRESHOLD = 60

/** Cap on phrase-match contribution. Same as Wave 16. */
const PHRASE_SCORE_CAP = 75

/** Cap on personalisation-deficit contribution. */
const PERSONALISATION_DEFICIT_CAP = 30

/** Short-body threshold for "no detail" personalisation deficit. */
const SHORT_BODY_THRESHOLD = 200

/** Domain → canonical platform map for inferPlatformFromInteraction.
 *  Order does not matter (longest-match is via direct substring on the
 *  full lowercased from_email). Update this when adding a new platform
 *  to the CHECK constraint. */
const PLATFORM_BY_DOMAIN: Array<{ match: string[]; platform: ListingPlatform }> = [
  // Knot family — includes partner.theknot.com mailing relays.
  { match: ['theknot.com', 'partner.theknot.com', 'member.theknot.com'], platform: 'the_knot' },
  // WeddingWire (incl. authsolic relay).
  { match: ['weddingwire.com', 'authsolic.com'], platform: 'weddingwire' },
  { match: ['herecomestheguide.com'], platform: 'hctg' },
  { match: ['brides.com'], platform: 'brides_com' },
  { match: ['zola.com'], platform: 'zola' },
  { match: ['junebugweddings.com'], platform: 'junebug' },
  { match: ['caratsandcake.com'], platform: 'carats_cake' },
  { match: ['stylemepretty.com'], platform: 'style_me_pretty' },
]

/** source_platform string → canonical ListingPlatform. Handles both
 *  Wave 16's BROADCAST_CAPABLE_PLATFORMS spellings (the_knot, theknot,
 *  theknot.com, weddingwire, wedding_wire, weddingwire.com) and the
 *  newer platforms' canonical tokens. Returns null when the supplied
 *  string isn't a recognised listing platform — the caller should fall
 *  back to inferPlatformFromInteraction or skip. */
const SOURCE_PLATFORM_ALIASES: Record<string, ListingPlatform> = {
  the_knot: 'the_knot',
  theknot: 'the_knot',
  'theknot.com': 'the_knot',
  weddingwire: 'weddingwire',
  wedding_wire: 'weddingwire',
  'weddingwire.com': 'weddingwire',
  hctg: 'hctg',
  herecomestheguide: 'hctg',
  'herecomestheguide.com': 'hctg',
  brides: 'brides_com',
  brides_com: 'brides_com',
  'brides.com': 'brides_com',
  zola: 'zola',
  'zola.com': 'zola',
  junebug: 'junebug',
  junebug_weddings: 'junebug',
  'junebugweddings.com': 'junebug',
  carats_cake: 'carats_cake',
  caratsandcake: 'carats_cake',
  'caratsandcake.com': 'carats_cake',
  style_me_pretty: 'style_me_pretty',
  stylemepretty: 'style_me_pretty',
  'stylemepretty.com': 'style_me_pretty',
}

// ---------------------------------------------------------------------------
// Platform inference (public)
// ---------------------------------------------------------------------------

/**
 * Derive the canonical platform for an interaction. Strategy (first
 * match wins):
 *
 *   1. If the caller has a source_platform value (e.g. on the
 *      attribution_event row), normalise it via SOURCE_PLATFORM_ALIASES.
 *      This is the strongest signal — the pipeline already attributed
 *      this event to a listing platform.
 *   2. Otherwise, look at from_email and substring-match against
 *      PLATFORM_BY_DOMAIN.
 *   3. Return 'unknown' if neither matches. Callers decide whether to
 *      skip (Wave 16 doctrine: 'unknown' → unclassified) or force-
 *      classify as 'other'.
 *
 * This is the entry point the intent-classifier uses when an event's
 * source_platform is missing or generic. Pure function — no DB read.
 */
export function inferPlatformFromInteraction(
  interaction: { from_email?: string | null },
  sourcePlatform?: string | null,
): ListingPlatformOrUnknown {
  // 1) Explicit source_platform takes precedence.
  if (sourcePlatform) {
    const key = sourcePlatform.toLowerCase().trim()
    const mapped = SOURCE_PLATFORM_ALIASES[key]
    if (mapped) return mapped
  }

  // 2) Fall back to from_email domain match.
  const from = (interaction.from_email ?? '').toLowerCase()
  if (from) {
    for (const entry of PLATFORM_BY_DOMAIN) {
      for (const m of entry.match) {
        if (from.includes(m)) return entry.platform
      }
    }
  }

  return 'unknown'
}

// ---------------------------------------------------------------------------
// Pattern loader (per-platform)
// ---------------------------------------------------------------------------

async function loadPatterns(
  sb: SupabaseClient,
  venueId: string,
  platform: ListingPlatform,
): Promise<PatternRow[]> {
  // Per-platform load: globals (venue_id IS NULL) + venue-scoped, all
  // filtered to the platform AND enabled=true. Knot patterns NEVER
  // evaluate against a non-Knot inquiry — cross-platform false
  // positives are the bug Wave 23 is closing.
  const { data, error } = await sb
    .from('listing_platform_patterns')
    .select('id, venue_id, platform, pattern_type, pattern_value, weight, enabled')
    .eq('enabled', true)
    .eq('platform', platform)
    .or(`venue_id.is.null,venue_id.eq.${venueId}`)
  if (error) {
    console.warn('[listing-platform-detector] pattern load failed:', error.message, {
      platform,
      venueId,
    })
    return []
  }
  return (data ?? []) as PatternRow[]
}

// ---------------------------------------------------------------------------
// Body preparation
// ---------------------------------------------------------------------------

/**
 * Strip the listing platform's universal email-chrome that does NOT
 * belong to the couple's actual message. Without this, every inquiry
 * trivially matches the platform's footer pattern even when the
 * couple wrote a long, personalised body — false positives.
 *
 * Wave 16's stripping was Knot-specific. Wave 23 extends it to the
 * other platforms (best-effort; each platform's chrome is fixed string
 * appended to every templated send, so substring-strip works).
 *
 * NOTE: we still keep the chrome in the RAW haystack for pattern
 * matching — the platform-footer pattern firing IS strong broadcast
 * evidence. The stripped body only feeds the personalisation-deficit
 * computation (so a templated short ask can't hide behind 20 lines of
 * chrome).
 */
function stripPlatformChrome(body: string): string {
  let s = body
  // Knot chrome (Wave 16)
  s = s.replace(/The Knot Pro Network[\s\S]*?={5,}/i, '')
  s = s.replace(/={5,}/g, '')
  s = s.replace(/New (Lead|Message)( for| from| to)[^\n]*\n/gi, '')
  s = s.replace(/Reply:?\s*https?:\/\/email\.partner\.theknot\.com[^\s]*/gi, '')
  s = s.replace(/By replying, you agree[\s\S]*?(Acceptable Content Polic\w+)?[^\n]*/gi, '')
  s = s.replace(/(your messages may be monitored[\s\S]*?security)/gi, '')
  s = s.replace(/WeddingPro\s*-{5,}[\s\S]*$/i, '')
  s = s.replace(/https?:\/\/[^\s]*weddingwire\.com[^\s]*/gi, '')
  // Wave 23 additions — best-effort domain-based pixel strip.
  s = s.replace(/https?:\/\/[^\s]*herecomestheguide\.com[^\s]*/gi, '')
  s = s.replace(/https?:\/\/[^\s]*zola\.com[^\s]*/gi, '')
  s = s.replace(/https?:\/\/[^\s]*junebugweddings\.com[^\s]*/gi, '')
  s = s.replace(/https?:\/\/[^\s]*caratsandcake\.com[^\s]*/gi, '')
  s = s.replace(/https?:\/\/[^\s]*stylemepretty\.com[^\s]*/gi, '')
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

function matchExactPhrase(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

function matchRegex(haystack: string, regexSource: string): boolean {
  try {
    const re = new RegExp(regexSource, 'im')
    return re.test(haystack)
  } catch (err) {
    console.warn('[listing-platform-detector] bad regex pattern; skipping', {
      regexSource,
      err: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

// ---------------------------------------------------------------------------
// Personalisation-deficit computation (unchanged from Wave 16)
// ---------------------------------------------------------------------------

function personalisationDeficit(strippedBody: string, venueName: string | null | undefined): number {
  let deficit = 0
  const sample = strippedBody.slice(0, 800).toLowerCase()

  if (venueName && venueName.trim().length > 0) {
    const tokens = venueName.toLowerCase().split(/\s+/).filter((t) => t.length >= 4)
    const nameMentioned =
      sample.includes(venueName.toLowerCase()) ||
      tokens.some((t) => sample.includes(t))
    if (!nameMentioned) deficit += 15
  }

  if (strippedBody.length < SHORT_BODY_THRESHOLD) {
    deficit += 10
  }

  const hasYear = /\b20\d{2}\b/.test(sample)
  const hasGuestCount = /\b\d{2,4}\b\s*(guests|people|attendees|expecting)\b/i.test(sample) ||
    /\b(expecting|hosting)\s+\d/i.test(sample) ||
    /\b\d{2,4}\s*-\s*\d{2,4}\s*(guests|people)\b/i.test(sample)
  const hasCeremonyHint = /\b(ceremony|reception|outdoor|indoor|cultural|interfaith|catholic|jewish|hindu|elopement|micro-?wedding|destination)\b/i.test(
    sample,
  )
  if (!hasYear && !hasGuestCount && !hasCeremonyHint) {
    deficit += 5
  }

  return Math.min(deficit, PERSONALISATION_DEFICIT_CAP)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Score an inquiry interaction against the supplied platform's
 * broadcast patterns. Returns the templateScore (0-100), matched
 * pattern_value strings, component breakdown, and the boolean
 * isLikelyBroadcast flag (templateScore >= BROADCAST_THRESHOLD).
 */
export async function detectListingBroadcast(
  input: ListingDetectorInput,
): Promise<ListingDetectorOutput> {
  const sb = input.supabase ?? createServiceClient()
  const patterns = await loadPatterns(sb, input.venueId, input.platform)

  const rawParts = [
    input.interaction.subject ?? '',
    input.interaction.body_preview ?? '',
    input.interaction.body ?? '',
  ]
  const rawHaystack = rawParts.join('\n').trim()
  const strippedBody = stripPlatformChrome(input.interaction.body ?? '')

  let phraseScore = 0
  let regexScore = 0
  const matched: string[] = []

  for (const p of patterns) {
    if (p.pattern_type === 'similarity_threshold') {
      // Reserved for future cosine-sim matchers; not implemented.
      continue
    }
    if (p.pattern_type === 'exact_phrase') {
      if (matchExactPhrase(rawHaystack, p.pattern_value)) {
        phraseScore += Number(p.weight)
        matched.push(p.pattern_value)
      }
    } else if (p.pattern_type === 'regex') {
      if (matchRegex(rawHaystack, p.pattern_value)) {
        regexScore += Number(p.weight)
        matched.push(p.pattern_value)
      }
    }
  }

  phraseScore = Math.min(phraseScore, PHRASE_SCORE_CAP)
  regexScore = Math.min(regexScore, PHRASE_SCORE_CAP)
  const deficit = personalisationDeficit(strippedBody, input.interaction.venueName ?? null)

  const combinedSignal = Math.min(phraseScore + regexScore, PHRASE_SCORE_CAP)
  const templateScore = Math.min(combinedSignal + deficit, 100)

  return {
    templateScore: Math.round(templateScore),
    matchedPatterns: matched,
    components: {
      phraseScore: Math.round(phraseScore),
      regexScore: Math.round(regexScore),
      personalisationDeficit: Math.round(deficit),
    },
    isLikelyBroadcast: templateScore >= BROADCAST_THRESHOLD,
    platform: input.platform,
  }
}
