'use client'

/**
 * Wave 6D — reusable flag display card.
 *
 * Anchor: bloom-wave4-5-6-master-plan.md (6D flag triage panel).
 *
 * Embeddable on:
 *   - /intel/marketing-roi/flags (dedicated triage dashboard)
 *   - any future surface that wants to show a single flag inline
 *
 * AUTO-FLAG NEVER AUTO-EXECUTE: the action buttons record an operator
 * decision (acknowledge / dismiss / mark actioned). They never mutate
 * spend.
 */

import { useCallback, useState } from 'react'
import {
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Eye,
  Activity,
  TrendingDown,
  TrendingUp,
  Shuffle,
  Zap,
  ChevronDown,
  ChevronRight,
  Loader2,
} from 'lucide-react'

export interface FlagPanelRow {
  id: string
  venue_id: string
  flag_type: string
  flag_title: string
  flag_text: string
  severity: string
  source_channel: string | null
  target_persona: string | null
  cohort_data: Record<string, unknown>
  duration_days: number
  estimated_impact_cents: number | null
  recommended_action: string | null
  status: string
  first_detected_at: string
  last_confirmed_at: string
  acknowledged_at: string | null
  acknowledgment_note: string | null
  resolved_at: string | null
}

export interface SpendFlagPanelProps {
  flag: FlagPanelRow
  onAcknowledge: (flagId: string, note: string | null) => Promise<void>
  onDismiss: (flagId: string, reason: string) => Promise<void>
  onAction: (flagId: string, note: string | null) => Promise<void>
}

