'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  Circle,
  Info,
  AlertOctagon,
  Building2,
  Loader2,
  RefreshCcw,
} from 'lucide-react'
import { useScope } from '@/lib/hooks/use-scope'
import { UpgradeGate } from '@/components/ui/upgrade-gate'

// ---------------------------------------------------------------------------
// Phase 6 Task 57: Anomaly Alerts page
//
// Dedicated view of every anomaly Bloom has detected for the current scope.
// Venue scope shows just that venue; group/company scope shows a cross-
// venue table with a venue chip per row.
//
// All copy is generic. The page reads the venue label from the API response
// (which joins venues.name) so there is no hardcoded "Rixey" or any other
// venue-specific string anywhere.
// ---------------------------------------------------------------------------

interface AnomalyCause {
  cause?: string
  likelihood?: 'high' | 'medium' | 'low'
  action?: string
  source?: string
  month?: string
  monthName?: string
  fillRate?: number
  saturdayFillRate?: number
  nonSaturdayFillRate?: number
  bookedSlots?: number
  totalSlots?: number
}

interface AnomalyRow {
  id: string
  venue_id: string
  alert_type: string
  metric_name: string
  current_value: number | null
  baseline_value: number | null
  change_percent: number | null
  severity: 'info' | 'warning' | 'critical'
  ai_explanation: string | null
  causes: AnomalyCause[] | null
  acknowledged: boolean
  created_at: string
  venues?: { name: string | null } | null
}

type SortKey = 'severity' | 'created_at' | 'metric_name' | 'acknowledged'
type SortDir = 'asc' | 'desc'
type StatusFilter = 'all' | 'open' | 'acknowledged'
type SeverityFilter = 'all' | 'info' | 'warning' | 'critical'

