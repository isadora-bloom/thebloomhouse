/**
 * D9 — text-pattern extractors (battery Q13 / Q15 / Q27).
 *
 * Q13/Q15 ask whether mentions of a topic (climate control, budget)
 * are rising over time. We scan the text inside touchpoints.raw_payload
 * for keyword families and count, per month, how many inbound
 * touchpoints mention each family.
 *
 * Q27 asks whether the language of first messages is shifting — we
 * track the median word count and question count of each couple's
 * first inbound touchpoint over time.
 *
 * These are deterministic keyword counters, not an LLM pass. They are
 * meant to surface a measurable signal an operator can act on; the
 * LLM-driven theme detection lives in the separate Wave 5B cohort
 * rollup, which this surface links to rather than duplicates.
 */

import type { CohortData, PatternSeries, TextPatternResult } from './types'
import type { CoupleFacts } from './facts'
import { isOutbound } from './direction'
import { median, zonedParts } from './helpers'

interface Family {
  family: string
  label: string
  pattern: RegExp
}

const FAMILIES: Family[] = [
  {
    family: 'climate_control',
    label: 'Climate control / AC',
    pattern:
      /\b(air[\s-]?condition\w*|a\/?c\b|climate[\s-]?control|temperature|too (hot|cold|warm)|heat(ing|ed)?\b|ventilat\w*|how (hot|cold|warm))\b/i,
  },
  {
    family: 'budget',
    label: 'Budget / pricing',
    pattern:
      /\b(budget|afford\w*|how much|pricing|price|cost\w*|expensive|cheap\w*|deposit|payment plan|too (much|pricey))\b/i,
  },
]

/** Pull whatever human-written text a touchpoint carries. */
function touchpointText(raw: Record<string, unknown> | null): string {
  if (!raw) return ''
  const parts: string[] = []
  for (const key of ['subject', 'body_preview', 'full_body', 'body']) {
    const v = raw[key]
    if (typeof v === 'string' && v) parts.push(v)
  }
  return parts.join(' \n ')
}

function classifyTrend(
  rates: number[],
): 'rising' | 'steady' | 'declining' | 'insufficient_data' {
  if (rates.length < 4) return 'insufficient_data'
  const mid = Math.floor(rates.length / 2)
  const older = rates.slice(0, mid)
  const recent = rates.slice(mid)
  const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length
  const o = avg(older)
  const r = avg(recent)
  if (o === 0) return r > 0 ? 'rising' : 'steady'
  if (r > o * 1.25) return 'rising'
  if (r < o * 0.8) return 'declining'
  return 'steady'
}

export function computeTextPatterns(
  data: CohortData,
  facts: CoupleFacts[],
): TextPatternResult {
  // Monthly buckets: inbound touchpoint count + per-family mention count.
  const monthInbound = new Map<string, number>()
  const monthFamily = new Map<string, Map<string, number>>()
  for (const f of FAMILIES) monthFamily.set(f.family, new Map())

  for (const tp of data.touchpoints) {
    if (isOutbound(tp)) continue
    const p = zonedParts(tp.occurred_at, data.timezone)
    if (!p) continue
    const mk = p.monthKey
    monthInbound.set(mk, (monthInbound.get(mk) ?? 0) + 1)

    const text = touchpointText(tp.raw_payload)
    if (!text) continue
    for (const fam of FAMILIES) {
      if (fam.pattern.test(text)) {
        const fm = monthFamily.get(fam.family)!
        fm.set(mk, (fm.get(mk) ?? 0) + 1)
      }
    }
  }

  const months = [...monthInbound.keys()].sort()

  const families: PatternSeries[] = FAMILIES.map((fam) => {
    const fm = monthFamily.get(fam.family)!
    const monthly = months.map((mk) => ({
      month: mk,
      mentions: fm.get(mk) ?? 0,
      inboundTotal: monthInbound.get(mk) ?? 0,
    }))
    const rates = monthly
      .filter((m) => m.inboundTotal > 0)
      .map((m) => m.mentions / m.inboundTotal)
    return {
      family: fam.family,
      label: fam.label,
      monthly,
      trend: classifyTrend(rates),
    }
  })

  // First-message language over time (Q27).
  const fmByMonth = new Map<string, { words: number[]; questions: number[] }>()
  for (const f of facts) {
    const firstInbound = f.touchpoints.find((t) => !isOutbound(t))
    if (!firstInbound) continue
    const p = zonedParts(firstInbound.occurred_at, data.timezone)
    if (!p) continue
    const text = touchpointText(firstInbound.raw_payload)
    if (!text.trim()) continue
    const words = text.trim().split(/\s+/).length
    const questions = (text.match(/\?/g) ?? []).length
    const bucket = fmByMonth.get(p.monthKey) ?? { words: [], questions: [] }
    bucket.words.push(words)
    bucket.questions.push(questions)
    fmByMonth.set(p.monthKey, bucket)
  }
  const firstMessageMonthly = [...fmByMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, b]) => ({
      month,
      n: b.words.length,
      medianWords: median(b.words),
      medianQuestions: median(b.questions),
    }))

  return {
    families,
    firstMessage: {
      monthly: firstMessageMonthly,
      note:
        firstMessageMonthly.length < 4
          ? 'Not enough months of first-message text to read a shift yet.'
          : 'Median word count and question count of each couple’s first message, by month.',
    },
  }
}
