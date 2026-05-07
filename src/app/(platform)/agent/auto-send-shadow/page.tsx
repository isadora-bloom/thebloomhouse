'use client'

/**
 * /agent/auto-send-shadow — coordinator review surface for shadow-mode
 * eligibility decisions.
 *
 * Tier-B #67A. While an auto_send_rule is in shadow_mode, every
 * eligibility decision is logged here instead of firing a real send.
 * Coordinator reviews each decision (correct / wrong_send / wrong_block),
 * then promotes the rule to live with one click once they're confident.
 *
 * Layout:
 *   Top: rules in shadow with their status + "Promote" button.
 *   Below: list of recent decisions with quick verdict actions.
 */

import { useEffect, useState, useCallback } from 'react'
import { Loader2, CheckCircle2, XCircle, AlertTriangle, ArrowRight } from 'lucide-react'

interface Rule {
  id: string
  context: string
  source: string | null
  enabled: boolean
  shadow_mode: boolean
  shadow_started_at: string | null
  graduated_at: string | null
}

interface Decision {
  id: string
  rule_id: string | null
  draft_id: string | null
  wedding_id: string | null
  thread_id: string | null
  context_type: string
  source: string | null
  confidence_score: number
  injection_suspected: boolean
  would_have_sent: boolean
  reason: string
  reviewed_at: string | null
  review_verdict: 'correct' | 'wrong_send' | 'wrong_block' | null
  review_note: string | null
  created_at: string
}

type Verdict = 'correct' | 'wrong_send' | 'wrong_block'

