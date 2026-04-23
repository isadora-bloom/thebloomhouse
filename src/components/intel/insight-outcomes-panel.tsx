'use client'

/**
 * Insight Outcomes Panel — Phase 3 Task 36.
 *
 * Reads /api/intel/outcomes and renders a ranked list of applied insights
 * with their measured improvement_pct and verdict. Until this shipped
 * there was no UI reader for insight_outcomes — it was a write-only
 * table populated by the cron.
 */

import { useEffect, useState } from 'react'
import { TrendingUp, TrendingDown, Minus, Clock, ArrowRight } from 'lucide-react'

interface OutcomeRow {
  id: string
  insight_id: string
  action_taken: string | null
  acted_at: string
  baseline_metric: string
  baseline_value: number | null
  outcome_value: number | null
  improvement_pct: number | null
  verdict: 'pending' | 'improved' | 'unchanged' | 'declined'
}

interface Summary {
  total: number
  improved: number
  unchanged: number
  declined: number
  pending: number
}

function verdictIcon(v: OutcomeRow['verdict']) {
  if (v === 'improved') return <TrendingUp className="w-4 h-4 text-emerald-600" />
  if (v === 'declined') return <TrendingDown className="w-4 h-4 text-rose-600" />
  if (v === 'pending') return <Clock className="w-4 h-4 text-amber-600" />
  return <Minus className="w-4 h-4 text-sage-500" />
}

export function InsightOutcomesPanel() {
  const [outcomes, setOutcomes] = useState<OutcomeRow[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      try {
        const res = await fetch('/api/intel/outcomes?limit=20')
        if (!res.ok) {
          if (res.status === 403) {
            setError('Intelligence plan required')
          } else {
            setError(`Failed to load (HTTP ${res.status})`)
          }
          return
        }
        const data = await res.json()
        setOutcomes((data.outcomes as OutcomeRow[]) ?? [])
        setSummary((data.summary as Summary) ?? null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  if (loading) return null
  if (error) return null
  if (outcomes.length === 0) return null

  return (
    <div className="bg-white border border-sage-200 rounded-xl p-5 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="font-heading text-base font-semibold text-sage-900">
            Applied recommendations — what happened
          </h2>
          <p className="text-xs text-sage-500 mt-0.5">
            Baseline-vs-outcome measurements for insights the coordinator acted on.
          </p>
        </div>
        {summary && (
          <div className="flex gap-3 text-xs">
            <span className="text-emerald-700">
              <strong>{summary.improved}</strong> improved
            </span>
            <span className="text-sage-600">
              <strong>{summary.unchanged}</strong> unchanged
            </span>
            <span className="text-rose-700">
              <strong>{summary.declined}</strong> declined
            </span>
            <span className="text-amber-700">
              <strong>{summary.pending}</strong> pending
            </span>
          </div>
        )}
      </div>
      <div className="space-y-2">
        {outcomes.map((o) => (
          <div
            key={o.id}
            className="flex items-start gap-3 border-b border-sage-100 pb-2 last:border-0 last:pb-0"
          >
            <div className="pt-0.5">{verdictIcon(o.verdict)}</div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-sage-900">
                {o.action_taken || `Applied insight on ${o.baseline_metric}`}
              </p>
              <p className="text-xs text-sage-500 mt-0.5 flex items-center gap-2">
                <span>{o.baseline_metric}</span>
                {o.baseline_value !== null && o.outcome_value !== null && (
                  <>
                    <span className="tabular-nums">
                      {Number(o.baseline_value).toFixed(2)}
                    </span>
                    <ArrowRight className="w-3 h-3" />
                    <span className="tabular-nums">
                      {Number(o.outcome_value).toFixed(2)}
                    </span>
                  </>
                )}
              </p>
            </div>
            {o.improvement_pct !== null && (
              <div
                className={`text-sm font-semibold tabular-nums shrink-0 ${
                  o.verdict === 'improved'
                    ? 'text-emerald-700'
                    : o.verdict === 'declined'
                      ? 'text-rose-700'
                      : 'text-sage-600'
                }`}
              >
                {(o.improvement_pct > 0 ? '+' : '') +
                  Number(o.improvement_pct).toFixed(1)}
                %
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
