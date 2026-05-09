/**
 * Bloom House: Cancellation Reason Classifier (T5-Rixey-JJ)
 *
 * Free-text → enum bucket classifier for tour cancellation reasons.
 * Mirrors the CHECK constraint in migration 176. Used by:
 *   - The tour-scheduler intake adapter (Stream II — once merged, it
 *     replaces its keyword fallback with a call to
 *     extractCancellationReason(freeText)).
 *   - Any future surface that ingests free-text cancellation reasons
 *     (Acuity, HoneyBook event-cancelled webhooks, manual coordinator
 *     entry on /agent/tour-cancel, the post-hoc reconciler).
 *
 * Two-stage:
 *   1. Fast heuristic over the dominant Rixey patterns (Calendly free-
 *      text). Covers ~70-80% of the live data with high confidence and
 *      zero LLM cost.
 *   2. LLM (Sonnet, contentTier=1, cost-ceiling-gated) for the long tail.
 *      Cached by FNV-1a of the trimmed lowercased free-text so identical
 *      reasons across leads / venues don't re-spend.
 *
 * Cost-gate behaviour:
 *   - When the venue's autonomous behavior is paused (Playbook 21.4.3),
 *     the LLM stage is SKIPPED and the result falls back to
 *     heuristic-only. If the heuristic also misses, the result is
 *     { reason: 'other', confidence: 'low', note: <truncated free-text> }.
 *   - This is the right read of the doctrine: cancellation classification
 *     is observability, not a hot send-blocking path. Better to land
 *     'other' on a paused venue than to either hold the write or burn
 *     ceiling.
 *
 * Note vs free-text:
 *   - The returned `note` is the free-text trimmed + clamped to 280 chars
 *     (mirrors migration 166's app-side cap on tours.cancellation_note).
 *     Empty input → empty string.
 *
 * Tier 1 content:
 *   - Free-text cancellation reasons can include couple PII (names,
 *     dates, "my mom is sick"). The LLM call passes contentTier: 1 to
 *     match the existing tour-cancellation-reason.ts treatment.
 */

import { callAIJson } from '@/lib/ai/client'
import { gateForBrainCall } from '@/lib/services/cost-ceiling'
import { withAiCache, aiCacheKey } from '@/lib/ai/cache'
import { redactError } from '@/lib/observability/redact'

/** Prompt revision identifier — see PROMPTS-CHANGELOG.md / OPS-21.5.1.
 *  v1.0 (T5-Rixey-JJ): initial classifier covering migration 176's
 *  extended enum.
 *  v1.1 (LLM-CALL-INVENTORY tier-correctness sweep): demoted Sonnet to
 *  Haiku. Bounded 9-bucket enum with closed schema; sibling Haiku
 *  classifiers (router-brain, lifecycle.signal-detector) handle the
 *  same shape. */
export const BRAIN_PROMPT_VERSION = 'cancellation-classifier.prompt.v1.1'

// ---------------------------------------------------------------------------
// Enum (mirrors migration 176's CHECK)
// ---------------------------------------------------------------------------

export const CANCELLATION_REASONS = [
  'weather',
  'date_conflict',
  'family_emergency',
  'health_emergency',
  'venue_concern',
  'lost_to_competitor',
  'venue_unavailable',
  'travel_blocker',
  'rescheduled',
  'no_show_followup',
  'other',
] as const

export type CancellationReasonEnum = (typeof CANCELLATION_REASONS)[number]

const REASON_SET = new Set<string>(CANCELLATION_REASONS)

export type CancellationConfidence = 'high' | 'medium' | 'low'

export interface CancellationClassification {
  reason: CancellationReasonEnum
  /** Free-text trimmed + clamped to 280 chars. Empty string when input is empty. */
  note: string
  confidence: CancellationConfidence
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** App-side cap mirrors migration 166's tours.cancellation_note guidance. */
const NOTE_MAX_CHARS = 280

function clampNote(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= NOTE_MAX_CHARS) return trimmed
  // Hard truncation; mirrors a tweet so it stays a one-liner.
  return trimmed.slice(0, NOTE_MAX_CHARS - 1) + '…'
}

