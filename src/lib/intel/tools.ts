/**
 * The canonical readers, exposed as Claude tools.
 *
 * W3 of NOVEMBER-PLAN.md. INTEL-CANONICAL-API.md fixes six read functions and
 * says the number does not grow. Five of them return data; the sixth,
 * `askIntel`, is the natural-language surface that CALLS the other five, so
 * this manifest has five entries. A question the five cannot answer is a
 * question the product does not have the data for, and the honest move is to
 * say so.
 *
 * Two rules this file exists to enforce:
 *
 *  1. `venueId` is bound server-side by `createCanonicalDispatcher` and is
 *     NEVER in a tool schema. The model cannot select a tenant. This is the
 *     same tenancy discipline the readers themselves apply, moved one layer
 *     out so a prompt injection in an inbound email cannot reach another
 *     venue's numbers.
 *  2. Parameters are limited to the opts the readers already accept
 *     (attribution model, date range, couple id, list bucket). No free-form
 *     filter, no table name, no SQL. The tool surface cannot express a query
 *     the canonical layer has not already agreed to answer.
 *
 * Every result is handed back as JSON exactly as the reader returned it,
 * `n` and `enoughData` intact, so the grounding check downstream can compare
 * a figure in the answer against a figure that actually came out of the
 * database.
 */

import type Anthropic from '@anthropic-ai/sdk'
import type { ToolCallRecord, ToolDispatcher } from '@/lib/ai/tools'

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export const TOOL_GET_VENUE_OVERVIEW = 'get_venue_overview'
export const TOOL_GET_SOURCE_ATTRIBUTION = 'get_source_attribution'
export const TOOL_GET_COHORT_FUNNEL = 'get_cohort_funnel'
export const TOOL_GET_COUPLE_JOURNEY = 'get_couple_journey'
export const TOOL_GET_DAILY_LIST = 'get_daily_list'

/** Buckets `getDailyList` returns. 'all' is the default. */
export const DAILY_LIST_BUCKETS = [
  'all',
  'needsReply',
  'goingCold',
  'toursThisWeek',
  'highIntent',
] as const
export type DailyListBucket = (typeof DAILY_LIST_BUCKETS)[number]

const DATE_RANGE_PROPS = {
  period_from: {
    type: 'string',
    description: 'Inclusive start of the period, ISO date (YYYY-MM-DD). Omit for all time.',
  },
  period_to: {
    type: 'string',
    description: 'Inclusive end of the period, ISO date (YYYY-MM-DD). Omit for all time.',
  },
} as const

