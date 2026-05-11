/**
 * Wave 18 — Sonnet calibration narrator.
 *
 * Anchor docs:
 *   - feedback_measure_dont_assume.md (measurement must be readable;
 *     a Brier score on its own helps no one — narrate the meaning)
 *   - bloom-may9-llm-vs-template.md (every "AI / Sage / smart" surface
 *     must be a real callAI; narrator is a Sonnet call, not a
 *     template lookup)
 *
 * What this does
 * --------------
 * Takes a CalibrationReport and asks Sonnet to write a 2-3 paragraph
 * plain-English read of the model's calibration:
 *   - Is it well-calibrated overall?
 *   - Where does it disagree with reality the most?
 *   - Is there persona-specific drift?
 *   - Direction of trend (drift section)?
 *
 * Cost target: ~$0.02 per analysis run.
 */

import { callAI } from '@/lib/ai/client'
import type { CalibrationReport } from './analyze'

export const CALIBRATION_NARRATOR_PROMPT_VERSION =
  'calibration-narrator/v1@2026-05-11'

const SYSTEM_PROMPT = `You are the calibration auditor for a wedding-venue prediction model.

Your job is to read a calibration report (Brier score, reliability
bins, per-persona breakdown, drift over 30/90/365d windows) and write
a SHORT, PLAIN-LANGUAGE read for the venue operator.

Style rules:
- 2-3 short paragraphs. No headings. No bullet lists. No markdown.
- Plain English. The reader is a coordinator, not a data scientist.
  Translate Brier into "X% better/worse than coin-flip" not "0.18".
- Never use em-dashes. Use a comma or a period.
- Don't invent details that aren't in the report.
- If n < 20, say so explicitly: "we don't have enough data yet to
  call this reliable". Don't pretend.
- Lead with the most-important sentence: are we well-calibrated or
  not? Then explain WHERE the gap is. Then the trend.

What you're scoring against:
- Brier score: 0 is perfect, 0.25 is a coin flip (random guess for a
  balanced 50/50 prior), > 0.25 is worse than guessing. For most
  real-world wedding venues with ~10-30% conversion, a Brier under
  0.18 is good, 0.18-0.22 is OK, > 0.22 is suspect.
- Above-50 accuracy: of predictions we made at >= 50%, what % actually
  booked? Should be > 50% for a useful model. If it's lower than the
  base rate, the model is overconfident on the high end.
- Below-50 accuracy: same for the low end. Should be > 50% for the
  "predicted low, was lost" case. If lower, the model is missing
  actually-lost couples.
- Reliability bins: well-calibrated = average predicted ≈ average
  actual within each decile. Call out the biggest gap.
- Drift: is the recent 30d window noticeably worse than 365d? If so,
  flag a regression.

Return ONLY the prose paragraphs. No JSON, no markdown.`

export interface NarrateCalibrationResult {
  narrative: string
  costCents: number
  promptVersion: string
  inputTokens: number
  outputTokens: number
}

function summariseReport(report: CalibrationReport): string {
  // Compact textual digest for the model. We DON'T pass raw JSON
  // because the model wastes output budget echoing labels back at us.
  const lines: string[] = []
  lines.push(`Window: last ${report.windowDays} days`)
  lines.push(`Sample size (n): ${report.n}`)
  lines.push(
    `Brier score: ${report.brierScore ?? 'NA'} (0 = perfect, 0.25 = random)`,
  )
  lines.push(`Overall accuracy: ${report.accuracyPct ?? 'NA'}%`)
  lines.push(
    `Above-50 accuracy (of high-confidence predictions, % that booked): ${
      report.above50AccuracyPct ?? 'NA'
    }%`,
  )
  lines.push(
    `Below-50 accuracy (of low-confidence predictions, % that did NOT book): ${
      report.below50AccuracyPct ?? 'NA'
    }%`,
  )
  lines.push(
    `Mean absolute error (avg gap between predicted and actual, in pp): ${
      report.meanAbsoluteErrorPct ?? 'NA'
    }`,
  )

  lines.push('')
  lines.push('Reliability bins (predicted decile → actual booking rate):')
  for (const b of report.reliabilityBins) {
    if (b.count === 0) continue
    lines.push(
      `  ${b.predictedFloor.toFixed(0)}-${b.predictedCeil.toFixed(0)}%: n=${b.count}, avg predicted=${
        b.avgPredicted !== null ? b.avgPredicted.toFixed(1) : 'NA'
      }%, actual booked rate=${
        b.actualBookedRate !== null ? b.actualBookedRate.toFixed(1) : 'NA'
      }%`,
    )
  }

  if (report.perPersona.length > 0) {
    lines.push('')
    lines.push('Per-persona calibration:')
    for (const p of report.perPersona) {
      lines.push(
        `  ${p.persona} (n=${p.n}): Brier=${
          p.brierScore !== null ? p.brierScore.toFixed(3) : 'NA'
        }, accuracy=${p.accuracyPct !== null ? p.accuracyPct.toFixed(1) : 'NA'}%, avg predicted=${
          p.avgPredictedPct ?? 'NA'
        }%, avg actual=${p.avgActualPct ?? 'NA'}%`,
      )
    }
  }

  lines.push('')
  lines.push('Drift (rolling windows):')
  for (const d of report.drift) {
    lines.push(
      `  ${d.windowLabel}: n=${d.n}, Brier=${
        d.brierScore !== null ? d.brierScore.toFixed(3) : 'NA'
      }, accuracy=${d.accuracyPct !== null ? d.accuracyPct.toFixed(1) : 'NA'}%`,
    )
  }

  lines.push('')
  lines.push(
    `Diagnostics: ${report.diagnostics.snapshotsTotal} snapshots total, ${
      report.diagnostics.outcomesTotal
    } measured, ${report.diagnostics.pendingMeasurement} pending.`,
  )

  return lines.join('\n')
}

export async function narrateCalibration(
  report: CalibrationReport,
  options: { correlationId?: string } = {},
): Promise<NarrateCalibrationResult> {
  const summary = summariseReport(report)

  const result = await callAI({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      'Write the calibration read for this venue. Lead sentence FIRST.\n\n' +
      summary,
    tier: 'sonnet',
    taskType: 'calibration_narrator',
    contentTier: 4, // aggregate / anonymised — no PII
    promptVersion: CALIBRATION_NARRATOR_PROMPT_VERSION,
    venueId: report.venueId,
    maxTokens: 700,
    temperature: 0.3,
    correlationId: options.correlationId,
  })

  return {
    narrative: result.text.trim(),
    costCents: result.cost * 100,
    promptVersion: CALIBRATION_NARRATOR_PROMPT_VERSION,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  }
}