export default function AutoSendShadowPage() {
  const [rules, setRules] = useState<Rule[]>([])
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'unreviewed'>('unreviewed')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const url = new URL('/api/agent/auto-send-shadow', window.location.origin)
      if (filter === 'unreviewed') url.searchParams.set('unreviewed', '1')
      const res = await fetch(url.toString())
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Failed to load')
        return
      }
      setRules(data.rules ?? [])
      setDecisions(data.decisions ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    load()
  }, [load])

  async function setVerdict(id: string, verdict: Verdict) {
    setBusy(id)
    try {
      const res = await fetch('/api/agent/auto-send-shadow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verdict', id, verdict }),
      })
      if (!res.ok) {
        const body = await res.json()
        setError(body.error ?? 'Failed to save verdict')
      }
      await load()
    } finally {
      setBusy(null)
    }
  }

  async function promoteRule(ruleId: string, ruleLabel: string) {
    if (
      !window.confirm(
        `Promote "${ruleLabel}" to live? Future eligible drafts will auto-send instead of being held in shadow.`,
      )
    )
      return
    setBusy(ruleId)
    try {
      const res = await fetch('/api/agent/auto-send-shadow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'promote', ruleId }),
      })
      if (!res.ok) {
        const body = await res.json()
        setError(body.error ?? 'Failed to promote')
      }
      await load()
    } finally {
      setBusy(null)
    }
  }

  const shadowRules = rules.filter((r) => r.enabled && r.shadow_mode)
  const liveRules = rules.filter((r) => r.enabled && !r.shadow_mode)
  const decisionsByRule = decisions.reduce<Record<string, Decision[]>>(
    (acc, d) => {
      const k = d.rule_id ?? 'orphan'
      if (!acc[k]) acc[k] = []
      acc[k].push(d)
      return acc
    },
    {},
  )

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <header className="mb-8">
        <h1 className="font-heading text-2xl font-bold text-sage-900 mb-2">
          Auto-send shadow review
        </h1>
        <p className="text-sm text-sage-600 leading-relaxed">
          When a rule is in shadow mode, eligibility decisions are
          recorded here instead of firing. Review each decision,
          then promote the rule to live once you trust it. The same
          eligibility logic runs in shadow and live, so a clean shadow
          log is the strongest signal that live behaviour will match.
        </p>
      </header>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <section className="mb-10">
        <h2 className="font-medium text-sage-900 mb-3">
          Rules currently in shadow ({shadowRules.length})
        </h2>
        {shadowRules.length === 0 ? (
          <div className="rounded-xl border border-dashed border-sage-200 bg-white p-6 text-sm text-sage-500">
            No rules are in shadow mode. New rules default to shadow
            until you promote them.
          </div>
        ) : (
          <div className="space-y-3">
            {shadowRules.map((rule) => {
              const ruleDecisions = decisionsByRule[rule.id] ?? []
              const verdicts = ruleDecisions
                .map((d) => d.review_verdict)
                .filter(Boolean) as Verdict[]
              const correctCount = verdicts.filter((v) => v === 'correct').length
              const wrongCount = verdicts.length - correctCount
              const ruleLabel = `${rule.context} / ${rule.source ?? 'all'}`
              return (
                <div
                  key={rule.id}
                  className="rounded-xl border border-sage-100 bg-white p-5 flex items-center justify-between gap-4"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-sage-900">{ruleLabel}</p>
                    <p className="text-xs text-sage-500 mt-1">
                      {ruleDecisions.length} decisions logged ·{' '}
                      {correctCount} confirmed correct · {wrongCount} flagged wrong
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => promoteRule(rule.id, ruleLabel)}
                    disabled={busy === rule.id}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sage-700 text-white text-sm font-medium hover:bg-sage-800 disabled:opacity-50"
                  >
                    {busy === rule.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <ArrowRight className="w-4 h-4" />
                    )}
                    Promote to live
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {liveRules.length > 0 && (
        <section className="mb-10">
          <h2 className="font-medium text-sage-900 mb-3">
            Already live ({liveRules.length})
          </h2>
          <div className="space-y-2">
            {liveRules.map((rule) => (
              <div
                key={rule.id}
                className="rounded-lg border border-sage-50 bg-sage-50/40 px-4 py-2 text-sm text-sage-700"
              >
                {rule.context} / {rule.source ?? 'all'}
                {rule.graduated_at && (
                  <span className="ml-2 text-xs text-sage-500">
                    promoted {new Date(rule.graduated_at).toLocaleDateString()}
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-medium text-sage-900">Recent decisions</h2>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
            className="text-xs border border-sage-200 rounded-lg px-2 py-1 bg-white"
          >
            <option value="unreviewed">Unreviewed only</option>
            <option value="all">All recent</option>
          </select>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sage-500 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading…
          </div>
        ) : decisions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-sage-200 bg-white p-6 text-sm text-sage-500">
            No decisions yet. They appear here as eligibility runs in
            shadow.
          </div>
        ) : (
          <div className="space-y-2">
            {decisions.map((d) => (
              <div
                key={d.id}
                className="rounded-xl border border-sage-100 bg-white p-4"
              >
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      {d.would_have_sent ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-50 text-green-700">
                          <CheckCircle2 className="w-3 h-3" />
                          Would have sent
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-stone-100 text-stone-700">
                          <XCircle className="w-3 h-3" />
                          Would have blocked
                        </span>
                      )}
                      {d.injection_suspected && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-50 text-amber-700">
                          <AlertTriangle className="w-3 h-3" />
                          Injection
                        </span>
                      )}
                      <span className="text-[11px] text-sage-500">
                        {d.context_type} · {d.source ?? 'direct'} · conf{' '}
                        {d.confidence_score}
                      </span>
                    </div>
                    <p className="text-sm text-sage-700 leading-relaxed">
                      {d.reason}
                    </p>
                    <p className="text-xs text-sage-400 mt-1">
                      {new Date(d.created_at).toLocaleString()}
                    </p>
                  </div>
                </div>

                {d.review_verdict ? (
                  <div className="mt-3 text-xs">
                    Marked{' '}
                    <span className="font-medium">
                      {d.review_verdict.replace('_', ' ')}
                    </span>
                    {d.reviewed_at && (
                      <span className="text-sage-400 ml-2">
                        {new Date(d.reviewed_at).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setVerdict(d.id, 'correct')}
                      disabled={busy === d.id}
                      className="text-xs px-3 py-1.5 rounded-lg bg-green-100 text-green-800 hover:bg-green-200 disabled:opacity-50"
                    >
                      Correct
                    </button>
                    <button
                      type="button"
                      onClick={() => setVerdict(d.id, 'wrong_send')}
                      disabled={busy === d.id}
                      className="text-xs px-3 py-1.5 rounded-lg bg-red-100 text-red-800 hover:bg-red-200 disabled:opacity-50"
                    >
                      Wrong send
                    </button>
                    <button
                      type="button"
                      onClick={() => setVerdict(d.id, 'wrong_block')}
                      disabled={busy === d.id}
                      className="text-xs px-3 py-1.5 rounded-lg bg-amber-100 text-amber-800 hover:bg-amber-200 disabled:opacity-50"
                    >
                      Wrong block
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