export const CANONICAL_TOOLS: Anthropic.Tool[] = [
  {
    name: TOOL_GET_VENUE_OVERVIEW,
    description:
      'Top-line counts for this venue: how many couples exist and how they split across lifecycle ' +
      'states (channel_scoped, resolved, booked, completed, ghost, agent), the most recent touchpoints, ' +
      'and a data-maturity block (total touchpoint count and the oldest one on record). ' +
      'Use this for "how many couples", "how much data do we have", "how complete is my record". ' +
      'It does NOT contain revenue, spend, weather, or anything from outside the venue.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: TOOL_GET_SOURCE_ATTRIBUTION,
    description:
      'Per-channel attribution for this venue. Returns one row per channel with n (distinct couples ' +
      'credited), conversion (inquiry-to-booking rate), cac and revenuePerDollar. Every figure is a ' +
      'Distribution carrying value, n, enoughData and a reason; value is null (never a fake zero) on a ' +
      'zero denominator. Also returns topByVolume and topByConversion separately, because the biggest ' +
      'channel and the best-converting channel are usually not the same one. ' +
      'Use this for any question about sources, channels, where leads come from, which channel to cut ' +
      'or invest in, or cost per booking.',
    input_schema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          enum: ['first_touch', 'last_touch', 'linear', 'time_decay'],
          description:
            'Attribution model. Defaults to first_touch, which is what the product reports unless the ' +
            'operator asks for another lens.',
        },
        ...DATE_RANGE_PROPS,
      },
      additionalProperties: false,
    },
  },
  {
    name: TOOL_GET_COHORT_FUNNEL,
    description:
      'The funnel and its timing for this venue: stage counts (inquiry, tour, booked, completed), the ' +
      'response-time distribution, the lead-time distribution, the conversion curve by response-speed ' +
      'band, the knee in that curve when one is detectable, and emerging text themes with their trend. ' +
      'Distributions carry n and enoughData. ' +
      'Use this for anything about speed of reply, time to book, drop-off, funnel shape, or what couples ' +
      'are talking about.',
    input_schema: {
      type: 'object',
      properties: {
        ...DATE_RANGE_PROPS,
        segment: {
          type: 'string',
          description:
            "Optional segment selector such as 'channel:knot' or 'season:spring_2026'. Leave it out " +
            'unless the operator asked for a specific slice.',
        },
        operator_axis: {
          type: 'boolean',
          description:
            'Set true to break the funnel down by the coordinator who responded. Only ask for this when ' +
            'the question is about a person or about who handles what.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: TOOL_GET_COUPLE_JOURNEY,
    description:
      'One couple, end to end: their identity (name, lifecycle state, heat score), the full ordered ' +
      'ribbon of touchpoints with the cascade stage and reason for each, progression events, the ' +
      'reconstructed identity profile, and a look-alike cohort. ' +
      'Requires the couple id. Ids come from get_daily_list. There is no lookup by name: if you do not ' +
      'have an id, say so rather than guessing at who was meant.',
    input_schema: {
      type: 'object',
      properties: {
        couple_id: {
          type: 'string',
          description: 'The couple id (uuid), as returned by get_daily_list.',
        },
      },
      required: ['couple_id'],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_GET_DAILY_LIST,
    description:
      "Today's working lists for this venue, in four buckets: needsReply (latest touchpoint is inbound " +
      'and unanswered), goingCold (past three quarters of the decay window but not yet ghosted), ' +
      'toursThisWeek (tours scheduled from now to seven days out, cancellations and no-shows excluded, ' +
      'each with the couple id, the couple name and the scheduled time), and highIntent (heat score at ' +
      'or above the hot bar). ' +
      'This is the ONLY source of who has a tour. If toursThisWeek comes back empty there are no tours ' +
      'in that window and you must say exactly that: do not name anyone.',
    input_schema: {
      type: 'object',
      properties: {
        bucket: {
          type: 'string',
          enum: [...DAILY_LIST_BUCKETS],
          description: "Which bucket to return. Defaults to 'all'.",
        },
      },
      additionalProperties: false,
    },
  },
]

/** What the five tools between them cannot answer. Named out loud so a
 *  refusal can tell the operator what IS available instead of trailing off. */
export const CANONICAL_TOOL_SCOPE_SUMMARY =
  'couple counts and lifecycle mix, channel attribution (volume, conversion, CAC, revenue per dollar), ' +
  'the funnel with response and lead times, one couple end to end, and the daily lists ' +
  '(needs reply, going cold, tours this week, high intent)'

/** Subjects the six readers hold no data for. A question that is only about
 *  one of these is refused before any tool call is worth making. */
export const OUT_OF_SCOPE_SUBJECTS = [
  'weather and forecasts',
  'economic indicators (FRED, mortgage rates, CPI)',
  'search or social trends',
  'marketing spend by month',
  'competitor pricing or why a couple chose another venue',
  'reviews and review language',
]

// ---------------------------------------------------------------------------
// Privacy gate — shared with the legacy brain
// ---------------------------------------------------------------------------

/**
 * Questions asking Bloom to NAME couples carrying sensitive themes. This is a
 * deterministic gate that fires BEFORE any model call: the identity profiles
 * are readable through get_couple_journey, and a model cannot be trusted to
 * redact from its own context. Naming here is a worse failure than
 * confabulation. Q31 of the battery.
 */
export const SENSITIVE_THEME_NAMING_RE =
  /\b(which|who|list|name|identify|show me|tell me which|what couples?)\b[\s\S]{0,120}\b(grief|loss|bereavement|family conflict|conflict|health (issue|problem|concern|scare)|medical|ill(ness)?|financial stress|money trouble|relationship distress|distress|separated|divorce|religion|faith|pregnant|pregnancy|miscarriage)\b/i

export const SENSITIVE_THEME_REFUSAL =
  'Some couples in your data have flagged sensitive themes, and I cannot share which ones without their ' +
  'consent. If you need to follow up with a specific couple you already know is going through something ' +
  'difficult, open their record directly and I can help you there.'

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/** Cap on how many tour couples get their name resolved in one daily-list
 *  call. A venue with more tours than this in a week is a good problem; the
 *  answer says the list was capped rather than silently dropping people. */
const TOUR_NAME_RESOLVE_CAP = 25

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined
}

function bool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key]
  return typeof v === 'boolean' ? v : undefined
}

/** Period opt from the flat date args, or undefined when neither is given.
 *  A one-sided range is filled with a wide bound rather than rejected, since
 *  the readers take a from/to pair. */
