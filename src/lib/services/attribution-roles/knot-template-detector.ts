/**
 * Wave 16 — Knot/WeddingWire broadcast template detector.
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic reconstruction; the detector is
 *     forensic — it reads the actual inquiry body and matches against
 *     operator-curated patterns. No self-report trust.)
 *   - bloom-may9-llm-vs-template.md (deterministic where signals are
 *     clear. Template detection IS the deterministic layer; the LLM
 *     judge only handles ambiguous templateScore 40-59 zone.)
 *   - feedback_no_regex_on_user_text.md (regex on user-controlled text
 *     is a hazard. We accept that hazard for broadcast-template
 *     detection because the patterns ARE the platform's strings, not
 *     the user's — Knot and WW append the same fixed phrases to every
 *     templated send. Pattern weights stay conservative, and the
 *     primary detector is exact-phrase (case-insensitive substring),
 *     not regex.)
 *
 * What this service does
 * ----------------------
 * Given an interaction (the inquiry email from theknot.com /
 * weddingwire.com), score how likely it is that the body matches a
 * Knot/WW broadcast template — the auto-distributed "Inquire to
 * similar venues" send rather than a couple actively choosing this
 * venue.
 *
 * Two detection axes:
 *   1. PRESENCE of broadcast markers (templated phrases, generic
 *      openers, platform footers). Each matched pattern contributes
 *      its weight; total is capped at 100.
 *   2. ABSENCE of personalisation. Computed in code rather than the
 *      pattern table:
 *      - No venue name mention in first 500 chars
 *      - Very short body (< 200 chars body excluding platform chrome)
 *      - No specific feature/detail mention (date, guest count,
 *        ceremony type)
 *      Absence-of-personalisation adds a separate "personalisation
 *      deficit" component (0-30) to the templateScore.
 *
 * The output `isLikelyBroadcast` is a hard threshold (>= 60). The
 * intent-classifier consumes the full score + matched patterns and
 * combines with post-inquiry engagement signals to decide
 * intent_class.
 *
 * Idempotent and side-effect free: pure scoring function with one DB
 * read for the patterns.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DetectorInteraction {
  /** Plain-text body. Subject-line text MAY be prepended by the caller. */
  body: string | null
  body_preview?: string | null
  subject?: string | null
  /** The venue name, used to detect "did the couple actually reference
   *  this venue?" — absence is a personalisation deficit. */
  venueName?: string | null
}

export interface DetectorInput {
  venueId: string
  interaction: DetectorInteraction
  supabase?: SupabaseClient
}

export interface DetectorOutput {
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
}