const SEVERITY_RANK: Record<AnomalyRow['severity'], number> = {
  critical: 3,
  warning: 2,
  info: 1,
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatMetric(name: string): string {
  if (!name) return '--'
  return name
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ')
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '--'
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function truncate(s: string | null | undefined, max = 100): string {
  if (!s) return ''
  if (s.length <= max) return s
  return s.slice(0, max - 1).trimEnd() + '...'
}

// ---------------------------------------------------------------------------
// Outer wrapper (gate)
// ---------------------------------------------------------------------------

export default function AnomaliesPage() {
  return (
    <UpgradeGate requiredTier="intelligence" featureName="Anomaly alerts">
      <AnomaliesInner />
    </UpgradeGate>
  )
}

// ---------------------------------------------------------------------------
// Inner page
// ---------------------------------------------------------------------------

function AnomaliesInner() {
  const scope = useScope()

  const [rows, setRows] = useState<AnomalyRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [ackLoadingId, setAckLoadingId] = useState<string | null>(null)

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all')
  const [sortKey, setSortKey] = useState<SortKey>('created_at')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const isCrossVenue = scope.level === 'group' || scope.level === 'company'

  const fetchAlerts = useCallback(async () => {
    if (scope.loading) return
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ scope: scope.level, status: 'all' })
      if (scope.level === 'group' && scope.groupId) {
        qs.set('groupId', scope.groupId)
      }
      const res = await fetch(`/api/intel/anomalies?${qs.toString()}`, {
        credentials: 'include',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.message || body?.error || 'Failed to load anomalies')
      }
      const json = await res.json()
      setRows((json.alerts ?? []) as AnomalyRow[])
    } catch (err) {
      console.error('Anomalies fetch failed:', err)
      setError(err instanceof Error ? err.message : 'Failed to load anomalies')
    } finally {
      setLoading(false)
    }
  }, [scope.loading, scope.level, scope.groupId])

  useEffect(() => {
    fetchAlerts()
  }, [fetchAlerts])

  const acknowledge = useCallback(
    async (alertId: string) => {
      setAckLoadingId(alertId)
      try {
        const res = await fetch('/api/intel/anomalies', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ alertId }),
        })
        if (!res.ok) throw new Error('Failed to acknowledge')
        setRows((prev) =>
          prev.map((r) => (r.id === alertId ? { ...r, acknowledged: true } : r))
        )
      } catch (err) {
        console.error('Acknowledge failed:', err)
      } finally {
        setAckLoadingId(null)
      }
    },
    []
  )

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (statusFilter === 'open' && r.acknowledged) return false
      if (statusFilter === 'acknowledged' && !r.acknowledged) return false
      if (severityFilter !== 'all' && r.severity !== severityFilter) return false
      return true
    })
  }, [rows, statusFilter, severityFilter])

  const sorted = useMemo(() => {
    const out = [...filtered]
    out.sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case 'severity':
          cmp = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
          break
        case 'created_at':
          cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
          break
        case 'metric_name':
          cmp = (a.metric_name || '').localeCompare(b.metric_name || '')
          break
        case 'acknowledged':
          cmp = Number(a.acknowledged) - Number(b.acknowledged)
          break
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
    return out
  }, [filtered, sortKey, sortDir])

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const openCount = rows.filter((r) => !r.acknowledged).length
  const criticalCount = rows.filter(
    (r) => !r.acknowledged && r.severity === 'critical'
  ).length

  const scopeLabel =
    scope.level === 'venue'
      ? scope.venueName || 'this venue'
      : scope.level === 'group'
        ? scope.groupName || 'this group'
        : scope.companyName || 'your portfolio'

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1 flex items-center gap-3">
            <AlertTriangle className="w-7 h-7 text-sage-500" />
            Anomaly Alerts
          </h1>
          <p className="text-sage-600">
            Every unusual pattern Bloom has spotted across {scopeLabel}. Bloom
            checks daily and surfaces anything that deviates from your normal.
          </p>
        </div>
        <button
          onClick={fetchAlerts}
          className="inline-flex items-center gap-2 px-3 py-2 text-sm rounded-lg border border-border bg-surface hover:bg-sage-50 text-sage-700 transition-colors"
        >
          <RefreshCcw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      {/* Rollup strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <RollupCard
          label="Total"
          value={String(rows.length)}
          accent="text-sage-700"
          icon={AlertTriangle}
        />
        <RollupCard
          label="Open"
          value={String(openCount)}
          accent={openCount > 0 ? 'text-amber-600' : 'text-sage-400'}
          icon={Circle}
        />
        <RollupCard
          label="Critical (open)"
          value={String(criticalCount)}
          accent={criticalCount > 0 ? 'text-red-600' : 'text-sage-400'}
          icon={AlertOctagon}
        />
        <RollupCard
          label="Acknowledged"
          value={String(rows.length - openCount)}
          accent="text-emerald-600"
          icon={CheckCircle2}
        />
      </div>

      {/* Filter pills */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-sage-500 uppercase tracking-wider mr-1">
          Status
        </span>
        {(['all', 'open', 'acknowledged'] as StatusFilter[]).map((s) => (
          <FilterPill
            key={s}
            label={s === 'all' ? 'All' : s === 'open' ? 'Open' : 'Acknowledged'}
            active={statusFilter === s}
            onClick={() => setStatusFilter(s)}
          />
        ))}
        <span className="text-xs font-medium text-sage-500 uppercase tracking-wider mx-2 ml-6">
          Severity
        </span>
        {(['all', 'critical', 'warning', 'info'] as SeverityFilter[]).map((s) => (
          <FilterPill
            key={s}
            label={s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
            active={severityFilter === s}
            onClick={() => setSeverityFilter(s)}
          />
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700 flex-1">{error}</p>
          <button
            onClick={fetchAlerts}
            className="text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Table / empty / loading */}
      {loading ? (
        <div className="bg-surface border border-border rounded-xl p-8 shadow-sm">
          <div className="animate-pulse space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-12 bg-sage-50 rounded" />
            ))}
          </div>
        </div>
      ) : sorted.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <div className="w-14 h-14 rounded-full bg-sage-50 flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 className="w-7 h-7 text-sage-400" />
          </div>
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
            No anomalies detected
          </h3>
          <p className="text-sm text-sage-600 max-w-md mx-auto">
            Bloom checks daily. If something unusual happens in your inquiries,
            bookings, or availability, you&apos;ll see it here first.
          </p>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-warm-white">
                  <SortableHeader
                    label="Severity"
                    colKey="severity"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onClick={handleSort}
                  />
                  <SortableHeader
                    label="Date"
                    colKey="created_at"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onClick={handleSort}
                  />
                  <SortableHeader
                    label="Metric / Cause"
                    colKey="metric_name"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onClick={handleSort}
                  />
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">
                    Explanation
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600">
                    Sage Action
                  </th>
                  <SortableHeader
                    label="Status"
                    colKey="acknowledged"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onClick={handleSort}
                  />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sorted.map((row) => {
                  const isOpen = expandedId === row.id
                  const firstCause = row.causes?.[0]
                  const sageAction = firstCause?.action ?? ''
                  return (
                    <React.Fragment key={row.id}>
                      <tr
                        onClick={() => setExpandedId(isOpen ? null : row.id)}
                        className="hover:bg-sage-50/40 transition-colors cursor-pointer"
                      >
                        <td className="px-6 py-4">
                          <SeverityBadge severity={row.severity} />
                        </td>
                        <td className="px-6 py-4 text-sage-700 whitespace-nowrap">
                          {formatDate(row.created_at)}
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex flex-col gap-1">
                            <span className="font-medium text-sage-900">
                              {formatMetric(row.metric_name)}
                            </span>
                            {isCrossVenue && row.venues?.name && (
                              <VenueChip name={row.venues.name} />
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4 text-sage-700 max-w-md">
                          {truncate(row.ai_explanation, 110) || (
                            <span className="text-sage-400">Awaiting explanation.</span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-sage-700 max-w-xs">
                          {sageAction ? (
                            truncate(sageAction, 80)
                          ) : (
                            <span className="text-sage-400">--</span>
                          )}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <StatusBadge acknowledged={row.acknowledged} />
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-sage-50/40">
                          <td colSpan={6} className="px-6 py-5">
                            <div className="space-y-4">
                              {isCrossVenue && row.venues?.name && (
                                <div>
                                  <p className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-1">
                                    Venue
                                  </p>
                                  <p className="text-sm text-sage-900">
                                    {row.venues.name}
                                  </p>
                                </div>
                              )}
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-1">
                                  Explanation
                                </p>
                                <p className="text-sm text-sage-800 leading-relaxed">
                                  {row.ai_explanation ||
                                    'Bloom has not generated an explanation for this alert yet.'}
                                </p>
                              </div>
                              {row.causes && row.causes.length > 0 && (
                                <div>
                                  <p className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-2">
                                    Causes &amp; Actions
                                  </p>
                                  <ul className="space-y-2">
                                    {row.causes.map((c, i) => (
                                      <li
                                        key={i}
                                        className="bg-surface border border-border rounded-lg p-3"
                                      >
                                        {c.cause && (
                                          <p className="text-sm text-sage-900 font-medium mb-1">
                                            {c.cause}
                                            {c.likelihood && (
                                              <span className="ml-2 text-xs font-normal text-sage-500">
                                                ({c.likelihood} likelihood)
                                              </span>
                                            )}
                                          </p>
                                        )}
                                        {c.source === 'availability' && c.monthName && (
                                          <p className="text-xs text-sage-600 mb-1">
                                            {c.monthName}: {c.bookedSlots ?? 0}/{c.totalSlots ?? 0} slots filled
                                            {typeof c.fillRate === 'number'
                                              ? ` (${Math.round(c.fillRate * 100)}%)`
                                              : ''}
                                          </p>
                                        )}
                                        {c.action && (
                                          <p className="text-sm text-sage-700">
                                            <span className="font-medium">Sage suggests:</span>{' '}
                                            {c.action}
                                          </p>
                                        )}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              {!row.acknowledged && (
                                <div className="pt-2">
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      acknowledge(row.id)
                                    }}
                                    disabled={ackLoadingId === row.id}
                                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sage-600 text-white text-sm font-medium hover:bg-sage-700 transition-colors disabled:opacity-60"
                                  >
                                    {ackLoadingId === row.id ? (
                                      <Loader2 className="w-4 h-4 animate-spin" />
                                    ) : (
                                      <CheckCircle2 className="w-4 h-4" />
                                    )}
                                    Acknowledge
                                  </button>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Support components
// ---------------------------------------------------------------------------

function SortableHeader({
  label,
  colKey,
  sortKey,
  sortDir,
  onClick,
}: {
  label: string
  colKey: SortKey
  sortKey: SortKey
  sortDir: SortDir
  onClick: (k: SortKey) => void
}) {
  const icon =
    sortKey !== colKey ? (
      <ArrowUpDown className="w-3 h-3 text-sage-400" />
    ) : sortDir === 'asc' ? (
      <ChevronUp className="w-3 h-3 text-sage-700" />
    ) : (
      <ChevronDown className="w-3 h-3 text-sage-700" />
    )
  return (
    <th
      onClick={() => onClick(colKey)}
      className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-sage-600 cursor-pointer select-none hover:text-sage-900 transition-colors"
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {icon}
      </span>
    </th>
  )
}

function FilterPill({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={
        active
          ? 'px-3 py-1.5 rounded-full text-xs font-semibold bg-sage-600 text-white border border-sage-600 transition-colors'
          : 'px-3 py-1.5 rounded-full text-xs font-medium bg-surface text-sage-700 border border-border hover:bg-sage-50 transition-colors'
      }
    >
      {label}
    </button>
  )
}

function SeverityBadge({ severity }: { severity: AnomalyRow['severity'] }) {
  const config = {
    critical: {
      icon: AlertOctagon,
      cls: 'bg-red-50 text-red-700 border-red-200',
      label: 'Critical',
    },
    warning: {
      icon: AlertTriangle,
      cls: 'bg-amber-50 text-amber-700 border-amber-200',
      label: 'Warning',
    },
    info: {
      icon: Info,
      cls: 'bg-sage-50 text-sage-700 border-sage-200',
      label: 'Info',
    },
  }[severity]
  const Icon = config.icon
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${config.cls}`}
    >
      <Icon className="w-3 h-3" />
      {config.label}
    </span>
  )
}

function StatusBadge({ acknowledged }: { acknowledged: boolean }) {
  return acknowledged ? (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
      <CheckCircle2 className="w-3 h-3" />
      Acknowledged
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-sage-50 text-sage-700 border border-sage-200">
      <Circle className="w-3 h-3" />
      Open
    </span>
  )
}

function VenueChip({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-sage-50 text-sage-600 border border-sage-100 w-fit">
      <Building2 className="w-3 h-3" />
      {name}
    </span>
  )
}

function RollupCard({
  label,
  value,
  accent,
  icon: Icon,
}: {
  label: string
  value: string
  accent: string
  icon: React.ComponentType<{ className?: string }>
}) {
  return (
    <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-3">
        <div className="p-2 rounded-lg bg-sage-50">
          <Icon className={`w-4 h-4 ${accent}`} />
        </div>
        <span className="text-xs font-medium text-sage-500 uppercase tracking-wider">
          {label}
        </span>
      </div>
      <p className={`text-2xl font-bold ${accent} tabular-nums`}>{value}</p>
    </div>
  )
}