function periodFrom(args: Record<string, unknown>): { from: string; to: string } | undefined {
  const from = str(args, 'period_from')
  const to = str(args, 'period_to')
  if (!from && !to) return undefined
  return { from: from ?? '1900-01-01', to: to ?? '2999-12-31' }
}

/** The five data readers this dispatcher is allowed to reach. Injectable so
 *  a unit test can drive the whole tool loop with fakes and no database, the
 *  same dependency-seam pattern loadVenueOverview / loadDailyList use. */
export type CanonicalReaders = Pick<
  typeof import('@/lib/intel/canonical'),
  | 'getVenueOverview'
  | 'getSourceAttribution'
  | 'getCohortFunnel'
  | 'getCoupleJourney'
  | 'getDailyList'
>

/**
 * Bind the canonical readers to one venue and return a dispatcher plus the
 * record of everything it ran.
 *
 * With no `readers` argument the real ones are imported dynamically, which
 * keeps this module a leaf: canonical.ts imports the manifest from here, and
 * importing canonical.ts back at module load would be a cycle.
 */
export function createCanonicalDispatcher(
  venueId: string,
  readers?: CanonicalReaders,
): {
  dispatch: ToolDispatcher
  calls: ToolCallRecord[]
} {
  const calls: ToolCallRecord[] = []

  async function run(name: string, args: Record<string, unknown>): Promise<string> {
    const canonical: CanonicalReaders = readers ?? (await import('@/lib/intel/canonical'))

    switch (name) {
      case TOOL_GET_VENUE_OVERVIEW:
        return JSON.stringify(await canonical.getVenueOverview(venueId))

      case TOOL_GET_SOURCE_ATTRIBUTION: {
        const model = str(args, 'model')
        const allowed = ['first_touch', 'last_touch', 'linear', 'time_decay']
        return JSON.stringify(
          await canonical.getSourceAttribution(venueId, {
            model: (allowed.includes(model ?? '') ? model : 'first_touch') as
              | 'first_touch'
              | 'last_touch'
              | 'linear'
              | 'time_decay',
            period: periodFrom(args),
          }),
        )
      }

      case TOOL_GET_COHORT_FUNNEL:
        return JSON.stringify(
          await canonical.getCohortFunnel(venueId, {
            period: periodFrom(args),
            segment: str(args, 'segment'),
            operatorAxis: bool(args, 'operator_axis'),
          }),
        )

      case TOOL_GET_COUPLE_JOURNEY: {
        const coupleId = str(args, 'couple_id')
        if (!coupleId) {
          return JSON.stringify({
            error: 'couple_id is required. Get one from get_daily_list; there is no lookup by name.',
          })
        }
        return JSON.stringify(await canonical.getCoupleJourney(venueId, coupleId))
      }

      case TOOL_GET_DAILY_LIST: {
        const list = await canonical.getDailyList(venueId)
        const bucket = (str(args, 'bucket') ?? 'all') as DailyListBucket

        // toursThisWeek carries ids, not names. Q37 asks Bloom to find
        // everyone toured with and then draft follow-ups, and the July run
        // answered it by inventing two attendees. Resolve each tour's couple
        // through the canonical journey reader so the only names that can
        // reach the model are names that came out of the database.
        const tours = await Promise.all(
          list.toursThisWeek.slice(0, TOUR_NAME_RESOLVE_CAP).map(async (t) => {
            const journey = await canonical.getCoupleJourney(venueId, t.coupleId)
            return {
              tourId: t.id,
              coupleId: t.coupleId,
              scheduledAt: t.scheduledAt,
              names: journey.couple?.names ?? null,
            }
          }),
        )
        const toursBlock = {
          n: list.toursThisWeek.length,
          resolved: tours.length,
          truncated: list.toursThisWeek.length > tours.length,
          tours,
          ...(list.toursThisWeek.length === 0
            ? { note: 'No tours are scheduled in this window. There is nobody to name.' }
            : {}),
        }

        const full = {
          needsReply: { n: list.needsReply.length, couples: list.needsReply },
          goingCold: { n: list.goingCold.length, couples: list.goingCold },
          toursThisWeek: toursBlock,
          highIntent: { n: list.highIntent.length, couples: list.highIntent },
          generatedAt: list.generatedAt,
        }
        if (bucket === 'all') return JSON.stringify(full)
        return JSON.stringify({ [bucket]: full[bucket], generatedAt: full.generatedAt })
      }

      default:
        return JSON.stringify({
          error: `Unknown tool "${name}". Available: ${CANONICAL_TOOLS.map((t) => t.name).join(', ')}.`,
        })
    }
  }

  /** Record the (tool, args, result) triple here as well as in the loop, so
   *  the evidence trail survives a truncated or failed loop. */
  const dispatch: ToolDispatcher = async (name, args) => {
    let result: string
    let isError = false
    try {
      result = await run(name, args)
    } catch (err) {
      isError = true
      result = `Tool "${name}" failed: ${err instanceof Error ? err.message : String(err)}`
    }
    calls.push({ name, args, result, isError })
    if (isError) throw new Error(result)
    return result
  }

  return { dispatch, calls }
}