function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—'
  const abs = Math.abs(cents) / 100
  const sign = cents < 0 ? '-' : '+'
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}k`
  return `${sign}$${abs.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 'never'
  const diffMs = Date.now() - t
  const sec = Math.floor(diffMs / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.floor(hr / 24)
  return `${days}d ago`
}

function flagTypeStyle(type: string): {
  icon: React.ReactNode
  label: string
} {
  switch (type) {
    case 'underperforming_pause_candidate':
      return {
        icon: <TrendingDown className="h-3 w-3" />,
        label: 'Underperformer',
      }
    case 'overperforming_scale_candidate':
      return {
        icon: <TrendingUp className="h-3 w-3" />,
        label: 'Scale candidate',
      }
    case 'cac_exceeds_ltv':
      return {
        icon: <AlertCircle className="h-3 w-3" />,
        label: 'CAC > LTV',
      }
    case 'persona_drift':
      return {
        icon: <Shuffle className="h-3 w-3" />,
        label: 'Persona drift',
      }
    case 'channel_anomaly':
      return {
        icon: <Zap className="h-3 w-3" />,
        label: 'Anomaly',
      }
    default:
      return {
        icon: <Activity className="h-3 w-3" />,
        label: type,
      }
  }
}

function severityStyle(severity: string): {
  border: string
  bg: string
  badge: string
  text: string
} {
  switch (severity) {
    case 'critical':
      return {
        border: 'border-rose-300',
        bg: 'bg-rose-50/50',
        badge: 'bg-rose-100 text-rose-800 border-rose-200',
        text: 'text-rose-900',
      }
    case 'warning':
      return {
        border: 'border-amber-300',
        bg: 'bg-amber-50/50',
        badge: 'bg-amber-100 text-amber-800 border-amber-200',
        text: 'text-amber-900',
      }
    case 'info':
    default:
      return {
        border: 'border-sky-200',
        bg: 'bg-sky-50/30',
        badge: 'bg-sky-100 text-sky-800 border-sky-200',
        text: 'text-sky-900',
      }
  }
}

function formatChannelLabel(c: string | null | undefined): string {
  if (!c) return ''
  const map: Record<string, string> = {
    google_ads: 'Google Ads',
    meta_ads: 'Meta Ads',
    tiktok_ads: 'TikTok Ads',
    theknot_fee: 'The Knot',
    weddingwire_fee: 'WeddingWire',
    organic_seo: 'Organic SEO',
    vendor_referral: 'Vendor Referral',
  }
  return (
    map[c] ?? c.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
  )
}

function formatPersonaLabel(p: string | null | undefined): string {
  if (!p) return ''
  return p.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function SpendFlagPanel({
  flag,
  onAcknowledge,
  onDismiss,
  onAction,
}: SpendFlagPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [showDismiss, setShowDismiss] = useState(false)
  const [dismissReason, setDismissReason] = useState('')

  const sev = severityStyle(flag.severity)
  const typ = flagTypeStyle(flag.flag_type)
  const isTerminal =
    flag.status === 'dismissed' ||
    flag.status === 'actioned' ||
    flag.status === 'resolved'

  const handleAcknowledge = useCallback(async () => {
    setBusy(true)
    try {
      await onAcknowledge(flag.id, note.trim() ? note.trim() : null)
      setNote('')
    } finally {
      setBusy(false)
    }
  }, [flag.id, note, onAcknowledge])

  const handleAction = useCallback(async () => {
    setBusy(true)
    try {
      await onAction(flag.id, note.trim() ? note.trim() : null)
      setNote('')
    } finally {
      setBusy(false)
    }
  }, [flag.id, note, onAction])

  const handleDismiss = useCallback(async () => {
    if (!dismissReason.trim()) return
    setBusy(true)
    try {
      await onDismiss(flag.id, dismissReason.trim())
      setDismissReason('')
      setShowDismiss(false)
    } finally {
      setBusy(false)
    }
  }, [flag.id, dismissReason, onDismiss])

  const cohort = flag.cohort_data ?? {}

  return (
    <div className={`rounded-2xl border ${sev.border} ${sev.bg} p-5`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${sev.badge}`}
            >
              {flag.severity === 'critical' ? (
                <AlertCircle className="h-3 w-3" />
              ) : (
                <AlertTriangle className="h-3 w-3" />
              )}
              {flag.severity.toUpperCase()}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-stone-200 bg-white px-2 py-0.5 text-xs text-stone-700">
              {typ.icon}
              {typ.label}
            </span>
            {flag.duration_days > 0 ? (
              <span className="text-xs text-stone-500">
                · {flag.duration_days}d sustained
              </span>
            ) : null}
            <span className="text-xs text-stone-400">
              · last seen {relativeTime(flag.last_confirmed_at)}
            </span>
          </div>
          <h3 className={`mt-2 font-serif text-lg ${sev.text}`}>
            {flag.flag_title}
          </h3>
        </div>

        {flag.estimated_impact_cents !== null ? (
          <div className="text-right">
            <div
              className={`text-xl font-semibold tabular-nums ${
                flag.estimated_impact_cents >= 0
                  ? 'text-emerald-700'
                  : 'text-rose-700'
              }`}
            >
              {formatCents(flag.estimated_impact_cents)}
            </div>
            <div className="text-xs text-stone-500">
              {flag.estimated_impact_cents >= 0 ? 'upside' : 'at stake'}
            </div>
          </div>
        ) : null}
      </div>

      {(flag.source_channel || flag.target_persona) ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-stone-700">
          {flag.source_channel ? (
            <span className="rounded-md border border-stone-200 bg-white px-2 py-0.5 text-xs">
              {formatChannelLabel(flag.source_channel)}
            </span>
          ) : null}
          {flag.target_persona ? (
            <span className="rounded-md border border-sage-200 bg-white px-2 py-0.5 text-xs text-stone-700">
              Persona: {formatPersonaLabel(flag.target_persona)}
            </span>
          ) : null}
        </div>
      ) : null}

      <p className="mt-3 text-sm text-stone-700">{flag.flag_text}</p>

      {flag.recommended_action ? (
        <div className="mt-3 rounded-md border border-stone-200 bg-white p-3 text-sm text-stone-700">
          <div className="text-[11px] uppercase tracking-wide text-stone-500">
            Recommended action
          </div>
          <div className="mt-0.5">{flag.recommended_action}</div>
        </div>
      ) : null}

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
        Cohort data
      </button>
      {expanded ? (
        <div className="mt-2 rounded-md border border-stone-100 bg-white p-3 text-xs text-stone-700">
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-stone-600">
            {JSON.stringify(cohort, null, 2)}
          </pre>
        </div>
      ) : null}

      {flag.acknowledgment_note ? (
        <div className="mt-3 rounded-md border border-stone-100 bg-white p-2 text-xs text-stone-600">
          <span className="text-[11px] uppercase tracking-wide text-stone-500">
            Note
          </span>
          <div className="mt-0.5">{flag.acknowledgment_note}</div>
        </div>
      ) : null}

      {!isTerminal ? (
        <div className="mt-4 space-y-2 border-t border-stone-200 pt-3">
          {!showDismiss ? (
            <>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional note…"
                className="w-full rounded-md border border-stone-200 bg-white px-3 py-1.5 text-xs"
              />
              <div className="flex flex-wrap gap-2">
                {flag.status === 'pending' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleAcknowledge}
                    className="inline-flex items-center gap-1 rounded-md border border-stone-200 bg-white px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                  >
                    {busy ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Eye className="h-3 w-3" />
                    )}
                    Acknowledge
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleAction}
                  className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                >
                  <CheckCircle2 className="h-3 w-3" />
                  Mark actioned
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setShowDismiss(true)}
                  className="inline-flex items-center gap-1 rounded-md border border-stone-200 bg-white px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                >
                  <XCircle className="h-3 w-3" />
                  Dismiss
                </button>
              </div>
            </>
          ) : (
            <div className="flex flex-wrap gap-2">
              <input
                type="text"
                value={dismissReason}
                onChange={(e) => setDismissReason(e.target.value)}
                placeholder="Reason for dismissing (required)…"
                className="flex-1 rounded-md border border-stone-200 bg-white px-3 py-1.5 text-xs"
              />
              <button
                type="button"
                disabled={busy || !dismissReason.trim()}
                onClick={handleDismiss}
                className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs text-rose-800 hover:bg-rose-100 disabled:opacity-50"
              >
                Confirm dismiss
              </button>
              <button
                type="button"
                onClick={() => setShowDismiss(false)}
                className="inline-flex items-center gap-1 rounded-md border border-stone-200 bg-white px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-50"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      ) : null}

      {isTerminal ? (
        <div className="mt-3 text-xs text-stone-500">
          Status:{' '}
          <span className="font-medium text-stone-700">{flag.status}</span>
          {flag.resolved_at ? ` · resolved ${relativeTime(flag.resolved_at)}` : null}
        </div>
      ) : null}
    </div>
  )
}
