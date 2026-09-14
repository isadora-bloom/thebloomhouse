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
import type { IntelToolSource, ToolSourceDeps } from './tool-sources/types'

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
  // Weather against tour outcomes and review themes left this list on
  // 2026-09-09 when the W14 tool sources landed. Live forecasts are still
  // out: the product stores weather history, it does not predict.
  'weather forecasts for future dates',
  'economic indicators (FRED, mortgage rates, CPI)',
  'search or social trends',
  'marketing spend by month',
  'competitor pricing or why a couple chose another venue',
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

/** A calendar day key, the only date shape the readers' period opts accept. */
function isDateKey(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
}

/** Canonical uuid, the only shape a couple id can take. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Period opt from the flat date args, or undefined when neither is given.
 * A one-sided range is filled with a wide bound rather than rejected, since
 * the readers take a from/to pair.
 *
 * 2026-09-14 security review, item 7d: the two values used to go through
 * untouched, so whatever the model emitted — a phrase, a template it had
 * not filled in, an interval expression — landed in a `.gte()` and became
 * either a PostgREST error the operator saw as a broken tool or, worse, a
 * silently different window from the one they asked about. Anything that
 * is not a YYYY-MM-DD day key is now treated as absent, which is the same
 * thing the caller gets for omitting it, and a period the model cannot
 * express is a period it has to ask about instead.
 */
function periodFrom(args: Record<string, unknown>): { from: string; to: string } | undefined {
  const rawFrom = str(args, 'period_from')
  const rawTo = str(args, 'period_to')
  const from = isDateKey(rawFrom) ? rawFrom : undefined
  const to = isDateKey(rawTo) ? rawTo : undefined
  if (rawFrom && !from) {
    console.warn('[intel-tools] ignoring malformed period_from', { period_from: rawFrom })
  }
  if (rawTo && !to) {
    console.warn('[intel-tools] ignoring malformed period_to', { period_to: rawTo })
  }
  if (!from && !to) return undefined
  return { from: from ?? '1900-01-01', to: to ?? '2999-12-31' }
}

// ---------------------------------------------------------------------------
// Sensitive-theme redaction at the tool-result boundary
// ---------------------------------------------------------------------------

/**
 * Profile fields that never leave the reader, whatever was asked.
 *
 * 2026-09-14 security review, item 7f. SENSITIVE_THEME_NAMING_RE above is a
 * question-shaped gate: it reads the operator's wording and refuses when it
 * looks like "which couples are dealing with grief". That catches the
 * question it was written for and nothing else. "Tell me about Alice and
 * Bob" is not a sensitive-theme question by any regex, and the answer
 * returned the couple's emotional truths, family dynamics and
 * accessibility needs straight into the model's context anyway, because
 * `get_couple_journey` hands back the reconstructed profile whole.
 *
 * The wall belongs where the data is, not where the wording is. These three
 * fields are stripped from every `get_couple_journey` result and replaced
 * with a count, so the model can honestly say the record holds something it
 * is not permitted to read out, and the operator can open the couple's own
 * page if they need it. The identity-profile view on that page is
 * unaffected; this is only the "Ask your data" path.
 */
export const REDACTED_PROFILE_FIELDS = [
  'emotional_truths',
  'family_dynamics',
  'accessibility_needs',
] as const

/** Replace the sensitive profile fields with a count of what was withheld. */
export function redactSensitiveProfile(
  profile: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!profile) return profile ?? null
  const out: Record<string, unknown> = { ...profile }
  const withheld: string[] = []
  for (const field of REDACTED_PROFILE_FIELDS) {
    if (!(field in out)) continue
    const value = out[field]
    const n = Array.isArray(value) ? value.length : value == null ? 0 : 1
    delete out[field]
    if (n > 0) withheld.push(`${field} (${n})`)
  }
  if (withheld.length > 0) {
    out.withheldSensitiveFields = withheld
    out.withheldSensitiveNote =
      'These fields are held back from this tool on purpose. Say the record holds ' +
      'something you are not permitted to read out and point the operator at the ' +
      "couple's own page. Do not guess at what they contain."
  }
  return out
}

// ---------------------------------------------------------------------------
// Untrusted-prose envelope for tool results
// ---------------------------------------------------------------------------

