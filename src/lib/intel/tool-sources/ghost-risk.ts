/**
 * Ghost risk, with the calibration record for the predictor behind it.
 * Battery Q19: "which inquiries this month are most likely to ghost".
 *
 * Nothing here is new machinery. `loadGhostRisk`
 * (src/lib/services/intel/ghost-risk.ts) already ranks active couples by
 * decay proximity and heat and returns the evidence for each rank; it was
 * only ever wired into the deprecated NLQ brain, so the tool-calling path
 * could not reach it. This source exposes it, and adds the two things Q19
 * needs on top:
 *
 *   1. Per-couple contact evidence the ranker does not carry: which channel
 *      the couple arrived on, which channel they last used, and how long the
 *      venue took to reply the first time. Both are derived with the SAME
 *      predicates the cohort funnel uses (`isOutbound`, `isMessageableInbound`),
 *      so "a reply" means one thing across the product.
 *
 *   2. The calibration record. A ranking that says "these five will go quiet"
 *      is worth nothing without a measured history of how often that call was
 *      right, so `analyzeCalibration` is read alongside and returned whole.
 *      When it has fewer than twenty measured outcomes the block comes back
 *      with enoughData false and says why, rather than quoting a Brier score
 *      off six rows.
 *
 * Honest framing the result carries out loud: the ranking is a rule over decay
 * and heat, not a fitted probability, and the calibration on record is for the
 * close-probability predictor, which shares heat as an input. That is the
 * nearest measured thing there is; pretending it measures the ghost ranking
 * itself would be the sort of quiet overclaim the whole tool layer exists to
 * stop.
 */

import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadGhostRisk, type GhostRiskAssessment } from '@/lib/services/intel/ghost-risk'
import { analyzeCalibration } from '@/lib/services/calibration/analyze'
import { isOutbound } from '@/lib/services/cohort/direction'
import { isMessageableInbound } from '@/lib/services/cohort/facts'
import type { TouchpointRow } from '@/lib/services/cohort/types'
import { insufficient, type IntelToolSource, type ToolSourceDeps } from './types'

export const TOOL_GET_GHOST_RISK = 'get_ghost_risk'

/** The prediction kind the calibration service actually holds outcomes for. */
const PREDICTION_KIND = 'close_probability_pct'

/** A year, so a venue that books slowly still accumulates terminal outcomes.
 *  Same default `loadPersonaBiasSummaryForVenue` uses for the same reason. */
const CALIBRATION_WINDOW_DAYS = 365

/** analyze.ts calls its own headline metric "sufficient" at n >= 20. Use the
 *  same bar here so two surfaces never disagree about whether the predictor
 *  has earned the right to be quoted. */
const CALIBRATION_MIN_N = 20

/** Touchpoint rows pulled for the ranked couples only. Ranked output is
 *  capped at 25 couples upstream, so this bound is generous. */
const CONTACT_ROW_LIMIT = 4000

const HOUR_MS = 3_600_000

// ---------------------------------------------------------------------------
// Contact evidence
// ---------------------------------------------------------------------------

export interface ContactEvidence {
  /** Channel of the couple's earliest touchpoint of any direction. */
  firstTouchChannel: string | null
  /** Channel of their most recent touchpoint. */
  lastTouchChannel: string | null
  lastTouchAt: string | null
  /** Hours from the couple's first replyable message to the venue's first
   *  reply. null when they never sent one, or the venue never answered. */
  responseDelayHours: number | null
  /** Why responseDelayHours is null, when it is. */
  responseDelayNote: string | null
  touchpointCount: number
}

const NO_CONTACT: ContactEvidence = {
  firstTouchChannel: null,
  lastTouchChannel: null,
  lastTouchAt: null,
  responseDelayHours: null,
  responseDelayNote: 'No touchpoints on record for this couple.',
  touchpointCount: 0,
}

/** Derive contact evidence for one couple from its touchpoints, ascending by
 *  occurred_at. Pure, so the test drives it without a client. */
