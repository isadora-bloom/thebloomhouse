/**
 * D9 — response-time -> tour-conversion curve (battery Q3 / Q25).
 *
 * Q3 asks where the "knee" is: at what response speed does the tour
 * conversion rate fall off. Couples are bucketed into response-time
 * bands; each band's tour rate is computed; the knee is the band
 * boundary with the steepest drop (only bands with enough couples to
 * be meaningful are considered).
 *
 * Q25 asks which pre-tour signals predict signing. For couples that
 * toured, we compare how often each signal appeared before a booking
 * vs before a ghost, and report the lift.
 */

import type { CurveBand, CurveResult } from './types'
import type { CoupleFacts } from './facts'
import { isOutbound } from './direction'
import { ratio } from './helpers'

const BAND_DEFS: { label: string; lower: number; upper: number | null }[] = [
  { label: 'Under 1 hour', lower: 0, upper: 1 },
  { label: '1-4 hours', lower: 1, upper: 4 },
  { label: '4-12 hours', lower: 4, upper: 12 },
  { label: '12-24 hours', lower: 12, upper: 24 },
  { label: '1-3 days', lower: 24, upper: 72 },
  { label: '3-7 days', lower: 72, upper: 168 },
  { label: 'Over 7 days', lower: 168, upper: null },
]

/** A band needs at least this many couples before its tour rate is
 *  trusted for knee detection. */
const MIN_BAND_N = 6

function bandFor(hours: number): number {
  for (let i = 0; i < BAND_DEFS.length; i++) {
    const b = BAND_DEFS[i]
    if (hours >= b.lower && (b.upper === null || hours < b.upper)) return i
  }
  return BAND_DEFS.length - 1
}

export function computeCurve(facts: CoupleFacts[]): CurveResult {
  const replied = facts.filter((f) => f.responseHours !== null)

  // Bands.
  const bandCouples: CoupleFacts[][] = BAND_DEFS.map(() => [])
  for (const f of replied) {
    bandCouples[bandFor(f.responseHours as number)].push(f)
  }
  const bands: CurveBand[] = BAND_DEFS.map((def, i) => {
    const couples = bandCouples[i]
    const toured = couples.filter((f) => f.toured).length
    return {
      label: def.label,
      lowerHours: def.lower,
      upperHours: def.upper,
      couples: couples.length,
      touredRate: ratio(toured, couples.length),
    }
  })

  // Knee — steepest drop between two consecutive trustworthy bands.
  let kneeBandIndex: number | null = null
  let kneeNote = 'Not enough couples across the bands to locate a knee.'
  let steepestDrop = 0
  let prevTrusted: { idx: number; rate: number } | null = null
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i]
    if (b.couples < MIN_BAND_N || b.touredRate === null) continue
    if (prevTrusted) {
      const drop = prevTrusted.rate - b.touredRate
      if (drop > steepestDrop) {
        steepestDrop = drop
        kneeBandIndex = prevTrusted.idx
      }
    }
    prevTrusted = { idx: i, rate: b.touredRate }
  }
  if (kneeBandIndex !== null && steepestDrop > 0.05) {
    const kb = bands[kneeBandIndex]
    kneeNote =
      `Tour conversion holds through "${kb.label}", then drops ` +
      `${Math.round(steepestDrop * 100)} points. Replying within ` +
      `${kb.upperHours ?? '?'}h is where the curve bends.`
  } else if (prevTrusted) {
    kneeBandIndex = null
    kneeNote =
      'No sharp knee — tour conversion declines gradually as response ' +
      'time grows, rather than falling off a cliff at one threshold.'
  }

  // Pre-tour signals (Q25). Over couples that toured.
  const toured = facts.filter((f) => f.toured)
  const touredBookers = toured.filter((f) => f.booked)
  const touredGhosts = toured.filter((f) => f.isGhost)

  const SIGNALS: { signal: string; test: (f: CoupleFacts) => boolean }[] = [
    {
      signal: '3+ inbound touchpoints before the tour',
      test: (f) => preTourInbound(f).length >= 3,
    },
    {
      signal: 'Reached out on 2+ channels before the tour',
      test: (f) => new Set(preTourInbound(f).map((t) => t.channel)).size >= 2,
    },
    {
      signal: 'Venue replied within 4 hours',
      test: (f) => f.responseHours !== null && f.responseHours < 4,
    },
    {
      signal: 'Tour was rescheduled at least once',
      test: (f) =>
        f.touchpoints.some((t) => t.action_type === 'tour_rescheduled'),
    },
  ]

  const preTourSignals = SIGNALS.map((s) => {
    const beforeBooking = touredBookers.filter(s.test).length
    const beforeGhost = touredGhosts.filter(s.test).length
    const bookerRate = ratio(beforeBooking, touredBookers.length)
    const ghostRate = ratio(beforeGhost, touredGhosts.length)
    const lift =
      bookerRate !== null && ghostRate !== null && ghostRate > 0
        ? Math.round((bookerRate / ghostRate) * 100) / 100
        : null
    return { signal: s.signal, beforeBooking, beforeGhost, lift }
  })

  return { bands, kneeBandIndex, kneeNote, preTourSignals }
}

/** Inbound touchpoints that occurred strictly before the couple's
 *  tour. When tourAt is unknown, returns []. */
function preTourInbound(f: CoupleFacts) {
  if (!f.tourAt) return []
  const tourMs = Date.parse(f.tourAt)
  return f.touchpoints.filter(
    (t) => !isOutbound(t) && Date.parse(t.occurred_at) < tourMs,
  )
}