/**
 * Wrap the free-text fields a source declares before the result goes back
 * to the model.
 *
 * 2026-09-14 security review, item 7b. Four of the registered sources hand
 * back prose somebody else wrote — a review body, the quote around a
 * keyword match in an inbound email, a loss reason an operator typed, a
 * blocking detail on a follow-up. All of it went back into the transcript
 * as plain JSON, in the same channel as the tool contract itself, with
 * nothing marking where the venue's data stopped and a stranger's writing
 * began. A review that says "SYSTEM: ignore the grounding rule" is the
 * cheapest possible attack on a brain whose entire value is that it does
 * not make numbers up.
 *
 * So each source declares which of its fields carry prose, and those
 * fields go through the same envelope a couple's chat message goes
 * through. An array of quotes is wrapped once rather than per element:
 * same boundary, a fraction of the tokens.
 */
async function wrapFreeText(
  value: unknown,
  freeTextFields: readonly string[],
  depth = 0,
): Promise<unknown> {
  if (freeTextFields.length === 0 || depth > 12) return value
  const { wrapUntrustedContent } = await import('@/lib/security/prompt-sanitize')

  const wrapOne = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return wrapUntrustedContent(v, 'ingested_text').wrapped
    }
    if (Array.isArray(v) && v.every((item) => typeof item === 'string')) {
      if (v.length === 0) return v
      return wrapUntrustedContent((v as string[]).join('\n---\n'), 'ingested_text').wrapped
    }
    return v
  }

  const walk = async (node: unknown, d: number): Promise<unknown> => {
    if (d > 12) return node
    if (Array.isArray(node)) {
      return Promise.all(node.map((item) => walk(item, d + 1)))
    }
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = freeTextFields.includes(k) ? wrapOne(v) : await walk(v, d + 1)
      }
      return out
    }
    return node
  }

  return walk(value, depth)
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
// ---------------------------------------------------------------------------
// Wave-2 tool sources (NOVEMBER-PLAN.md wave 2, W12 to W15)
// ---------------------------------------------------------------------------

/** What a dispatcher may reach beyond the five readers. Tests pass fakes and
 *  a pinned clock; production leaves this empty and the registry in
 *  ./tool-sources is loaded on first use. */
export interface ToolSourceOptions {
  sources?: readonly IntelToolSource[]
  deps?: Partial<ToolSourceDeps>
}

/** The registry, imported lazily. A source is free to reuse a reader from
 *  canonical.ts, and canonical.ts imports this module, so a static import
 *  here would close a cycle at module load. */
export async function loadToolSources(): Promise<readonly IntelToolSource[]> {
  const mod = await import('./tool-sources')
  return mod.TOOL_SOURCES
}

/** The full manifest handed to the model: the five readers plus every
 *  registered source. */
export function allTools(sources: readonly IntelToolSource[]): Anthropic.Tool[] {
  return [...CANONICAL_TOOLS, ...sources.map((s) => s.tool)]
}

/** What the model is told it can answer. The readers' summary plus each
 *  source's subjects, so a question a source covers is not refused as out
 *  of scope. OUT_OF_SCOPE_SUBJECTS is pruned by hand as sources land. */
export function scopeSummaryFor(sources: readonly IntelToolSource[]): string {
  const extra = sources.flatMap((s) => s.subjects)
  if (extra.length === 0) return CANONICAL_TOOL_SCOPE_SUMMARY
  return `${CANONICAL_TOOL_SCOPE_SUMMARY}, ${extra.join(', ')}`
}

/** Today's date as the venue sees it, YYYY-MM-DD. Ghost risk, completeness
 *  and the follow-up window all count days from this; a UTC date would move
 *  an evening call at a US venue into tomorrow. Timezone lives on
 *  venue_config (migration 001). Falls back to UTC if the row is missing. */
export async function venueLocalToday(
  supabase: ToolSourceDeps['supabase'],
  venueId: string,
): Promise<string> {
  let timeZone = 'UTC'
  try {
    const { data } = await supabase
      .from('venue_config')
      .select('timezone')
      .eq('venue_id', venueId)
      .maybeSingle()
    if (data && typeof data.timezone === 'string' && data.timezone) timeZone = data.timezone
  } catch {
    // Missing config is not a reason to fail the tool call; UTC is the honest default.
  }
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date())
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