export function buildContactEvidence(rows: readonly TouchpointRow[]): ContactEvidence {
  if (rows.length === 0) return NO_CONTACT
  const sorted = [...rows].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))

  let firstMessageable: TouchpointRow | null = null
  let firstReply: TouchpointRow | null = null
  for (const tp of sorted) {
    const outbound = isOutbound(tp)
    if (!outbound && !firstMessageable && isMessageableInbound(tp)) firstMessageable = tp
    if (
      outbound &&
      !firstReply &&
      firstMessageable &&
      Date.parse(tp.occurred_at) >= Date.parse(firstMessageable.occurred_at)
    ) {
      firstReply = tp
    }
  }

  let responseDelayHours: number | null = null
  let responseDelayNote: string | null = null
  if (!firstMessageable) {
    responseDelayNote =
      'No replyable inbound message yet, so there is no response delay to measure.'
  } else if (!firstReply) {
    responseDelayNote = 'The couple wrote and the venue has not replied yet.'
  } else {
    const gap = Date.parse(firstReply.occurred_at) - Date.parse(firstMessageable.occurred_at)
    if (Number.isFinite(gap) && gap >= 0) {
      responseDelayHours = Math.round((gap / HOUR_MS) * 10) / 10
    } else {
      responseDelayNote = 'Reply timestamps are out of order, so the delay is not trustworthy.'
    }
  }

  const last = sorted[sorted.length - 1]
  return {
    firstTouchChannel: sorted[0].channel ?? null,
    lastTouchChannel: last.channel ?? null,
    lastTouchAt: last.occurred_at,
    responseDelayHours,
    responseDelayNote,
    touchpointCount: sorted.length,
  }
}

