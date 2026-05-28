/**
 * Bloom House — Cohort-query brain.
 *
 * Translates an operator's natural-language query
 *   ("find everyone i had a tour with this weekend")
 * into a deterministic CohortQuery shape the executor in
 * `lib/services/cohort/operator-query.ts` can run against the database.
 *
 * The chain (BLOOM-TEST-QUESTIONS.md Q37):
 *
 *   1. parseCohortQuery (this file) — NL → structured query
 *   2. executeCohortQuery — query → CoupleListItem[]
 *   3. Operator verification gate (UI)
 *   4. bulkDraftFollowUps — confirmed couples → drafts with state-aware
 *      skip on anyone who already received a follow-up
 *
 * This brain does ONLY step 1. It never reads venue data — it just
 * compiles the operator's intent into a typed query so the executor
 * stays auditable + non-LLM. Sonnet tier because temporal phrases
 * ("this weekend" vs "next weekend" vs "the weekend just past") need
 * common-sense reasoning over today's date.
 *
 * Doctrine fit: LLM judges, structured signals decide
 * ([[bloom-classifier-unification]]). The brain is the judge; the
 * executor is the decision.
 */

import { callAIJson } from '@/lib/ai/client'

export const BRAIN_PROMPT_VERSION = 'cohort-query.prompt.v1'

// ---------------------------------------------------------------------------
// Types — the deterministic shape the executor reads
// ---------------------------------------------------------------------------

/**
 * The lifecycle moment the cohort is anchored to. Each maps to a
 * specific table / event_type in `executeCohortQuery`:
 *
 *   tour_completed    → engagement_events.event_type='tour_completed'
 *                       (incl. tour_scheduled time-aware promoted to
 *                       completed because eventDatetime is in the past)
 *   tour_scheduled    → engagement_events.event_type='tour_scheduled'
 *                       AND metadata.event_datetime in the future
 *   inquiry_received  → weddings.inquiry_date
 *   estimate_submitted→ engagement_events.event_type='estimate_submitted'
 *                       (calculator hits)
 *   no_reply          → wedding has an inbound in window but no operator-
 *                       authored outbound after it
 *   booked            → weddings.booked_at
 *
 * The executor maps each anchor to the right table; the brain just
 * picks the semantically right one.
 */
export type CohortAnchor =
  | 'tour_completed'
  | 'tour_scheduled'
  | 'inquiry_received'
  | 'estimate_submitted'
  | 'no_reply'
  | 'booked'

/** Inclusive ISO date range (YYYY-MM-DD on each end). */
export interface CohortTimeWindow {
  from: string
  to: string
}