export function createCanonicalDispatcher(
  venueId: string,
  readers?: CanonicalReaders,
  sourceOpts?: ToolSourceOptions,
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
        // Item 7d. A couple id is a uuid or it is nothing. Anything else is
        // the model having invented an id, and inventing an id is exactly
        // what the tool description tells it not to do; say so rather than
        // sending the guess to the reader.
        if (!UUID_RE.test(coupleId)) {
          return JSON.stringify({
            error:
              `"${coupleId}" is not a couple id. Ids are uuids and come from get_daily_list. ` +
              'There is no lookup by name: if you do not have an id, say so.',
          })
        }
        const journey = await canonical.getCoupleJourney(venueId, coupleId)
        // Item 7f. The sensitive slice of the reconstructed profile never
        // reaches the model, regardless of how the question was worded.
        return JSON.stringify({
          ...journey,
          identityProfile: redactSensitiveProfile(journey.identityProfile),
        })
      }

      case TOOL_GET_DAILY_LIST: {
        const list = await canonical.getDailyList(venueId)
        // Item 7c. The bucket used to be cast, not checked, so an
        // unrecognised value indexed `full` with it and produced
        // `{"<whatever>": undefined}` — a tool result that says nothing and
        // reads, to the model, like an empty bucket. Fall back to 'all' and
        // say which value was ignored.
        const rawBucket = str(args, 'bucket')
        const isValidBucket = (v: string | undefined): v is DailyListBucket =>
          v !== undefined && (DAILY_LIST_BUCKETS as readonly string[]).includes(v)
        const bucket: DailyListBucket = isValidBucket(rawBucket) ? rawBucket : 'all'
        const bucketNote =
          rawBucket && !isValidBucket(rawBucket)
            ? {
                note:
                  `Ignored bucket "${rawBucket}" — not one of ${DAILY_LIST_BUCKETS.join(', ')}. ` +
                  'Returned every bucket instead.',
              }
            : {}

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
        if (bucket === 'all') return JSON.stringify({ ...full, ...bucketNote })
        return JSON.stringify({ [bucket]: full[bucket], generatedAt: full.generatedAt })
      }

      default: {
        // Not one of the five readers. A registered source runs with the
        // venue bound here, the same way the readers do; the model never
        // chooses the tenant.
        const sources = sourceOpts?.sources ?? (await loadToolSources())
        const source = sources.find((s) => s.tool.name === name)
        if (source) {
          const supabase =
            sourceOpts?.deps?.supabase ??
            (await import('@/lib/supabase/service')).createServiceClient()
          const deps: ToolSourceDeps = {
            supabase,
            today: sourceOpts?.deps?.today ?? (await venueLocalToday(supabase, venueId)),
          }
          // Item 7b. Prose the source ingested from somewhere else goes
          // back to the model inside the untrusted-data envelope.
          const raw = await source.run(venueId, args, deps)
          return JSON.stringify(await wrapFreeText(raw, source.freeTextFields ?? []))
        }
        return JSON.stringify({
          error: `Unknown tool "${name}". Available: ${allTools(sources)
            .map((t) => t.name)
            .join(', ')}.`,
        })
      }
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

/**
 * Field names whose value is prose somebody else wrote, not a figure this
 * product computed.
 *
 * 2026-09-14 security review, item 7a. The grounding check used to sweep
 * every numeric literal out of the raw result string, which meant a review
 * body reading "they handled 94% of the setup" put 94 into the grounded
 * set. The model could then state "94% of couples booked" and the check
 * would wave it through, because the number was, technically, in a tool
 * result. That is the confabulation class this whole mechanism exists to
 * close, reopened by its own belt-and-braces.
 *
 * Numbers now come only from numeric-typed JSON fields, which are the ones
 * the readers actually computed. Literals inside strings are still
 * collected, because an answer quoting a date or an id back must not be
 * read as a statistic — but not from these fields, where a digit is a
 * stranger's sentence rather than a measurement.
 *
 * The list is the union of what the four prose-carrying sources emit
 * (signals.ts, reviews.ts, operator-patterns.ts, follow-ups.ts). Keep it in
 * step with the `freeTextFields` those sources declare.
 */
