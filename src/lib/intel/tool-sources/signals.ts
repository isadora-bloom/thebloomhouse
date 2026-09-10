/**
 * What couples said before they signed. Battery Q25 and Q28.
 *
 * Q25 ("which signals in the pre-tour messages predicted signing") is already
 * computed. `computeCurve` in src/lib/services/cohort/curve.ts compares four
 * pre-tour behaviours across couples who booked and couples who ghosted and
 * reports the lift. What it does not return is the denominators, so a lift of
 * 2.4 over three bookers reads exactly like a lift of 2.4 over eighty. This
 * source runs the same cohort loader and the same computation, then attaches
 * the two cohort sizes and refuses to call anything a pattern below the
 * cohort minimum.
 *
 * Q28 ("do couples who mention a blog post, reel or pin convert better") is
 * not computed anywhere. The text-pattern extractor tracks two keyword
 * families, climate control and budget, and content mentions are neither. So
 * this file adds a third counter of the same deterministic keyword kind, over
 * inbound touchpoint text, and compares the booking rate of couples who
 * mentioned a piece of content against those who did not.
 *
 * On correlation: both halves are comparisons between two groups a couple put
 * themselves into. Mentioning a reel does not make anyone book, and a couple
 * who is already keen is more likely to mention anything at all. Every rate
 * carries its n and the result carries that caveat in plain words, because
 * this is exactly the shape of finding that gets repeated as causation.
 */

import type Anthropic from '@anthropic-ai/sdk'
import { loadCohortData } from '@/lib/services/cohort/data'
import { buildCoupleFacts, type CoupleFacts } from '@/lib/services/cohort/facts'
import { computeCurve } from '@/lib/services/cohort/curve'
import { isOutbound } from '@/lib/services/cohort/direction'
import { MIN_DISTRIBUTION_N, type TouchpointRow } from '@/lib/services/cohort/types'
import { insufficient, type IntelToolSource, type ToolSourceDeps } from './types'

export const TOOL_GET_CONVERSION_SIGNALS = 'get_conversion_signals'

/** A group needs this many couples before its booking rate is worth stating.
 *  Same bar the cohort layer uses for any distribution. */
const MIN_GROUP_N = MIN_DISTRIBUTION_N

/** Couples named back as examples of a content mention. */
const EXAMPLE_CAP = 8

/** Longest quote returned as evidence for a mention. */
const QUOTE_CHARS = 180

// ---------------------------------------------------------------------------
// Content families (Q28)
// ---------------------------------------------------------------------------

export interface ContentFamily {
  family: string
  label: string
  pattern: RegExp
}

/** Deliberately narrow. "board" and "story" were left out because they match
 *  ordinary wedding talk far more often than they match a Pinterest board or
 *  an Instagram story, and a false positive here quietly inflates a rate. */
export const CONTENT_FAMILIES: ContentFamily[] = [
  {
    family: 'blog',
    label: 'Blog post or article',
    pattern: /\b(blog|blogpost|your (post|article)|the article|read (your|the) (post|article))\b/i,
  },
  {
    family: 'instagram',
    label: 'Instagram post or reel',
    pattern: /\b(instagram|insta\b|reel|reels|ig (post|page|feed))\b/i,
  },
  {
    family: 'pinterest',
    label: 'Pinterest pin',
    pattern: /\b(pinterest|pinned|your pins?\b|a pin\b|pin board)\b/i,
  },
  {
    family: 'video',
    label: 'Video or tour footage',
    pattern: /\b(youtube|the video|your video|walkthrough video|tiktok)\b/i,
  },
]

/** Human-written text carried on a touchpoint. Mirrors the extractor in
 *  cohort/text-patterns.ts, which keeps it private. */
export function readableText(raw: Record<string, unknown> | null): string {
  if (!raw) return ''
  const parts: string[] = []
  for (const key of ['subject', 'body_preview', 'full_body', 'body']) {
    const v = raw[key]
    if (typeof v === 'string' && v) parts.push(v)
  }
  return parts.join(' \n ')
}

function quoteAround(text: string, match: RegExpExecArray): string {
  const start = Math.max(0, (match.index ?? 0) - 60)
  const end = Math.min(text.length, (match.index ?? 0) + match[0].length + 100)
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, QUOTE_CHARS)
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}

