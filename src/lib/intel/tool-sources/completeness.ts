/**
 * Record completeness (battery Q30: "what percentage of inquiries in the last
 * 90 days have complete records versus partial").
 *
 * The product already answers half of this. `loadDataCompleteness`
 * (src/lib/services/intel/data-completeness.ts) counts couples in the window
 * that have a reachable identifier and at least one touchpoint, and that
 * number is returned here untouched as `canonicalBaseline` so this tool and
 * the rest of the product never quote two different figures.
 *
 * What it does not answer is the half of the question about gaps. "Complete"
 * in Q30 means the record is whole, and a record with an inbound message, no
 * reply on file and a two-month hole in the middle is not whole even though
 * it has an email address. So this source states the definition in full,
 * applies it, and hands the definition back in the result:
 *
 *   hasFirstTouch  at least one touchpoint inside the window
 *   hasReply       the venue replied at least once after the couple's first
 *                  replyable message (same predicates the cohort funnel uses)
 *   hasIdentity    a reachable identifier on the couple, email or phone
 *   noLongGap      no gap longer than 30 days between consecutive touchpoints
 *
 * Complete = all four. Partial = anything else, with the failing criteria
 * named per couple so the answer is actionable rather than a bare percentage.
 *
 * On the gap rule: only gaps BETWEEN touchpoints count. Silence since the last
 * touchpoint is a fact about the couple, not a hole in the record, and
 * counting it would mark every quiet-but-complete record incomplete.
 */

import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadDataCompleteness, type DataCompleteness } from '@/lib/services/intel/data-completeness'
import { isOutbound } from '@/lib/services/cohort/direction'
import { isMessageableInbound } from '@/lib/services/cohort/facts'
import { MIN_DISTRIBUTION_N, type TouchpointRow } from '@/lib/services/cohort/types'
import { insufficient, type IntelToolSource, type ToolSourceDeps } from './types'

export const TOOL_GET_RECORD_COMPLETENESS = 'get_record_completeness'

const DEFAULT_WINDOW_DAYS = 90
const MAX_WINDOW_DAYS = 1825

/** A hole longer than this between two consecutive touchpoints reads as a
 *  missing stretch of the record rather than a quiet patch. */
export const MAX_GAP_DAYS = 30

/** How many partial records to name back. Enough to act on, short enough to
 *  read. */
const EXAMPLE_CAP = 10

const COUPLE_ROW_LIMIT = 10000
const TOUCHPOINT_ROW_LIMIT = 50000

const DAY_MS = 86_400_000

// ---------------------------------------------------------------------------
// Per-couple verdict
// ---------------------------------------------------------------------------

export type CompletenessCriterion = 'hasFirstTouch' | 'hasReply' | 'hasIdentity' | 'noLongGap'

export interface CoupleCompleteness {
  coupleId: string
  names: string | null
  complete: boolean
  hasFirstTouch: boolean
  hasReply: boolean
  hasIdentity: boolean
  noLongGap: boolean
  /** Largest gap in days between two consecutive touchpoints. null when the
   *  couple has fewer than two. */
  longestGapDays: number | null
  touchpointCount: number
  /** The criteria this record fails, in the order they are defined. */
  missing: CompletenessCriterion[]
}

export interface CompletenessCoupleInput {
  id: string
  primaryContactName: string | null
  partnerContactName: string | null
  primaryContactEmail: string | null
  primaryContactPhone: string | null
}

function displayName(primary: string | null, partner: string | null): string | null {
  if (primary && partner) return `${primary} & ${partner}`
  return primary ?? partner ?? null
}

/** Apply the four-part definition to one couple. Pure, so the test drives it
 *  without a client. Touchpoints need not be sorted. */