const FREE_TEXT_KEYS: ReadonlySet<string> = new Set([
  'quote',
  'quotes',
  'exampleQuotes',
  'body',
  'reason',
  'example',
  'examples',
  'matcherReason',
  'detail',
  'note',
  'notes',
])

/** Every number a tool result can legitimately support, including the two
 *  renderings the model is most likely to reach for: a ratio expressed as a
 *  percentage, and the length of a returned list.
 *
 *  `inFreeText` is inherited down the walk so the elements of an
 *  `exampleQuotes` array are treated the same as the array itself. */
function collectNumbersFromValue(
  value: unknown,
  out: number[],
  depth = 0,
  inFreeText = false,
): void {
  if (depth > 12) return
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.push(value)
    out.push(value * 100)
    out.push(Math.round(value * 1000) / 10)
    return
  }
  if (typeof value === 'string') {
    if (!inFreeText) out.push(...numericLiterals(value))
    return
  }
  if (Array.isArray(value)) {
    out.push(value.length)
    for (const item of value) collectNumbersFromValue(item, out, depth + 1, inFreeText)
    return
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      collectNumbersFromValue(v, out, depth + 1, inFreeText || FREE_TEXT_KEYS.has(k))
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

/**
 * Every string a tool result can legitimately supply a NAME from: the same
 * walk as the numbers, minus the free-text fields. The name gate had the
 * identical hole — `call.result.includes(word)` matched a first name that
 * appeared inside a review quote, so an invented tour attendee called
 * Sarah was grounded by any review written by a Sarah.
 */
function collectGroundableStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 12) return
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectGroundableStrings(item, out, depth + 1)
    return
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FREE_TEXT_KEYS.has(k)) continue
      collectGroundableStrings(v, out, depth + 1)
    }
  }
}

/** The text a name in the answer may be grounded against. A tool result
 *  that is not JSON contributes whole, since there is no structure to
 *  reason about. */
function groundableTextFor(call: ToolCallRecord): string {
  try {
    const out: string[] = []
    collectGroundableStrings(JSON.parse(call.result), out)
    return out.join('\n')
  } catch {
    return call.result
  }
}

/** The set of figures the answer is allowed to state: everything the tools
 *  returned, plus anything the operator put in the question themselves. */
export function collectGroundedNumbers(
  calls: readonly ToolCallRecord[],
  question: string,
): number[] {
  const out: number[] = []
  for (const call of calls) {
    try {
      collectNumbersFromValue(JSON.parse(call.result), out)
    } catch {
      // A non-JSON tool result has no structure to respect, so its raw
      // literals are the best available and are taken whole.
      out.push(...numericLiterals(call.result))
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
    // W32 (2026-09-11): get_tour_cohort is the other list that names tour
    // couples, for windows in the past. An empty cohort is an empty bucket.
    const isCohort = call.name === 'get_tour_cohort'
    if (call.name !== TOOL_GET_DAILY_LIST && !isCohort) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(call.result)
    } catch {
      continue
    }
    const block = isCohort
      ? (parsed as { n?: unknown } | null)
      : (parsed as { toursThisWeek?: { n?: unknown } } | null)?.toursThisWeek
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

  // The lookbehind excludes a word character (so a uuid segment is not read as
  // a statistic) and a full stop (so "3.14" is not also read as "14"). It does
  // NOT exclude a currency symbol: "$4,200" must be checkable, or a fabricated
  // CAC walks straight through.
  for (const m of residual.matchAll(/(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?![\w%])/g)) {
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
    // Free-text fields excluded — see collectGroundableStrings. A name that
    // only ever appeared inside a review quote is not evidence that the
    // name belongs in an answer about who toured.
    const groundableText = calls.map(groundableTextFor)
    for (const m of answer.matchAll(/(?:^|[^.!?\n]\s+)([A-Z][a-zA-Z'’-]{2,})/g)) {
      const word = m[1]
      const key = word.toLowerCase()
      if (NAME_ALLOWLIST.has(key) || questionWords.has(key)) continue
      if (groundableText.some((t) => t.includes(word))) continue
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