async function loadContactEvidence(
  supabase: SupabaseClient,
  venueId: string,
  coupleIds: readonly string[],
): Promise<Map<string, ContactEvidence>> {
  const out = new Map<string, ContactEvidence>()
  if (coupleIds.length === 0) return out

  const { data } = await supabase
    .from('touchpoints')
    .select('id, couple_id, channel, action_type, occurred_at, signal_tier, confidence_tier, raw_payload')
    .eq('venue_id', venueId)
    .in('couple_id', coupleIds as string[])
    .order('occurred_at', { ascending: true })
    .limit(CONTACT_ROW_LIMIT)

  const byCouple = new Map<string, TouchpointRow[]>()
  for (const row of (data ?? []) as TouchpointRow[]) {
    if (!row.couple_id) continue
    const list = byCouple.get(row.couple_id)
    if (list) list.push(row)
    else byCouple.set(row.couple_id, [row])
  }
  for (const id of coupleIds) {
    out.set(id, buildContactEvidence(byCouple.get(id) ?? []))
  }
  return out
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

export interface CalibrationBlock {
  predictionKind: string
  windowDays: number
  n: number
  enoughData: boolean
  reason?: string
  /** Mean squared error of the predicted probability. Lower is better. */
  brierScore: number | null
  /** Share of predictions whose direction matched the outcome. */
  accuracyPct: number | null
  /** Of predictions under 50, the share that genuinely did not book. This is
   *  the closest measured answer to "how often was the quiet call right". */
  didNotBookCallAccuracyPct: number | null
  bookedCallAccuracyPct: number | null
  outcomesAwaitingMeasurement: number | null
  note: string
}

const CALIBRATION_NOTE =
  'Measured on the close-probability predictor, which shares heat as an input with this ' +
  'ranking. The ranking itself is a rule over decay and heat, not a fitted model, so it has ' +
  'no calibration curve of its own yet. Read this as the nearest measured evidence, not as ' +
  'proof the ranking is right.'

async function loadCalibrationBlock(
  supabase: SupabaseClient,
  venueId: string,
): Promise<CalibrationBlock> {
  const bare = {
    predictionKind: PREDICTION_KIND,
    windowDays: CALIBRATION_WINDOW_DAYS,
    brierScore: null,
    accuracyPct: null,
    didNotBookCallAccuracyPct: null,
    bookedCallAccuracyPct: null,
    outcomesAwaitingMeasurement: null,
    note: CALIBRATION_NOTE,
  }

  let report: Awaited<ReturnType<typeof analyzeCalibration>>
  try {
    report = await analyzeCalibration({
      venueId,
      kind: PREDICTION_KIND,
      windowDays: CALIBRATION_WINDOW_DAYS,
      supabase,
    })
  } catch (err) {
    return {
      ...bare,
      ...insufficient(
        0,
        `Calibration history could not be read (${err instanceof Error ? err.message : String(err)}), ` +
          'so there is no measured track record to quote.',
      ),
    }
  }

  const enough = report.n >= CALIBRATION_MIN_N
  return {
    ...bare,
    n: report.n,
    enoughData: enough,
    ...(enough
      ? {}
      : {
          reason:
            `Only ${report.n} prediction${report.n === 1 ? '' : 's'} in the last ` +
            `${CALIBRATION_WINDOW_DAYS} days has a measured outcome, against a minimum of ` +
            `${CALIBRATION_MIN_N}. The predictor is not yet reliable enough to quote a hit rate. ` +
            `${report.diagnostics.pendingMeasurement} prediction(s) are still waiting on an outcome.`,
        }),
    brierScore: enough ? report.brierScore : null,
    accuracyPct: enough ? report.accuracyPct : null,
    didNotBookCallAccuracyPct: enough ? report.below50AccuracyPct : null,
    bookedCallAccuracyPct: enough ? report.above50AccuracyPct : null,
    outcomesAwaitingMeasurement: report.diagnostics.pendingMeasurement,
  }
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface RankedGhostRiskCouple {
  coupleId: string
  names: string | null
  riskTier: GhostRiskAssessment['riskTier']
  evidence: {
    daysSilent: number | null
    lastActivityOn: string | null
    decayFractionOfWindow: number | null
    heatScore: number
    heatBucket: GhostRiskAssessment['heatBucket']
    firstTouchChannel: string | null
    lastTouchChannel: string | null
    lastTouchAt: string | null
    responseDelayHours: number | null
    responseDelayNote: string | null
    touchpointCount: number
  }
  /** Plain-English reasons straight from the ranker. */
  why: string[]
}

function activityDate(today: string, daysSilent: number | null): string | null {
  if (daysSilent === null) return null
  const base = Date.parse(today)
  if (!Number.isFinite(base)) return null
  return new Date(base - daysSilent * 86_400_000).toISOString().slice(0, 10)
}

export async function runGhostRisk(
  venueId: string,
  _args: Record<string, unknown>,
  deps: ToolSourceDeps,
): Promise<unknown> {
  const nowMs = Number.isFinite(Date.parse(deps.today)) ? Date.parse(deps.today) : Date.now()

  const [assessments, calibration] = await Promise.all([
    loadGhostRisk(deps.supabase, venueId, nowMs),
    loadCalibrationBlock(deps.supabase, venueId),
  ])

  const contact = await loadContactEvidence(
    deps.supabase,
    venueId,
    assessments.map((a) => a.coupleId),
  )

  const couples: RankedGhostRiskCouple[] = assessments.map((a) => {
    const c = contact.get(a.coupleId) ?? NO_CONTACT
    return {
      coupleId: a.coupleId,
      names: a.names,
      riskTier: a.riskTier,
      evidence: {
        daysSilent: a.daysQuiet,
        lastActivityOn: activityDate(deps.today, a.daysQuiet),
        decayFractionOfWindow: a.decayFraction,
        heatScore: a.heatScore,
        heatBucket: a.heatBucket,
        firstTouchChannel: c.firstTouchChannel,
        lastTouchChannel: c.lastTouchChannel,
        lastTouchAt: c.lastTouchAt,
        responseDelayHours: c.responseDelayHours,
        responseDelayNote: c.responseDelayNote,
        touchpointCount: c.touchpointCount,
      },
      why: a.signals,
    }
  })

  const n = couples.length
  return {
    asOf: deps.today,
    scope:
      'Active couples only: lifecycle resolved or channel_scoped. Booked, ghosted and completed ' +
      'couples are out of scope by definition. The list is every active couple above low risk, ' +
      'not only those who enquired this month, so check lastActivityOn before saying "this month".',
    method:
      'Ranked on two sourced signals, not a probability: how far through the decay window the ' +
      'couple has gone quiet, and the time-decayed heat score. Risk is high when both are bad, ' +
      'medium when one is.',
    ranked:
      n === 0
        ? {
            ...insufficient(
              0,
              'No active couple is above low risk right now, so there is nobody to rank.',
            ),
            couples: [] as RankedGhostRiskCouple[],
          }
        : { n, enoughData: true, couples },
    calibration,
    caveat:
      'These are ranked risks with their evidence attached, not predictions with a probability. ' +
      'Quote the evidence, and if calibration.enoughData is false say plainly that Bloom has not ' +
      'yet measured whether this ranking calls it right.',
  }
}

const tool: Anthropic.Tool = {
  name: TOOL_GET_GHOST_RISK,
  description:
    'Which active couples are most likely to go quiet (ghost), ranked, with the evidence behind ' +
    'each rank: days silent, the share of the decay window used up, heat score and bucket, the ' +
    'channel they arrived on, the channel they last used, and how many hours the venue took to ' +
    'reply the first time. Also returns the calibration record for the predictor, so the answer ' +
    'can say how often past calls of this kind were right. Use it for "who is about to go cold", ' +
    '"who should I chase", "who is most likely to ghost". It carries no probability and invents ' +
    'none: if calibration.enoughData is false, say that the track record is too thin to trust.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
}

export const ghostRiskSource: IntelToolSource = {
  tool,
  subjects: [
    'which couples are most likely to go quiet or ghost',
    'who to follow up with first, and why',
    'how reliable the risk ranking has been against real outcomes',
  ],
  batteryQuestions: ['19'],
  run: runGhostRisk,
}
