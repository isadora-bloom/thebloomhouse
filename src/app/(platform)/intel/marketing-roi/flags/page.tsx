'use client'

/**
 * Wave 6D — /intel/marketing-roi/flags page.
 *
 * Anchor: bloom-wave4-5-6-master-plan.md (6D auto-flag triage dashboard:
 * Critical / Warning / Info sections; per-flag acknowledge / dismiss /
 * mark actioned; top counts + manual "Detect now" trigger.)
 *
 * Distinct from /intel/marketing-roi (Wave 6B's heatmap dashboard) and
 * /intel/marketing-roi/recommendations (Wave 6C's reallocation
 * dashboard). This page is for forensic-detected flags — the around-
 * the-recommendations layer that says "this cell is bleeding budget"
 * or "this cell is outperforming, scale it".
 *
 * AUTO-FLAG NEVER AUTO-EXECUTE. Every action is operator-decided.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  Loader2,
  Sparkles,
  Activity,
} from 'lucide-react'
import { SpendFlagPanel, type FlagPanelRow } from '@/components/intel/SpendFlagPanel'

interface ListResponse {
  ok: true
  venueId: string
  flags: FlagPanelRow[]
}

interface DetectResponse {
  ok: boolean
  flagsCreated?: number
  flagsConfirmed?: number
  flagsResolved?: number
  diagnostics?: {
    rollupCellsScanned: number
    activeFlagsBefore: number
  }
  error?: string
}

const SEVERITIES = ['critical', 'warning', 'info'] as const

type SeverityValue = (typeof SEVERITIES)[number]

const SEVERITY_LABEL: Record<SeverityValue, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
}

export default function MarketingFlagsPage() {
  const [flags, setFlags] = useState<FlagPanelRow[]>([])
  const [loading, setLoading] = useState(true)
  const [detecting, setDetecting] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [detectMsg, setDetectMsg] = useState<string | null>(null)
  const [filter, setFilter] = useState<
    'all' | 'pending' | 'acknowledged' | 'actioned' | 'dismissed' | 'resolved'
  >('pending')

  const fetchAll = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const params = new URLSearchParams()
      if (filter !== 'all') params.set('status', filter)
      const resp = await fetch(
        `/api/admin/intel/marketing-loop/flags?${params.toString()}`,
      )
      const j = (await resp.json()) as ListResponse | { ok: false; error: string }
      if (!resp.ok || !('ok' in j) || j.ok !== true) {
        setErr(
          'error' in j && typeof j.error === 'string'
            ? j.error
            : 'Failed to load flags',
        )
        return
      }
      setFlags(j.flags)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    void fetchAll()
  }, [fetchAll])

  const handleDetect = useCallback(async () => {
    setDetecting(true)
    setDetectMsg(null)
    try {
      const resp = await fetch('/api/admin/intel/marketing-loop/detect-flags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const j = (await resp.json()) as DetectResponse
      if (!resp.ok || !j.ok) {
        setDetectMsg(`Detect failed: ${j.error ?? 'unknown error'}`)
      } else {
        setDetectMsg(
          `Detected: ${j.flagsCreated ?? 0} new · ${j.flagsConfirmed ?? 0} confirmed · ${j.flagsResolved ?? 0} resolved.`,
        )
        await fetchAll()
      }
    } catch (e) {
      setDetectMsg(
        `Detect threw: ${e instanceof Error ? e.message : String(e)}`,
      )
    } finally {
      setDetecting(false)
    }
  }, [fetchAll])

  const handleAcknowledge = useCallback(
    async (flagId: string, note: string | null) => {
      const resp = await fetch(
        `/api/admin/intel/marketing-loop/flags/${flagId}/acknowledge`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note }),
        },
      )
      const j = (await resp.json()) as { ok: boolean; error?: string }
      if (!resp.ok || !j.ok) {
        setErr(`Acknowledge failed: ${j.error ?? 'unknown'}`)
        return
      }
      await fetchAll()
    },
    [fetchAll],
  )

  const handleDismiss = useCallback(
    async (flagId: string, reason: string) => {
      const resp = await fetch(
        `/api/admin/intel/marketing-loop/flags/${flagId}/dismiss`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        },
      )
      const j = (await resp.json()) as { ok: boolean; error?: string }
      if (!resp.ok || !j.ok) {
        setErr(`Dismiss failed: ${j.error ?? 'unknown'}`)
        return
      }
      await fetchAll()
    },
    [fetchAll],
  )

  const handleAction = useCallback(
    async (flagId: string, note: string | null) => {
      const resp = await fetch(
        `/api/admin/intel/marketing-loop/flags/${flagId}/action`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note }),
        },
      )
      const j = (await resp.json()) as { ok: boolean; error?: string }
      if (!resp.ok || !j.ok) {
        setErr(`Action failed: ${j.error ?? 'unknown'}`)
        return
      }
      await fetchAll()
    },
    [fetchAll],
  )

  const grouped = useMemo(() => {
    const out = new Map<SeverityValue, FlagPanelRow[]>()
    for (const s of SEVERITIES) out.set(s, [])
    for (const f of flags) {
      const s = (SEVERITIES as readonly string[]).includes(f.severity)
        ? (f.severity as SeverityValue)
        : 'info'
      out.get(s)!.push(f)
    }
    return out
  }, [flags])

  const counts = useMemo(() => {
    const out = { critical: 0, warning: 0, info: 0, total: flags.length }
    for (const f of flags) {
      if (f.severity === 'critical') out.critical += 1
      else if (f.severity === 'warning') out.warning += 1
      else out.info += 1
    }
    return out
  }, [flags])

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl text-stone-900">
            Marketing flags
          </h1>
          <p className="mt-1 text-sm text-stone-600">
            Auto-detected red and green flags from the persona × channel
            rollup. The system flags; you decide. Never auto-spends.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={filter}
            onChange={(e) =>
              setFilter(
                e.target.value as
                  | 'all'
                  | 'pending'
                  | 'acknowledged'
                  | 'actioned'
                  | 'dismissed'
                  | 'resolved',
              )
            }
            className="rounded-md border border-stone-200 bg-white px-3 py-2 text-xs"
          >
            <option value="pending">Pending</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="actioned">Actioned</option>
            <option value="dismissed">Dismissed</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </select>
          <button
            type="button"
            onClick={handleDetect}
            disabled={detecting}
            className="inline-flex items-center gap-2 rounded-md border border-stone-900 bg-stone-900 px-3 py-2 text-xs text-white hover:bg-stone-800 disabled:opacity-50"
          >
            {detecting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="h-3 w-3" />
            )}
            Detect now
          </button>
        </div>
      </div>

      {/* Top counts */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3">
          <div className="text-[11px] uppercase tracking-wide text-rose-700">
            Critical
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-rose-900">
            {counts.critical}
          </div>
        </div>
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
          <div className="text-[11px] uppercase tracking-wide text-amber-700">
            Warning
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-amber-900">
            {counts.warning}
          </div>
        </div>
        <div className="rounded-md border border-sky-200 bg-sky-50 p-3">
          <div className="text-[11px] uppercase tracking-wide text-sky-700">
            Info
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-sky-900">
            {counts.info}
          </div>
        </div>
        <div className="rounded-md border border-stone-200 bg-white p-3">
          <div className="text-[11px] uppercase tracking-wide text-stone-700">
            Total
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-stone-900">
            {counts.total}
          </div>
        </div>
      </div>

      {err ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          <AlertCircle className="mr-2 inline h-4 w-4 align-baseline" />
          {err}
        </div>
      ) : null}

      {detectMsg ? (
        <div className="rounded-md border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
          {detectMsg}
        </div>
      ) : null}

      {loading && flags.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-stone-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : null}

      {!loading && flags.length === 0 ? (
        <div className="rounded-md border border-stone-200 bg-white p-8 text-center text-sm text-stone-500">
          <Activity className="mx-auto mb-2 h-5 w-5 text-stone-400" />
          No flags in the &quot;{filter}&quot; status. Run &quot;Detect
          now&quot; or check a different filter.
        </div>
      ) : null}

      {SEVERITIES.map((severity) => {
        const rows = grouped.get(severity) ?? []
        if (rows.length === 0) return null
        return (
          <section key={severity}>
            <h2 className="mb-3 flex items-center gap-2 font-serif text-lg text-stone-900">
              {severity === 'critical' ? (
                <AlertCircle className="h-4 w-4 text-rose-600" />
              ) : severity === 'warning' ? (
                <AlertTriangle className="h-4 w-4 text-amber-600" />
              ) : (
                <Activity className="h-4 w-4 text-sky-600" />
              )}
              {SEVERITY_LABEL[severity]}{' '}
              <span className="text-sm font-normal text-stone-500">
                ({rows.length})
              </span>
            </h2>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {rows.map((f) => (
                <SpendFlagPanel
                  key={f.id}
                  flag={f}
                  onAcknowledge={handleAcknowledge}
                  onDismiss={handleDismiss}
                  onAction={handleAction}
                />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
