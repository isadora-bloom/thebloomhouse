'use client'

/**
 * Wave 6C — marketing recommendations full-page dashboard.
 *
 * Anchor: bloom-wave4-5-6-master-plan.md (6C: Pending / Accepted /
 * Declined / In progress / Completed sections. Each card shows title +
 * text + action_type badge + source→target arrow + persona pill +
 * $/mo impact + confidence + collapsible reasoning chain + n_too_small
 * warning + decide actions.)
 *
 * Doctrine
 * --------
 * FLAG-DON'T-EXECUTE. The Decide buttons record an operator decision;
 * they do NOT auto-spend. Measure-after lets the operator log actual
 * outcome cents so the dashboard can show projected vs measured.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Loader2,
  Sparkles,
  ArrowRight,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  PauseCircle,
  TrendingUp,
  Search,
  Layers,
  ChevronDown,
  ChevronRight,
  DollarSign,
  Target,
  AlertCircle,
} from 'lucide-react'

interface ReasoningChain {
  evidence_signals?: string[]
  assumed_baseline?: string
  projected_outcome?: string
  counterfactual?: string
  payback_months?: number
  key_risks?: string[]
}

interface RecommendationRow {
  id: string
  venue_id: string
  recommendation_title: string
  recommendation_text: string
  action_type: string
  source_channel: string | null
  target_channel: string | null
  target_persona: string | null
  estimated_monthly_dollar_impact_cents: number | null
  confidence_0_100: number
  reasoning_chain: ReasoningChain
  n_too_small_warning: boolean
  generated_at: string
  status: string
  decided_at: string | null
  decision_note: string | null
  actioned_at: string | null
  measured_outcome_cents: number | null
  prompt_version: string
  cost_cents: number | string
}

interface ListResponse {
  ok: true
  venueId: string
  recommendations: RecommendationRow[]
}

interface GenerateResponse {
  ok: boolean
  shortCircuited?: boolean
  generated?: number
  inserted?: number
  refusals?: Array<{ field: string; reason: string }>
  costCents?: number
  error?: string
}

const STATUSES = [
  'pending',
  'in_progress',
  'accepted',
  'completed',
  'declined',
  'invalidated',
] as const

type StatusValue = (typeof STATUSES)[number]

const STATUS_LABEL: Record<StatusValue, string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  declined: 'Declined',
  in_progress: 'In progress',
  completed: 'Completed',
  invalidated: 'Invalidated',
}

function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—'
  const abs = Math.abs(cents) / 100
  const sign = cents < 0 ? '-' : ''
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}k`
  return `${sign}$${abs.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`
}

function formatChannelLabel(c: string | null | undefined): string {
  if (!c) return '—'
  const map: Record<string, string> = {
    google_ads: 'Google Ads',
    meta_ads: 'Meta Ads',
    tiktok_ads: 'TikTok Ads',
    theknot_fee: 'The Knot',
    weddingwire_fee: 'WeddingWire',
    organic_seo: 'Organic SEO',
    vendor_referral: 'Vendor Referral',
    other: 'Other',
  }
  return (
    map[c] ?? c.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
  )
}

function formatPersonaLabel(p: string | null | undefined): string {
  if (!p) return '—'
  return p.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function actionTypeStyle(action: string): {
  icon: React.ReactNode
  label: string
  className: string
} {
  switch (action) {
    case 'reallocate':
      return {
        icon: <ArrowRight className="h-3 w-3" />,
        label: 'Reallocate',
        className: 'bg-amber-50 text-amber-800 border-amber-200',
      }
    case 'pause':
      return {
        icon: <PauseCircle className="h-3 w-3" />,
        label: 'Pause',
        className: 'bg-rose-50 text-rose-800 border-rose-200',
      }
    case 'scale':
      return {
        icon: <TrendingUp className="h-3 w-3" />,
        label: 'Scale',
        className: 'bg-emerald-50 text-emerald-800 border-emerald-200',
      }
    case 'investigate':
      return {
        icon: <Search className="h-3 w-3" />,
        label: 'Investigate',
        className: 'bg-sky-50 text-sky-800 border-sky-200',
      }
    case 'other':
    default:
      return {
        icon: <Layers className="h-3 w-3" />,
        label: 'Other',
        className: 'bg-stone-50 text-stone-700 border-stone-200',
      }
  }
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 'never'
  const diffMs = Date.now() - t
  const sec = Math.floor(diffMs / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} min ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.floor(hr / 24)
  return `${days}d ago`
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

interface RecommendationCardProps {
  rec: RecommendationRow
  onDecide: (
    recommendationId: string,
    decision: 'accepted' | 'declined' | 'in_progress' | 'completed',
    note: string | null,
  ) => Promise<void>
  onMeasure: (recommendationId: string, cents: number) => Promise<void>
}

function RecommendationCard({
  rec,
  onDecide,
  onMeasure,
}: RecommendationCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [measureCents, setMeasureCents] = useState('')
  const [showMeasure, setShowMeasure] = useState(false)

  const action = actionTypeStyle(rec.action_type)
  const impactCents = rec.estimated_monthly_dollar_impact_cents ?? null
  const impactPositive = impactCents !== null && impactCents > 0
  const impactNegative = impactCents !== null && impactCents < 0

  const handleDecide = useCallback(
    async (decision: 'accepted' | 'declined' | 'in_progress' | 'completed') => {
      setBusy(true)
      try {
        await onDecide(rec.id, decision, note.trim() ? note.trim() : null)
      } finally {
        setBusy(false)
      }
    },
    [rec.id, note, onDecide],
  )

  const handleMeasure = useCallback(async () => {
    const dollars = Number(measureCents)
    if (!Number.isFinite(dollars)) return
    const cents = Math.round(dollars * 100)
    setBusy(true)
    try {
      await onMeasure(rec.id, cents)
      setShowMeasure(false)
    } finally {
      setBusy(false)
    }
  }, [rec.id, measureCents, onMeasure])

  const variancePct = useMemo(() => {
    if (
      rec.measured_outcome_cents === null ||
      rec.estimated_monthly_dollar_impact_cents === null ||
      rec.estimated_monthly_dollar_impact_cents === 0
    ) {
      return null
    }
    const diff =
      rec.measured_outcome_cents - rec.estimated_monthly_dollar_impact_cents
    const pct =
      (diff / Math.abs(rec.estimated_monthly_dollar_impact_cents)) * 100
    return Math.round(pct * 10) / 10
  }, [rec.measured_outcome_cents, rec.estimated_monthly_dollar_impact_cents])

  const chain = rec.reasoning_chain ?? {}

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${action.className}`}
            >
              {action.icon}
              {action.label}
            </span>
            {rec.n_too_small_warning ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-800">
                <AlertTriangle className="h-3 w-3" />
                n &lt; 10
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1 rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 text-xs text-stone-700">
              <Target className="h-3 w-3" />
              {rec.confidence_0_100}% confidence
            </span>
            <span className="text-xs text-stone-400">
              · {relativeTime(rec.generated_at)}
            </span>
          </div>
          <h3 className="mt-2 font-serif text-lg text-stone-900">
            {rec.recommendation_title}
          </h3>
        </div>

        {impactCents !== null ? (
          <div className="text-right">
            <div
              className={`text-xl font-semibold tabular-nums ${
                impactPositive
                  ? 'text-emerald-700'
                  : impactNegative
                    ? 'text-rose-700'
                    : 'text-stone-700'
              }`}
            >
              <DollarSign className="inline h-4 w-4 align-baseline" />
              {formatCents(Math.abs(impactCents))}
            </div>
            <div className="text-xs text-stone-500">/ month projected</div>
          </div>
        ) : null}
      </div>

      {/* Source → target arrow with persona pill */}
      {(rec.source_channel || rec.target_channel || rec.target_persona) ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-stone-700">
          {rec.source_channel ? (
            <span className="rounded-md border border-stone-200 bg-stone-50 px-2 py-0.5 text-xs">
              {formatChannelLabel(rec.source_channel)}
            </span>
          ) : null}
          {rec.source_channel && rec.target_channel ? (
            <ArrowRight className="h-4 w-4 text-stone-400" />
          ) : null}
          {rec.target_channel ? (
            <span className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-800">
              {formatChannelLabel(rec.target_channel)}
            </span>
          ) : null}
          {rec.target_persona ? (
            <span className="rounded-md border border-sage-200 bg-sage-50 px-2 py-0.5 text-xs text-stone-700">
              Persona: {formatPersonaLabel(rec.target_persona)}
            </span>
          ) : null}
        </div>
      ) : null}

      <p className="mt-3 text-sm text-stone-700">{rec.recommendation_text}</p>

      {/* Reasoning chain (collapsible) */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="mt-3 inline-flex items-center gap-1 text-xs text-stone-500 hover:text-stone-700"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        Reasoning chain
      </button>

      {expanded ? (
        <div className="mt-2 space-y-2 rounded-md border border-stone-100 bg-stone-50 p-3 text-xs text-stone-700">
          {chain.evidence_signals && chain.evidence_signals.length > 0 ? (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-stone-500">
                Evidence
              </div>
              <ul className="mt-1 list-disc pl-4 space-y-0.5">
                {chain.evidence_signals.map((e, i) => (
                  <li key={i} className="tabular-nums">
                    {e}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {chain.assumed_baseline ? (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-stone-500">
                Baseline
              </div>
              <div className="mt-0.5">{chain.assumed_baseline}</div>
            </div>
          ) : null}
          {chain.projected_outcome ? (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-stone-500">
                Projection
              </div>
              <div className="mt-0.5">{chain.projected_outcome}</div>
            </div>
          ) : null}
          {chain.counterfactual ? (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-stone-500">
                If we don&apos;t act
              </div>
              <div className="mt-0.5">{chain.counterfactual}</div>
            </div>
          ) : null}
          {typeof chain.payback_months === 'number' ? (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-stone-500">
                Payback
              </div>
              <div className="mt-0.5 tabular-nums">
                {chain.payback_months} months
              </div>
            </div>
          ) : null}
          {chain.key_risks && chain.key_risks.length > 0 ? (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-stone-500">
                Key risks
              </div>
              <ul className="mt-1 list-disc pl-4 space-y-0.5">
                {chain.key_risks.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Measured outcome (when completed) */}
      {rec.measured_outcome_cents !== null ? (
        <div className="mt-3 rounded-md border border-stone-200 bg-stone-50 p-3 text-xs">
          <div className="text-[11px] uppercase tracking-wide text-stone-500">
            Measured outcome
          </div>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-2">
            <span className="text-base font-semibold tabular-nums text-stone-900">
              {formatCents(rec.measured_outcome_cents)}
            </span>
            <span className="text-stone-500">
              vs projected{' '}
              {formatCents(rec.estimated_monthly_dollar_impact_cents)}
            </span>
            {variancePct !== null ? (
              <span
                className={`tabular-nums ${
                  variancePct >= 0 ? 'text-emerald-700' : 'text-rose-700'
                }`}
              >
                ({variancePct >= 0 ? '+' : ''}
                {variancePct}%)
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Decision note (when set) */}
      {rec.decision_note ? (
        <div className="mt-3 rounded-md border border-stone-100 bg-stone-50 p-2 text-xs text-stone-600">
          <span className="text-[11px] uppercase tracking-wide text-stone-500">
            Decision note
          </span>
          <div className="mt-0.5">{rec.decision_note}</div>
        </div>
      ) : null}

      {/* Action row */}
      {rec.status === 'pending' || rec.status === 'accepted' ? (
        <div className="mt-4 space-y-2 border-t border-stone-100 pt-3">
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add an optional decision note…"
            className="w-full rounded-md border border-stone-200 bg-white px-3 py-1.5 text-xs"
          />
          <div className="flex flex-wrap gap-2">
            {rec.status === 'pending' ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleDecide('accepted')}
                  className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                >
                  <CheckCircle2 className="h-3 w-3" />
                  Accept
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleDecide('in_progress')}
                  className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                >
                  <Loader2 className="h-3 w-3" />
                  Mark in progress
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleDecide('declined')}
                  className="inline-flex items-center gap-1 rounded-md border border-stone-200 bg-white px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                >
                  <XCircle className="h-3 w-3" />
                  Decline
                </button>
              </>
            ) : null}
            {rec.status === 'accepted' ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => handleDecide('in_progress')}
                className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 hover:bg-amber-100 disabled:opacity-50"
              >
                <Loader2 className="h-3 w-3" />
                Mark in progress
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {rec.status === 'in_progress' ? (
        <div className="mt-4 space-y-2 border-t border-stone-100 pt-3">
          {!showMeasure ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setShowMeasure(true)}
                className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-800 hover:bg-emerald-100"
              >
                <CheckCircle2 className="h-3 w-3" />
                Record outcome
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => handleDecide('declined')}
                className="inline-flex items-center gap-1 rounded-md border border-stone-200 bg-white px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-50 disabled:opacity-50"
              >
                <XCircle className="h-3 w-3" />
                Decline retroactively
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <input
                type="number"
                value={measureCents}
                onChange={(e) => setMeasureCents(e.target.value)}
                placeholder="Actual $/mo impact (signed)"
                className="rounded-md border border-stone-200 bg-white px-3 py-1.5 text-xs"
              />
              <button
                type="button"
                disabled={busy || measureCents === ''}
                onClick={handleMeasure}
                className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
              >
                Save outcome
              </button>
              <button
                type="button"
                onClick={() => setShowMeasure(false)}
                className="inline-flex items-center gap-1 rounded-md border border-stone-200 bg-white px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-50"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function MarketingRecommendationsDashboard() {
  const [recommendations, setRecommendations] = useState<RecommendationRow[]>(
    [],
  )
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [generateMsg, setGenerateMsg] = useState<string | null>(null)
  const [refusals, setRefusals] = useState<
    Array<{ field: string; reason: string }>
  >([])

  const fetchAll = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const resp = await fetch(`/api/admin/intel/marketing-recommendations/list`)
      const j = (await resp.json()) as ListResponse | { ok: false; error: string }
      if (!resp.ok || !('ok' in j) || j.ok !== true) {
        setErr(
          'error' in j && typeof j.error === 'string'
            ? j.error
            : 'Failed to load recommendations',
        )
        return
      }
      setRecommendations(j.recommendations)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchAll()
  }, [fetchAll])

  const handleGenerate = useCallback(async () => {
    setGenerating(true)
    setGenerateMsg(null)
    setRefusals([])
    try {
      const resp = await fetch(
        '/api/admin/intel/marketing-recommendations/generate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: true }),
        },
      )
      const j = (await resp.json()) as GenerateResponse
      if (!resp.ok || !j.ok) {
        setGenerateMsg(`Generate failed: ${j.error ?? 'unknown error'}`)
      } else {
        const cost =
          typeof j.costCents === 'number' ? `$${(j.costCents / 100).toFixed(3)}` : '$0'
        setGenerateMsg(
          `Generated ${j.inserted ?? 0} recommendations (${j.refusals?.length ?? 0} refusals). Cost ${cost}.`,
        )
        if (j.refusals) setRefusals(j.refusals)
        await fetchAll()
      }
    } catch (e) {
      setGenerateMsg(
        `Generate threw: ${e instanceof Error ? e.message : String(e)}`,
      )
    } finally {
      setGenerating(false)
    }
  }, [fetchAll])

  const handleDecide = useCallback(
    async (
      recommendationId: string,
      decision: 'accepted' | 'declined' | 'in_progress' | 'completed',
      note: string | null,
    ) => {
      try {
        const resp = await fetch(
          '/api/admin/intel/marketing-recommendations/decide',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              recommendationId,
              decision,
              note,
            }),
          },
        )
        const j = (await resp.json()) as { ok: boolean; error?: string }
        if (!resp.ok || !j.ok) {
          setErr(`Decision failed: ${j.error ?? 'unknown'}`)
          return
        }
        await fetchAll()
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      }
    },
    [fetchAll],
  )

  const handleMeasure = useCallback(
    async (recommendationId: string, cents: number) => {
      try {
        const resp = await fetch(
          '/api/admin/intel/marketing-recommendations/measure',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              recommendationId,
              measuredOutcomeCents: cents,
            }),
          },
        )
        const j = (await resp.json()) as { ok: boolean; error?: string }
        if (!resp.ok || !j.ok) {
          setErr(`Measure failed: ${j.error ?? 'unknown'}`)
          return
        }
        await fetchAll()
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      }
    },
    [fetchAll],
  )

  const grouped = useMemo(() => {
    const out = new Map<StatusValue, RecommendationRow[]>()
    for (const s of STATUSES) out.set(s, [])
    for (const r of recommendations) {
      const s = (STATUSES as readonly string[]).includes(r.status)
        ? (r.status as StatusValue)
        : 'pending'
      out.get(s)!.push(r)
    }
    return out
  }, [recommendations])

  const lastGenerated = useMemo(() => {
    if (recommendations.length === 0) return null
    return recommendations.reduce((latest, r) => {
      const t = Date.parse(r.generated_at)
      return t > latest ? t : latest
    }, 0)
  }, [recommendations])

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl text-stone-900">
            Marketing recommendations
          </h1>
          <p className="mt-1 text-sm text-stone-600">
            Sonnet analyst reads the persona × channel rollup, cohort intel,
            and external signals, then proposes specific reallocation moves
            you decide on. Never auto-spends.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-stone-500">
            Last generated:{' '}
            {lastGenerated
              ? relativeTime(new Date(lastGenerated).toISOString())
              : 'never'}
          </span>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating}
            className="inline-flex items-center gap-2 rounded-md border border-stone-900 bg-stone-900 px-3 py-2 text-xs text-white hover:bg-stone-800 disabled:opacity-50"
          >
            {generating ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="h-3 w-3" />
            )}
            Generate now
          </button>
        </div>
      </div>

      {err ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          <AlertCircle className="mr-2 inline h-4 w-4 align-baseline" />
          {err}
        </div>
      ) : null}

      {generateMsg ? (
        <div className="rounded-md border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
          {generateMsg}
        </div>
      ) : null}

      {refusals.length > 0 ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <div className="font-medium">
            <AlertTriangle className="mr-1 inline h-4 w-4 align-baseline" />
            Refusals ({refusals.length})
          </div>
          <ul className="mt-2 list-disc pl-5 space-y-1 text-xs">
            {refusals.map((r, i) => (
              <li key={i}>
                <span className="font-mono text-amber-900">{r.field}</span>:{' '}
                {r.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {loading && recommendations.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-stone-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : null}

      {!loading && recommendations.length === 0 ? (
        <div className="rounded-md border border-stone-200 bg-white p-8 text-center text-sm text-stone-500">
          <Sparkles className="mx-auto mb-2 h-5 w-5 text-stone-400" />
          No recommendations yet. Run &quot;Generate now&quot; to produce a
          fresh batch.
        </div>
      ) : null}

      {STATUSES.map((status) => {
        const rows = grouped.get(status) ?? []
        if (rows.length === 0) return null
        return (
          <section key={status}>
            <h2 className="font-serif text-lg text-stone-900 mb-3">
              {STATUS_LABEL[status]}{' '}
              <span className="text-sm font-normal text-stone-500">
                ({rows.length})
              </span>
            </h2>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {rows.map((rec) => (
                <RecommendationCard
                  key={rec.id}
                  rec={rec}
                  onDecide={handleDecide}
                  onMeasure={handleMeasure}
                />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