interface PatternRow {
  id: string
  venue_id: string | null
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
 *  engagement = broadcast" rule.
 *
 *  Calibrated to the Rixey corpus: phrases like "we saw your listing"
 *  (30) + "looking for" + footer (25) typically fire together in real
 *  Knot broadcasts, summing to ~70+. Single-pattern matches stay below
 *  60 to avoid false-positives. */
const BROADCAST_THRESHOLD = 60

/** Cap on phrase-match contribution. We sum weights but cap to avoid
 *  an inquiry with 8 broadcast phrases pegging at 200 (which would
 *  drown out personalisation deficit downstream). */
const PHRASE_SCORE_CAP = 75

/** Cap on personalisation-deficit contribution. */
const PERSONALISATION_DEFICIT_CAP = 30

/** Short-body threshold for "no detail" personalisation deficit. */
const SHORT_BODY_THRESHOLD = 200

// ---------------------------------------------------------------------------
// Pattern loader
// ---------------------------------------------------------------------------

async function loadPatterns(
  sb: SupabaseClient,
  venueId: string,
): Promise<PatternRow[]> {
  // Globals (venue_id IS NULL) + venue-scoped. Both filtered to enabled=true.
  const { data, error } = await sb
    .from('knot_template_patterns')
    .select('id, venue_id, pattern_type, pattern_value, weight, enabled')
    .eq('enabled', true)
    .or(`venue_id.is.null,venue_id.eq.${venueId}`)
  if (error) {
    console.warn('[knot-template-detector] pattern load failed:', error.message)
    return []
  }
  return (data ?? []) as PatternRow[]
}

// ---------------------------------------------------------------------------
// Body preparation
// ---------------------------------------------------------------------------

/**
 * Strip Knot's universal email-chrome that does NOT belong to the
 * couple's actual message. Without this, every Knot inquiry trivially
 * matches the "Acceptable Content Policy" footer pattern even when the
 * couple wrote a long, personalised body — false positives.
 *
 * What we strip:
 *   - "The Knot Pro Network" header block (the equals-sign rule + the
 *     "New Lead/Message from X to Y" line)
 *   - "By replying, you agree that your messages may be monitored..."
 *     footer (one of our seed patterns, but we still strip it from the
 *     COUPLE-MESSAGE-ONLY view because it's chrome, not couple speech)
 *   - "WeddingPro" header + reply links
 *
 * NOTE: we DO keep the footer for detection purposes (the footer
 * pattern is in the seed table), but we score the body in TWO modes:
 *   - "raw" mode: includes the chrome → finds pattern-table matches
 *     including platform-footer signals (a strong broadcast marker)
 *   - "stripped" mode: chrome removed → used for personalisation-
 *     deficit computation (so a templated short ask doesn't hide
 *     behind 20 lines of platform chrome).
 *
 * This function returns the STRIPPED body. The raw body is the
 * caller's input.
 */
function stripPlatformChrome(body: string): string {
  let s = body
  // Knot Pro Network header (variable equals-sign lengths)
  s = s.replace(/The Knot Pro Network[\s\S]*?={5,}/i, '')
  s = s.replace(/={5,}/g, '')
  s = s.replace(/New (Lead|Message)( for| from| to)[^\n]*\n/gi, '')
  // Reply link Knot appends
  s = s.replace(/Reply:?\s*https?:\/\/email\.partner\.theknot\.com[^\s]*/gi, '')
  // Acceptable Content Policy footer
  s = s.replace(/By replying, you agree[\s\S]*?(Acceptable Content Polic\w+)?[^\n]*/gi, '')
  s = s.replace(/(your messages may be monitored[\s\S]*?security)/gi, '')
  // WeddingPro close-loop block
  s = s.replace(/WeddingPro\s*-{5,}[\s\S]*$/i, '')
  // WeddingWire / hyperlink trace pixels
  s = s.replace(/https?:\/\/[^\s]*weddingwire\.com[^\s]*/gi, '')
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
    // Multiline-aware, case-insensitive. The seed patterns use anchors;
    // for free-form patterns the caller can use (?:...) groups.
    const re = new RegExp(regexSource, 'im')
    return re.test(haystack)
  } catch (err) {
    console.warn('[knot-template-detector] bad regex pattern; skipping', {
      regexSource,
      err: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

// ---------------------------------------------------------------------------
// Personalisation-deficit computation
// ---------------------------------------------------------------------------

/**
 * Compute a 0-30 score reflecting how impersonal / "could-be-any-
 * venue" the stripped body looks. Higher = more deficit = more
 * broadcast-like.
 *
 * Components (each contributes up to its own cap):
 *   - venue-name absence: +15 when venueName provided and not
 *     mentioned in body (case-insensitive substring on first 500 chars)
 *   - short-body: +10 when stripped body is < SHORT_BODY_THRESHOLD chars
 *   - no specifics: +5 when no date-like or guest-count-like marker is
 *     present
 */
function personalisationDeficit(strippedBody: string, venueName: string | null | undefined): number {
  let deficit = 0
  const sample = strippedBody.slice(0, 800).toLowerCase()

  // Venue-name absence
  if (venueName && venueName.trim().length > 0) {
    // Drop common suffixes that might not appear ("Manor", "Estate", "Gardens").
    // Match on the most distinctive token of the venue name.
    const tokens = venueName.toLowerCase().split(/\s+/).filter((t) => t.length >= 4)
    const nameMentioned =
      sample.includes(venueName.toLowerCase()) ||
      tokens.some((t) => sample.includes(t))
    if (!nameMentioned) deficit += 15
  }

  // Short body
  if (strippedBody.length < SHORT_BODY_THRESHOLD) {
    deficit += 10
  }

  // No specifics — neither a year-like 20XX, nor a guest count, nor a
  // ceremony / date hint.
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

export async function detectKnotTemplateSignal(
  input: DetectorInput,
): Promise<DetectorOutput> {
  const sb = input.supabase ?? createServiceClient()
  const patterns = await loadPatterns(sb, input.venueId)

  // Compose haystack: subject + body_preview + body. The platform-
  // chrome stripper runs once below for the personalisation-deficit
  // path; the raw haystack feeds pattern-match (where finding the
  // chrome footer IS evidence).
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
      // Reserved for future cosine-sim style matchers; not implemented.
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

  // Combine. The cap structure ensures no single dimension can push the
  // score over 100 alone:
  //   - phrase + regex contribute up to PHRASE_SCORE_CAP combined.
  //   - personalisation deficit contributes up to PERSONALISATION_DEFICIT_CAP.
  // We sum and then cap at 100 again for safety.
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
  }
}