export interface ContentMention {
  family: string
  label: string
  quote: string
  occurredAt: string
  channel: string
}

/** Every content family mentioned in a couple's inbound touchpoints, one
 *  entry per family with the first quote that matched. Pure. */
export function findContentMentions(touchpoints: readonly TouchpointRow[]): ContentMention[] {
  const found = new Map<string, ContentMention>()
  for (const tp of touchpoints) {
    if (isOutbound(tp)) continue
    const text = readableText(tp.raw_payload)
    if (!text) continue
    for (const fam of CONTENT_FAMILIES) {
      if (found.has(fam.family)) continue
      // No `g` flag on these patterns, so exec carries no lastIndex state
      // between calls and the shared RegExp objects are safe to reuse.
      const m = fam.pattern.exec(text)
      if (!m) continue
      found.set(fam.family, {
        family: fam.family,
        label: fam.label,
        quote: quoteAround(text, m),
        occurredAt: tp.occurred_at,
        channel: tp.channel,
      })
    }
  }
  return [...found.values()]
}

// ---------------------------------------------------------------------------
// Group rates
// ---------------------------------------------------------------------------

interface GroupRate {
  n: number
  booked: number
  ghosted: number
  enoughData: boolean
  reason?: string
  bookedPercent: number | null
}

/** Booking rate over couples with a settled outcome. In-progress couples are
 *  excluded from both numerator and denominator: they have not decided, and
 *  counting them as "did not book" is how a conversion rate quietly halves. */