// ---------------------------------------------------------------------------
// Enforcing grounding check
// ---------------------------------------------------------------------------
//
// The four regexes in src/lib/services/sage/honesty-rails.ts run after
// generation, look only at wording, and are advisory. None of them has ever
// compared a number in an answer to a number in the database, which is why
// "unknown converts 86%" could ship. What follows does compare, and it is not
// advisory: an unmatched figure turns the whole answer into a refusal that
// names the claim it could not stand behind.
//
// The rule the model is told and the rule enforced here are the same one:
// state no number that did not come back from a tool call.

/** One figure in the answer that no tool result supports. */
export interface UngroundedClaim {
  kind: 'percentage' | 'number' | 'name'
  /** The literal text as it appeared in the answer. */
  text: string
  /** A little surrounding context so the refusal can quote the claim. */
  context: string
}

/** Values too common in ordinary prose to be worth checking, and which
 *  cannot carry a false statistic on their own. */
const ALWAYS_GROUNDED_NUMBERS = new Set([0, 1])

/** Absolute tolerance when matching a claimed figure to a database figure.
 *  Covers a ratio rendered as a rounded percentage (0.398 becomes "40%"). */
const MATCH_TOLERANCE = 0.51

function parseNumeric(raw: string): number | null {
  const n = Number(raw.replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

/** Every number a tool result can legitimately support, including the two
 *  renderings the model is most likely to reach for: a ratio expressed as a
 *  percentage, and the length of a returned list. */
function collectNumbersFromValue(value: unknown, out: number[], depth = 0): void {
  if (depth > 12) return
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.push(value)
    out.push(value * 100)
    out.push(Math.round(value * 1000) / 10)
    return
  }
  if (Array.isArray(value)) {
    out.push(value.length)
    for (const item of value) collectNumbersFromValue(item, out, depth + 1)
    return
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectNumbersFromValue(v, out, depth + 1)
    }
  }
}

/** Numeric literals appearing anywhere in a string, ISO dates included. Cheap
 *  belt and braces so a date or an id quoted back in an answer is never read
 *  as a fabricated statistic. */
function numericLiterals(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(/\d+(?:\.\d+)?/g)) {
    const n = parseNumeric(m[0])
    if (n !== null) out.push(n)
  }
  return out
}

/** The set of figures the answer is allowed to state: everything the tools
 *  returned, plus anything the operator put in the question themselves. */
export function collectGroundedNumbers(
  calls: readonly ToolCallRecord[],
  question: string,
): number[] {
  const out: number[] = []
  for (const call of calls) {
    out.push(...numericLiterals(call.result))
    try {
      collectNumbersFromValue(JSON.parse(call.result), out)
    } catch {
      // A non-JSON tool result still contributes its literals above.
    }
  }
  out.push(...numericLiterals(question))
  return out
}

function isGrounded(value: number, grounded: readonly number[]): boolean {
  if (ALWAYS_GROUNDED_NUMBERS.has(value)) return true
  const tol = Math.max(MATCH_TOLERANCE, Math.abs(value) * 0.005)
  for (const g of grounded) {
    if (Math.abs(g - value) <= tol) return true
  }
  return false
}

function contextAround(text: string, index: number, len: number): string {
  const start = Math.max(0, index - 40)
  const end = Math.min(text.length, index + len + 40)
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}

/** Capitalised words that are never a person and never a claim. */
const NAME_ALLOWLIST = new Set([
  'the', 'this', 'that', 'there', 'these', 'those', 'they', 'their', 'them',
  'you', 'your', 'yours', 'we', 'our', 'its', 'no', 'none', 'not',
  'nobody', 'and', 'but', 'for', 'from', 'with', 'without', 'based', 'here',
  'bloom', 'sage', 'knot', 'weddingwire', 'zola', 'google', 'instagram',
  'facebook', 'honeybook', 'calendly', 'gmail', 'website', 'portal',
  'unknown', 'referral', 'direct', 'tour', 'tours', 'inquiry', 'inquiries',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'today', 'tomorrow', 'yesterday', 'weekend', 'week', 'month', 'year',
  'if', 'when', 'once', 'because', 'all', 'any', 'both', 'each', 'every',
  'first', 'last', 'nothing', 'nor', 'neither', 'since', 'while',
])