export interface CohortQuery {
  /** Which lifecycle moment the cohort is anchored on. */
  anchor: CohortAnchor
  /** Date window the anchor must fall within. NULL means "any time". */
  time_window: CohortTimeWindow | null
  /** Drop couples whose current lifecycle_state matches any of these
   *  (case-insensitive). Defaults to `['lost', 'cancelled']` when the
   *  brain doesn't have a stronger signal — most operator queries
   *  implicitly want active leads. */
  exclude_lifecycle_states: string[]
  /** Only keep couples in these lifecycle_states (case-insensitive).
   *  When non-empty, this OVERRIDES exclude_lifecycle_states. */
  include_lifecycle_states: string[]
  /** Source filter applied to weddings.source (canonical channel string,
   *  e.g. 'the_knot', 'venue_calculator', 'zola'). Empty array = all
   *  sources. */
  source_filter: string[]
  /** Brain's interpretation of the operator's request, in one
   *  sentence — surfaced on the verification UI so the operator can
   *  spot misreads (e.g. "I read this as tours completed Fri-Sun of
   *  this week; if you meant next weekend, refine the query"). */
  interpretation: string
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(today: string): string {
  return `You translate a wedding-venue operator's natural-language question into a structured cohort query.

TODAY IS: ${today}

The operator's question describes a COHORT of couples (not one person). Your job is to map the question to ONE of six anchors + a date window + a few filters. Be conservative: when the question is ambiguous, pick the narrower interpretation and explain it in the 'interpretation' field.

ANCHOR — pick exactly one:

  tour_completed     — couples who already came in for a tour ("everyone I toured with", "this weekend's tours", "tours last month")
  tour_scheduled     — couples booked for a tour but haven't been yet ("upcoming tours", "this weekend's tours" when it's Mon-Thu)
  inquiry_received   — couples who reached out ("new inquiries this week", "leads from August")
  estimate_submitted — couples who ran the pricing calculator ("calculator submissions", "estimates last week")
  no_reply           — couples we haven't responded to yet ("anyone I haven't replied to", "open inquiries")
  booked             — couples who signed ("recent bookings", "couples who booked in October")

TIME WINDOW — inclusive ISO YYYY-MM-DD range, OR null when the question says nothing about timing.

Relative-date conventions:
  - "today" / "yesterday" → single-day window
  - "this week" → Monday-Sunday of the current calendar week
  - "this weekend" → Friday-Sunday of the current calendar week
  - "last weekend" → Friday-Sunday of the PRIOR calendar week
  - "next weekend" → Friday-Sunday of the FOLLOWING calendar week
  - "this month" / "last month" → calendar month bounds
  - "last N days" → today minus N through today
  - "in October 2027" → calendar bounds for that month/year

LIFECYCLE FILTERS:

  exclude_lifecycle_states  — default: ["lost","cancelled"]. Use this for most operator queries (they implicitly want active leads).
  include_lifecycle_states  — only set this when the question explicitly names states ("show me my booked couples" → include ["booked"]).

SOURCE FILTER:

  source_filter — array of canonical source labels: "the_knot", "wedding_wire", "zola", "venue_calculator", "here_comes_the_guide", "instagram", "website", "direct", "referral", "google". Empty array = all sources.

INTERPRETATION:

A single sentence that paraphrases your structured query so the operator can spot a misread BEFORE acting. Example: "I read this as tours completed Friday May 23 through Sunday May 25; if you meant next weekend, refine the query."

OUTPUT — strict JSON, no markdown:

{
  "anchor": "<one of the six>",
  "time_window": { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" } OR null,
  "exclude_lifecycle_states": [...],
  "include_lifecycle_states": [...],
  "source_filter": [...],
  "interpretation": "<single sentence>"
}`
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ParseCohortQueryOptions {
  /** The operator's free-text question. */
  input: string
  /** Today's date (ISO YYYY-MM-DD) — passed in so callers can pin the
   *  brain to a test clock if needed. */
  today: string
  /** Venue scope — logged on the api_costs row + future-proofs per-venue
   *  cohort vocabularies. Brain output does NOT depend on it today. */
  venueId: string
  /** Correlation id from the upstream caller (T1-G). */
  correlationId?: string
}

export async function parseCohortQuery(
  options: ParseCohortQueryOptions,
): Promise<CohortQuery> {
  const { input, today, venueId, correlationId } = options
  if (!input || input.trim().length === 0) {
    throw new Error('parseCohortQuery: empty input')
  }

  const result = await callAIJson<CohortQuery>({
    systemPrompt: buildSystemPrompt(today),
    userPrompt: input.trim(),
    maxTokens: 400,
    temperature: 0.1,
    venueId,
    taskType: 'cohort_query_parse',
    tier: 'sonnet',
    promptVersion: BRAIN_PROMPT_VERSION,
    correlationId,
  })

  // Defensive normalisation — the brain follows the schema closely but
  // we shape-coerce on the way out so callers never deal with partial
  // objects. The executor refuses to run an invalid CohortQuery so
  // missing fields surface loudly rather than silently widening the
  // result set.
  const normalised: CohortQuery = {
    anchor: (result?.anchor as CohortAnchor) ?? 'inquiry_received',
    time_window: result?.time_window
      ? {
          from: String(result.time_window.from ?? today),
          to: String(result.time_window.to ?? today),
        }
      : null,
    exclude_lifecycle_states: Array.isArray(result?.exclude_lifecycle_states)
      ? result.exclude_lifecycle_states.map((s) => String(s).toLowerCase())
      : ['lost', 'cancelled'],
    include_lifecycle_states: Array.isArray(result?.include_lifecycle_states)
      ? result.include_lifecycle_states.map((s) => String(s).toLowerCase())
      : [],
    source_filter: Array.isArray(result?.source_filter)
      ? result.source_filter.map((s) => String(s).toLowerCase())
      : [],
    interpretation: result?.interpretation
      ? String(result.interpretation).slice(0, 400)
      : 'No interpretation returned by brain.',
  }
  return normalised
}