function rateOver(facts: readonly CoupleFacts[], label: string): GroupRate {
  const settled = facts.filter((f) => f.booked || f.isGhost)
  const booked = settled.filter((f) => f.booked).length
  const ghosted = settled.length - booked
  if (settled.length < MIN_GROUP_N) {
    return {
      ...insufficient(
        settled.length,
        `Only ${settled.length} ${label} couple(s) have settled either way, against a minimum of ` +
          `${MIN_GROUP_N}. The counts are here; a rate over this many is not a finding.`,
      ),
      booked,
      ghosted,
      bookedPercent: null,
    }
  }
  return {
    n: settled.length,
    booked,
    ghosted,
    enoughData: true,
    bookedPercent: Math.round((booked / settled.length) * 1000) / 10,
  }
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

function sinceArg(args: Record<string, unknown>): string | null {
  const raw = args.since
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  const trimmed = raw.trim()
  return Number.isFinite(Date.parse(trimmed)) ? trimmed : null
}

export async function runConversionSignals(
  venueId: string,
  args: Record<string, unknown>,
  deps: ToolSourceDeps,
): Promise<unknown> {
  const since = sinceArg(args)
  const data = await loadCohortData(deps.supabase, venueId, { since })
  const facts = buildCoupleFacts(data)

  // ---- Q25: pre-tour signals -------------------------------------------
  // The cohort is couples that got at least as far as a booked tour, which is
  // the same anchor computeCurve uses. Recomputed here only to carry the two
  // denominators the curve result leaves out.
  const tourCohort = facts.filter((f) => f.furthest >= 3)
  const bookersN = tourCohort.filter((f) => f.booked).length
  const ghostsN = tourCohort.filter((f) => f.isGhost).length
  const curve = computeCurve(facts)
  const comparable = Math.min(bookersN, ghostsN)

  const preTourSignals = {
    cohort: {
      description: 'Couples who reached at least a booked tour.',
      n: tourCohort.length,
      bookers: bookersN,
      ghosted: ghostsN,
    },
    ...(comparable < MIN_GROUP_N
      ? insufficient(
          comparable,
          `The smaller side of the comparison has ${comparable} couple(s), against a minimum of ` +
            `${MIN_GROUP_N}. Report the raw counts per signal and say plainly that no signal has ` +
            'yet separated bookers from ghosts.',
        )
      : { n: comparable, enoughData: true }),
    signals: curve.preTourSignals.map((s) => ({
      signal: s.signal,
      bookersWithSignal: s.beforeBooking,
      bookersTotal: bookersN,
      ghostsWithSignal: s.beforeGhost,
      ghostsTotal: ghostsN,
      /** How much more common the signal is among bookers than ghosts. null
       *  when either side has nothing to divide by. */
      lift: s.lift,
    })),
    note:
      'Lift is the ratio of how often a signal appears before a booking to how often it appears ' +
      'before a ghost. It is a comparison of two groups, not a driver.',
  }

  // ---- Q28: content mentions -------------------------------------------
  const mentionsByCouple = new Map<string, ContentMention[]>()
  for (const f of facts) {
    const found = findContentMentions(f.touchpoints)
    if (found.length > 0) mentionsByCouple.set(f.couple.id, found)
  }
  const mentioned = facts.filter((f) => mentionsByCouple.has(f.couple.id))
  const notMentioned = facts.filter((f) => !mentionsByCouple.has(f.couple.id))

  const perFamily = CONTENT_FAMILIES.map((fam) => {
    const group = facts.filter((f) =>
      (mentionsByCouple.get(f.couple.id) ?? []).some((m) => m.family === fam.family),
    )
    return {
      family: fam.family,
      label: fam.label,
      couplesMentioning: group.length,
      ...rateOver(group, `${fam.label} mentioning`),
    }
  })

  const examples = mentioned.slice(0, EXAMPLE_CAP).map((f) => ({
    coupleId: f.couple.id,
    names: f.couple.primary_contact_name || null,
    outcome: f.outcome,
    mentions: mentionsByCouple.get(f.couple.id) ?? [],
  }))

  const contentMentions = {
    definition:
      'A couple counts as mentioning content when any inbound message of theirs matches one of ' +
      'four keyword families: blog or article, Instagram or reel, Pinterest pin, video. Keyword ' +
      'matching, not an LLM read, so it will miss a paraphrase and it will catch the odd ' +
      'coincidence.',
    families: CONTENT_FAMILIES.map((f) => ({ family: f.family, label: f.label })),
    mentioners: { couples: mentioned.length, ...rateOver(mentioned, 'content-mentioning') },
    nonMentioners: { couples: notMentioned.length, ...rateOver(notMentioned, 'non-mentioning') },
    perFamily,
    examples: { n: examples.length, of: mentioned.length, couples: examples },
  }

  return {
    asOf: deps.today,
    window: since
      ? { since, note: 'Touchpoints and couple activity from this date onwards only.' }
      : { since: null, note: 'Full history.' },
    coverage: {
      couplesInCohort: facts.length,
      touchpointsScanned: data.touchpoints.length,
      note:
        'Cohort is engaged couples only: resolved, booked, ghost or completed. Channel-scoped ' +
        'prospects never entered the funnel and are not in these rates.',
    },
    preTourSignals,
    contentMentions,
    caveat:
      'Both halves are comparisons between groups couples sorted themselves into, over small ' +
      'numbers. A couple who is already keen is more likely to mention a reel and more likely to ' +
      'book, which would produce this pattern with no causal link at all. State the n every time ' +
      'and do not say a signal caused a booking.',
  }
}

const tool: Anthropic.Tool = {
  name: TOOL_GET_CONVERSION_SIGNALS,
  description:
    'What separated couples who signed from couples who went quiet, in two parts. First, the ' +
    'pre-tour behaviours (how many inbound messages, how many channels, how fast the venue ' +
    'replied, whether the tour moved) with how often each appeared before a booking against ' +
    'before a ghost, and both cohort sizes. Second, whether couples who mentioned a blog post, ' +
    'an Instagram reel, a Pinterest pin or a video booked at a different rate than couples who ' +
    'mentioned none, with the quotes. Use it for "what predicted signing", "which pre-tour ' +
    'signals matter", "do couples who mention our content convert better". Every rate carries ' +
    'its n and is a correlation between self-selected groups, never a cause.',
  input_schema: {
    type: 'object',
    properties: {
      since: {
        type: 'string',
        description:
          'Inclusive lower bound, ISO date (YYYY-MM-DD). Omit for full history, which is usually ' +
          'right here because the cohorts are small.',
      },
    },
    additionalProperties: false,
  },
}

export const signalsSource: IntelToolSource = {
  tool,
  subjects: [
    'which pre-tour message signals went with signing rather than ghosting',
    'whether mentioning a blog post, reel, pin or video goes with a better booking rate',
  ],
  batteryQuestions: ['25', '28'],
  run: runConversionSignals,
}