export function assessCoupleCompleteness(
  couple: CompletenessCoupleInput,
  touchpoints: readonly TouchpointRow[],
  maxGapDays = MAX_GAP_DAYS,
): CoupleCompleteness {
  const sorted = [...touchpoints].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))

  const hasFirstTouch = sorted.length > 0
  const hasIdentity = Boolean(
    (couple.primaryContactEmail ?? '').trim() || (couple.primaryContactPhone ?? '').trim(),
  )

  let firstMessageable: TouchpointRow | null = null
  let hasReply = false
  for (const tp of sorted) {
    const outbound = isOutbound(tp)
    if (!outbound && !firstMessageable && isMessageableInbound(tp)) firstMessageable = tp
    if (
      outbound &&
      firstMessageable &&
      Date.parse(tp.occurred_at) >= Date.parse(firstMessageable.occurred_at)
    ) {
      hasReply = true
    }
  }

  let longestGapDays: number | null = null
  for (let i = 1; i < sorted.length; i++) {
    const gap = Date.parse(sorted[i].occurred_at) - Date.parse(sorted[i - 1].occurred_at)
    if (!Number.isFinite(gap) || gap < 0) continue
    const days = gap / DAY_MS
    if (longestGapDays === null || days > longestGapDays) longestGapDays = days
  }
  const roundedGap = longestGapDays === null ? null : Math.round(longestGapDays * 10) / 10
  const noLongGap = roundedGap === null ? true : roundedGap <= maxGapDays

  const missing: CompletenessCriterion[] = []
  if (!hasFirstTouch) missing.push('hasFirstTouch')
  if (!hasReply) missing.push('hasReply')
  if (!hasIdentity) missing.push('hasIdentity')
  if (!noLongGap) missing.push('noLongGap')

  return {
    coupleId: couple.id,
    names: displayName(couple.primaryContactName, couple.partnerContactName),
    complete: missing.length === 0,
    hasFirstTouch,
    hasReply,
    hasIdentity,
    noLongGap,
    longestGapDays: roundedGap,
    touchpointCount: sorted.length,
    missing,
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

interface CoupleRow {
  id: string
  primary_contact_name: string | null
  partner_contact_name: string | null
  primary_contact_email: string | null
  primary_contact_phone: string | null
}

/** Same window rule `loadDataCompleteness` applies: activity in the window,
 *  keyed on last_progression_at, because created_at is stamped to now() by the
 *  Phase-2 reimport and would say every record is new. */
async function loadWindow(
  supabase: SupabaseClient,
  venueId: string,
  cutoffIso: string,
): Promise<{ couples: CoupleRow[]; byCouple: Map<string, TouchpointRow[]> }> {
  const { data: coupleData } = await supabase
    .from('couples')
    .select(
      'id, primary_contact_name, partner_contact_name, primary_contact_email, primary_contact_phone',
    )
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
    .gte('last_progression_at', cutoffIso)
    .limit(COUPLE_ROW_LIMIT)
  const couples = (coupleData ?? []) as CoupleRow[]

  const byCouple = new Map<string, TouchpointRow[]>()
  if (couples.length === 0) return { couples, byCouple }

  const ids = new Set(couples.map((c) => c.id))
  const { data: tpData } = await supabase
    .from('touchpoints')
    .select('id, couple_id, channel, action_type, occurred_at, signal_tier, confidence_tier, raw_payload')
    .eq('venue_id', venueId)
    .gte('occurred_at', cutoffIso)
    .limit(TOUCHPOINT_ROW_LIMIT)
  for (const row of (tpData ?? []) as TouchpointRow[]) {
    if (!row.couple_id || !ids.has(row.couple_id)) continue
    const list = byCouple.get(row.couple_id)
    if (list) list.push(row)
    else byCouple.set(row.couple_id, [row])
  }
  return { couples, byCouple }
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

function windowDaysArg(args: Record<string, unknown>): number {
  const raw = args.window_days
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_DAYS
  return Math.min(MAX_WINDOW_DAYS, Math.floor(n))
}

export interface CompletenessDefinition {
  windowDays: number
  maxGapDays: number
  criteria: Record<CompletenessCriterion, string>
  complete: string
  partial: string
  windowRule: string
}

function definitionFor(windowDays: number): CompletenessDefinition {
  return {
    windowDays,
    maxGapDays: MAX_GAP_DAYS,
    criteria: {
      hasFirstTouch: 'At least one touchpoint on record inside the window.',
      hasReply:
        'The venue replied at least once after the couple\'s first replyable message. A ' +
        'self-service action such as a Calendly booking is not a replyable message.',
      hasIdentity: 'A reachable identifier on the couple record: an email address or a phone number.',
      noLongGap:
        `No gap longer than ${MAX_GAP_DAYS} days between two consecutive touchpoints. Silence ` +
        'since the last touchpoint does not count, because that is a fact about the couple ' +
        'rather than a hole in the record.',
    },
    complete: 'All four criteria true.',
    partial: 'Any one of the four false. The failing criteria are named per couple.',
    windowRule:
      'Couples with activity in the window, keyed on last_progression_at rather than created_at ' +
      '(the Phase-2 reimport stamps created_at to the import time).',
  }
}

export async function runRecordCompleteness(
  venueId: string,
  args: Record<string, unknown>,
  deps: ToolSourceDeps,
): Promise<unknown> {
  const windowDays = windowDaysArg(args)
  const nowMs = Number.isFinite(Date.parse(deps.today)) ? Date.parse(deps.today) : Date.now()
  const cutoffIso = new Date(nowMs - windowDays * DAY_MS).toISOString()

  const [baseline, window] = await Promise.all([
    loadDataCompleteness(deps.supabase, venueId, nowMs, windowDays).catch(
      () => null as DataCompleteness | null,
    ),
    loadWindow(deps.supabase, venueId, cutoffIso),
  ])

  const assessed = window.couples.map((c) =>
    assessCoupleCompleteness(
      {
        id: c.id,
        primaryContactName: c.primary_contact_name,
        partnerContactName: c.partner_contact_name,
        primaryContactEmail: c.primary_contact_email,
        primaryContactPhone: c.primary_contact_phone,
      },
      window.byCouple.get(c.id) ?? [],
    ),
  )

  const n = assessed.length
  const complete = assessed.filter((a) => a.complete).length
  const partial = n - complete

  const failureCounts: Record<CompletenessCriterion, number> = {
    hasFirstTouch: 0,
    hasReply: 0,
    hasIdentity: 0,
    noLongGap: 0,
  }
  for (const a of assessed) {
    for (const m of a.missing) failureCounts[m] += 1
  }

  const partialExamples = assessed
    .filter((a) => !a.complete)
    .sort((a, b) => b.missing.length - a.missing.length)
    .slice(0, EXAMPLE_CAP)
    .map((a) => ({
      coupleId: a.coupleId,
      names: a.names,
      missing: a.missing,
      longestGapDays: a.longestGapDays,
      touchpointCount: a.touchpointCount,
    }))

  const rate =
    n < MIN_DISTRIBUTION_N
      ? {
          value: null,
          ...insufficient(
            n,
            n === 0
              ? `No couple has activity in the last ${windowDays} days, so there is nothing to score.`
              : `Only ${n} record(s) in the window, against a minimum of ${MIN_DISTRIBUTION_N}. ` +
                'The raw counts are below; a percentage over this many records would be noise.',
          ),
        }
      : {
          value: Math.round((complete / n) * 1000) / 10,
          n,
          enoughData: true,
        }

  return {
    asOf: deps.today,
    definition: definitionFor(windowDays),
    counts: { recordsInWindow: n, complete, partial },
    completePercent: rate,
    failureCounts,
    partialExamples: { n: partialExamples.length, of: partial, couples: partialExamples },
    canonicalBaseline:
      baseline === null
        ? { note: 'The existing completeness reader could not be read on this call.' }
        : {
            note:
              'The product\'s existing Q30 figure, on the narrower two-part definition ' +
              '(reachable identifier and at least one touchpoint). Kept here so this tool and ' +
              'the rest of the product never quote two different numbers.',
            couplesInWindow: baseline.couplesInWindow,
            complete: baseline.complete,
            partial: baseline.partial,
            completeFraction: baseline.completeFraction,
            partialReasons: baseline.partialReasons,
          },
    caveat:
      'Completeness here is about the record, not the couple. A record can be complete and the ' +
      'couple still cold. Quote the definition alongside the percentage, because "complete" is a ' +
      'choice Bloom made rather than a fact about the world.',
  }
}

const tool: Anthropic.Tool = {
  name: TOOL_GET_RECORD_COMPLETENESS,
  description:
    'How complete the venue\'s inquiry records are over a trailing window, on a stated four-part ' +
    'definition: a first touchpoint, a venue reply, a reachable identifier (email or phone), and ' +
    'no gap longer than 30 days between consecutive touchpoints. Returns the definition itself, ' +
    'the counts, the complete percentage with its n, how many records fail each criterion, and up ' +
    'to ten named partial records with what each is missing. Use it for "how complete is my data", ' +
    '"what percentage of my inquiries have full records", "where are the gaps". Below eight ' +
    'records in the window it returns the raw counts and no percentage.',
  input_schema: {
    type: 'object',
    properties: {
      window_days: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_WINDOW_DAYS,
        description:
          'Trailing window in days. Defaults to 90, which is what the question usually means.',
      },
    },
    additionalProperties: false,
  },
}

export const completenessSource: IntelToolSource = {
  tool,
  subjects: [
    'how complete the inquiry records are, and what is missing from the partial ones',
    'data gaps in the last 90 days',
  ],
  batteryQuestions: ['30'],
  run: runRecordCompleteness,
}