/** True when the daily-list tour bucket was fetched, came back empty, and no
 *  reader returned a couple name. That is the one situation where a proper
 *  noun in the answer can only have been invented. Battery Q37. */
export function toursBucketWasEmpty(calls: readonly ToolCallRecord[]): boolean {
  let sawTourBucket = false
  for (const call of calls) {
    if (call.name !== TOOL_GET_DAILY_LIST) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(call.result)
    } catch {
      continue
    }
    const block = (parsed as { toursThisWeek?: { n?: unknown } } | null)?.toursThisWeek
    if (!block || typeof block !== 'object') continue
    sawTourBucket = true
    if (typeof block.n === 'number' && block.n > 0) return false
  }
  if (!sawTourBucket) return false
  // Any name coming back from any reader means names are legitimately in play.
  return !calls.some((c) => /"names"\s*:\s*"[^"]+"/.test(c.result))
}

/**
 * Verify every figure in the answer against the recorded tool results.
 *
 * Percentages and counts only. Rounding is allowed. Numbers the operator put
 * in the question themselves are allowed, so the model can repeat a premise
 * back before challenging it. Anything else with no match is returned as an
 * ungrounded claim, and the caller refuses.
 */
export function findUngroundedClaims(
  answer: string,
  calls: readonly ToolCallRecord[],
  question: string,
): UngroundedClaim[] {
  const grounded = collectGroundedNumbers(calls, question)
  const found: UngroundedClaim[] = []
  const seen = new Set<string>()

  // Percentages first, blanked out afterwards so the general number sweep
  // below does not count the same figure twice.
  let residual = answer
  for (const m of answer.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)) {
    const value = parseNumeric(m[1])
    if (value !== null && !isGrounded(value, grounded) && !seen.has(`p${m[1]}`)) {
      seen.add(`p${m[1]}`)
      found.push({
        kind: 'percentage',
        text: `${m[1]}%`,
        context: contextAround(answer, m.index ?? 0, m[0].length),
      })
    }
    residual = residual.replace(m[0], ' '.repeat(m[0].length))
  }

  for (const m of residual.matchAll(/(?<![\w.$])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?![\w%])/g)) {
    const value = parseNumeric(m[1])
    if (value !== null && !isGrounded(value, grounded) && !seen.has(`n${m[1]}`)) {
      seen.add(`n${m[1]}`)
      found.push({
        kind: 'number',
        text: m[1],
        context: contextAround(answer, m.index ?? 0, m[0].length),
      })
    }
  }

  // Name check, narrow on purpose: only when a tour list was asked for and
  // came back with nobody in it.
  if (toursBucketWasEmpty(calls)) {
    const questionWords = new Set(question.toLowerCase().match(/[a-z']+/g) ?? [])
    for (const m of answer.matchAll(/(?:^|[^.!?\n]\s+)([A-Z][a-zA-Z'’-]{2,})/g)) {
      const word = m[1]
      const key = word.toLowerCase()
      if (NAME_ALLOWLIST.has(key) || questionWords.has(key)) continue
      if (calls.some((c) => c.result.includes(word))) continue
      if (seen.has(`x${key}`)) continue
      seen.add(`x${key}`)
      found.push({
        kind: 'name',
        text: word,
        context: contextAround(answer, m.index ?? 0, m[0].length),
      })
    }
  }

  return found
}

/** The refusal that replaces an answer carrying an ungrounded figure. It
 *  names the claim, because "I cannot answer" without saying which part
 *  failed is not much better than the bad answer. */
export function buildGroundingRefusal(claims: readonly UngroundedClaim[]): string {
  const first = claims[0]
  const label = first.kind === 'name' ? `the name "${first.text}"` : `the figure ${first.text}`
  const others =
    claims.length > 1
      ? ` (and ${claims.length - 1} other ${claims.length === 2 ? 'claim' : 'claims'} in the same answer)`
      : ''
  return (
    'I drafted an answer but could not stand behind it, so I am not giving it to you. ' +
    `${label}${others} did not come back from any of the canonical readers, which means I would have been ` +
    `making it up. Where it appeared: "${first.context}". ` +
    'Ask again, or narrow the question, and I will answer only with figures I can point at.'
  )
}