/** Normalise smart quotes / non-ASCII apostrophes the Calendly export
 *  drops in so heuristic substring checks match real-world text. */
function normaliseForHeuristic(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// Heuristic stage
// ---------------------------------------------------------------------------

interface HeuristicHit {
  reason: CancellationReasonEnum
  confidence: CancellationConfidence
}

/**
 * Pattern table — ordered by specificity. The first hit wins. Patterns
 * are derived from the live Rixey Calendly export (91 cancellations
 * across 12 months). Single-word patterns ("sick", "weather") are
 * intentionally narrow to avoid mid-sentence false positives — e.g.
 * "we love your weather" wouldn't (and shouldn't) match weather.
 *
 * Match rule: substring on a normalised (lowercased, smart-quote-folded,
 * whitespace-collapsed) version of the input. Substring works because
 * the patterns are picked to be unambiguous in cancellation context.
 */
const HEURISTIC_PATTERNS: Array<{
  patterns: string[]
  reason: CancellationReasonEnum
  confidence: CancellationConfidence
}> = [
  // Calendly's own canned reschedule string. Highest signal in the data.
  {
    patterns: ['rescheduled from connected calendar event'],
    reason: 'rescheduled',
    confidence: 'high',
  },

  // Lost to competitor — the top theme in the Rixey data.
  {
    patterns: [
      'another venue',
      'a venue elsewhere',
      'found a venue',
      'found another',
      'went with another',
      'went with a',
      'chose another',
      'chose a different venue',
      'booked another',
      'booked different venue',
      'booked with a venue',
      'decided on a venue',
      'we have found our venue',
      'seeing other venues',
      'pricing',
      'doesnt fit our vision',
      "doesn't fit our vision",
    ],
    reason: 'lost_to_competitor',
    confidence: 'high',
  },

  // Venue-side travel disruption + venue-unavailable patterns. Coordinator
  // illness / flight cancel / facility closure — distinct from couple-
  // side travel_blocker.
  {
    patterns: [
      "isadora's flight",
      'isadoras flight',
      'wedding conference',
      'final walkthroughs',
      'double booked',
      'double-booked',
      'exit brunch',
    ],
    reason: 'venue_unavailable',
    confidence: 'high',
  },

  // Health emergency — illness, Covid, virus, hospital. Broader bucket
  // than family_emergency. Comes before family_emergency because
  // "sick" + "family emergency" can co-occur and we want health_emergency
  // to win when health language is explicit.
  {
    patterns: [
      'covid',
      'got sick',
      'got the flu',
      'have the flu',
      'hospital',
      ' er ',
      'mystery virus',
      'fever',
      'not feeling well',
      'feeling better',
      'came down with',
    ],
    reason: 'health_emergency',
    confidence: 'high',
  },

  // Family emergency / bereavement. Narrower than health_emergency.
  {
    patterns: [
      'family emergency',
      'funeral',
      'bereavement',
      'family conflict',
      'parent conflict',
    ],
    reason: 'family_emergency',
    confidence: 'high',
  },

  // Couple-side travel blocker — flight cancel, illness in transit,
  // out-of-town. Separate from venue_unavailable.
  {
    patterns: [
      'flight cancelled',
      'flight cancel',
      'flight was cancelled',
      'cant travel',
      "can't travel",
      'unable to travel',
      'travelling for work',
      'traveling for work',
    ],
    reason: 'travel_blocker',
    confidence: 'high',
  },

  // Weather. Narrow patterns; "winter storm", "too much snow", "the
  // weather still so cold" are dominant in the data.
  {
    patterns: [
      'winter storm',
      'snow storm',
      'snowstorm',
      'too much snow',
      'rain storm',
      'hurricane',
      'tornado',
      'blizzard',
      'weather still',
      'pushing venue touring',
    ],
    reason: 'weather',
    confidence: 'high',
  },

  // Date conflict — schedule clash, no availability on either side.
  {
    patterns: [
      'date conflict',
      'scheduling conflict',
      'schedule conflict',
      'scheudling conflict', // verbatim typo in Rixey data
      'work conflict',
      'work emergency',
      'work meetings',
      'work schedules',
      'work call',
      'work schedule',
      'navy duty',
      'prior commitment',
      'no availability',
      'does not have availibility', // verbatim Rixey typo
      'does not have availability',
      'does not have our desired date',
      'no availability in our target',
      "won't work for",
      "wont work for",
      'change of personal plan',
      'change of plans',
      'budget issues',
    ],
    reason: 'date_conflict',
    confidence: 'high',
  },
]

/**
 * Run the heuristic stage. Returns null when no pattern matches.
 *
 * Empty / single-character / 'n/a' inputs short-circuit to
 * { reason: 'other', confidence: 'low' } via the caller — not via
 * this function. This function only fires on substantive input.
 */
export function classifyHeuristic(freeText: string): HeuristicHit | null {
  const normalised = normaliseForHeuristic(freeText)
  if (normalised.length === 0) return null

  for (const { patterns, reason, confidence } of HEURISTIC_PATTERNS) {
    for (const p of patterns) {
      if (normalised.includes(p)) {
        return { reason, confidence }
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// FNV-1a 32-bit cache key — mirrors lib/ai/cache.ts hash function
// ---------------------------------------------------------------------------

function fnv1aHash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------------------
// LLM stage
// ---------------------------------------------------------------------------

const LLM_SYSTEM_PROMPT = [
  "You're classifying why a wedding venue tour was cancelled.",
  '',
  'Map the free-text reason to ONE of these categories:',
  '  - weather: storm / snow / hurricane / cold weather forcing a delay',
  '  - date_conflict: schedule clash, no availability, work meeting, prior commitment, budget issue',
  '  - family_emergency: bereavement, funeral, urgent family matter (NOT illness — use health_emergency)',
  '  - health_emergency: illness, Covid, flu, hospital, fever, mystery virus, "not feeling well"',
  '  - venue_concern: the couple raised a concern about the venue itself (didn\'t fit vision, distance, accommodations)',
  '  - lost_to_competitor: the lead chose another venue, found a venue elsewhere, booked elsewhere',
  '  - venue_unavailable: venue-side cancellation — coordinator illness, coordinator travel, facility closure, double-booked',
  '  - travel_blocker: COUPLE-side travel issue (flight cancelled, can\'t travel from out of town)',
  '  - rescheduled: explicit reschedule to another date — lead alive, no other reason given',
  '  - other: anything else, or signal too thin to bucket',
  '',
  'Return JSON only: { "category": "<one of above>", "confidence": "high"|"medium"|"low", "why": "<brief reason>" }',
  '',
  'If the text is vague, single-character, "n/a", or gives no clear signal: pick "other" and confidence "low".',
  'Do not invent reasons. Do not pick a category that doesn\'t fit just to avoid "other".',
].join('\n')

interface LlmRaw {
  category?: unknown
  confidence?: unknown
  why?: unknown
}

async function classifyViaLlm(
  freeText: string,
  venueId: string,
): Promise<{ reason: CancellationReasonEnum; confidence: CancellationConfidence } | null> {
  // Cache by FNV-1a of the normalised free-text. Identical reasons
  // across leads / venues / time share the same Anthropic call within
  // the cache window.
  const normalised = normaliseForHeuristic(freeText)
  const cacheKey =
    'cancel:' +
    fnv1aHash(normalised) +
    ':' +
    aiCacheKey({
      systemPrompt: LLM_SYSTEM_PROMPT,
      userPrompt: normalised,
      model: 'haiku',
      temperature: 0,
      promptVersion: BRAIN_PROMPT_VERSION,
    })

  try {
    const raw = await withAiCache(cacheKey, async () =>
      callAIJson<LlmRaw>({
        systemPrompt: LLM_SYSTEM_PROMPT,
        userPrompt: `Free-text reason: "${freeText.trim().slice(0, 1000)}"`,
        maxTokens: 120,
        temperature: 0,
        venueId,
        taskType: 'cancellation_reason_classify',
        // Tier 1: free-text reason can include couple PII / family
        // context. Same treatment as tour-cancellation-reason.ts.
        contentTier: 1,
        // Haiku per LLM-CALL-INVENTORY tier-correctness sweep: bounded
        // 9-bucket enum, same shape as router-brain + lifecycle signal.
        tier: 'haiku',
        promptVersion: BRAIN_PROMPT_VERSION,
      }),
    )

    const category = typeof raw?.category === 'string' ? raw.category : ''
    const conf = typeof raw?.confidence === 'string' ? raw.confidence : ''

    if (!REASON_SET.has(category)) return null

    let confidence: CancellationConfidence = 'low'
    if (conf === 'high' || conf === 'medium' || conf === 'low') {
      confidence = conf
    }

    return { reason: category as CancellationReasonEnum, confidence }
  } catch (err) {
    // Tier-1 redaction; never throw out of the classifier.
    console.warn('[cancellation-classifier] LLM stage failed:', redactError(err))
    return null
  }
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Classify a free-text cancellation reason into one of migration 176's
 * enum buckets. Always resolves — never throws. See module header for
 * the cost-gate, caching, and tier policy.
 *
 * @param freeText - the raw cancellation reason as supplied by the
 *   couple / coordinator / scheduling-tool webhook
 * @param venueId - venue scope. Required for both cost-gate lookup and
 *   api_costs attribution. When omitted, the LLM stage is SKIPPED
 *   (treated as 'gated') and the result falls back to heuristic-only.
 */
export async function extractCancellationReason(
  freeText: string,
  venueId?: string,
): Promise<CancellationClassification> {
  const note = clampNote(freeText ?? '')

  // Empty / trivially-short inputs short-circuit. 'n/a' / 'na' /
  // single chars are common in the Rixey data and never carry signal.
  const stripped = (freeText ?? '').trim()
  const lower = stripped.toLowerCase()
  if (
    stripped.length <= 1 ||
    lower === 'n/a' ||
    lower === 'na' ||
    lower === 'none' ||
    lower === '(see email)'
  ) {
    return { reason: 'other', note, confidence: 'low' }
  }

  // 1. Heuristic stage.
  const heuristic = classifyHeuristic(stripped)
  if (heuristic) {
    return { reason: heuristic.reason, note, confidence: heuristic.confidence }
  }

  // Below the LLM-worth threshold. <= 10 chars rarely carries enough
  // signal to bucket beyond what the heuristics already caught.
  if (stripped.length <= 10) {
    return { reason: 'other', note, confidence: 'low' }
  }

  // 2. LLM stage — gated.
  if (!venueId) {
    // No venue scope → no cost-gate lookup possible; skip the LLM.
    // The classifier remains useful in non-venue test contexts via
    // the heuristic stage alone.
    return { reason: 'other', note, confidence: 'low' }
  }

  const gate = await gateForBrainCall(venueId)
  if (!gate.ok) {
    // Venue is paused (Playbook 21.4.3). Fall back to heuristic-only
    // result; we've already exhausted heuristics so it's 'other'.
    return { reason: 'other', note, confidence: 'low' }
  }

  const llm = await classifyViaLlm(stripped, venueId)
  if (llm) {
    return { reason: llm.reason, note, confidence: llm.confidence }
  }

  // LLM came back empty / unparseable / errored.
  return { reason: 'other', note, confidence: 'low' }
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

export const __test__ = {
  fnv1aHash,
  clampNote,
  normaliseForHeuristic,
  HEURISTIC_PATTERNS,
  LLM_SYSTEM_PROMPT,
  NOTE_MAX_CHARS,
}
