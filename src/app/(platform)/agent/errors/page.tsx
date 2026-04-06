'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { createClient } from '@/lib/supabase/client'
import {
  AlertCircle,
  CheckCircle2,
  Search,
  Filter,
  AlertTriangle,
  X,
  Shield,
  TrendingDown,
  Bug,
} from 'lucide-react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ErrorLog {
  id: string
  venue_id: string
  error_type: string
  message: string
  context: Record<string, unknown> | null
  resolved: boolean
  resolved_at: string | null
  resolve_notes: string | null
  created_at: string
}

interface DailyErrorCount {
  date: string
  count: number
}

type StatusFilter = 'all' | 'unresolved' | 'resolved'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

function errorTypeBadge(type: string): { bg: string; text: string } {
  switch (type) {
    case 'api_error':
      return { bg: 'bg-red-50', text: 'text-red-700' }
    case 'email_sync':
      return { bg: 'bg-amber-50', text: 'text-amber-700' }
    case 'ai_generation':
      return { bg: 'bg-purple-50', text: 'text-purple-700' }
    case 'draft_send':
      return { bg: 'bg-blue-50', text: 'text-blue-700' }
    case 'webhook':
      return { bg: 'bg-teal-50', text: 'text-teal-700' }
    case 'auth':
      return { bg: 'bg-rose-50', text: 'text-rose-700' }
    default:
      return { bg: 'bg-sage-50', text: 'text-sage-600' }
  }
}

const inputClasses =
  'w-full border border-border rounded-lg px-3 py-2 text-sage-900 bg-warm-white focus:ring-2 focus:ring-sage-300 focus:border-sage-500 outline-none transition-colors text-sm'

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function TableSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="divide-y divide-border">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="p-4">
            <div className="animate-pulse flex items-center gap-4">
              <div className="h-4 w-24 bg-sage-100 rounded" />
              <div className="h-4 w-16 bg-sage-100 rounded-full" />
              <div className="h-4 w-64 bg-sage-50 rounded" />
              <div className="h-4 w-16 bg-sage-100 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Resolve Modal
// ---------------------------------------------------------------------------

function ResolveModal({
  errorLog,
  onClose,
  onResolve,
}: {
  errorLog: ErrorLog
  onClose: () => void
  onResolve: (errorId: string, notes: string) => Promise<void>
}) {
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    await onResolve(errorLog.id, notes)
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-surface rounded-xl shadow-xl border border-border w-full max-w-lg">
        <div className="flex items-center justify-between p-5 border-b border-border">
          <h2 className="font-heading text-lg font-semibold text-sage-900">
            Resolve Error
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-sage-400 hover:text-sage-600 hover:bg-sage-50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">
              Error
            </label>
            <div className="text-sm text-sage-600 bg-sage-50 rounded-lg p-3">
              <p className="font-medium text-sage-800 mb-1">{errorLog.error_type}</p>
              <p className="text-sage-600">{errorLog.message}</p>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">
              Resolution Notes
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className={inputClasses}
              placeholder="Describe what was done to resolve this error..."
            />
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-sage-600 hover:text-sage-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2.5 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <CheckCircle2 className="w-4 h-4" />
              {saving ? 'Saving...' : 'Mark Resolved'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function ErrorsPage() {
  const VENUE_ID = useVenueId()
  const [errors, setErrors] = useState<ErrorLog[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [resolvingError, setResolvingError] = useState<ErrorLog | null>(null)
  const [dailyCounts, setDailyCounts] = useState<DailyErrorCount[]>([])

  const supabase = createClient()

  // ---- Fetch errors ----
  const fetchErrors = useCallback(async () => {
    try {
      const { data, error: err } = await supabase
        .from('error_logs')
        .select('*')
        .eq('venue_id', VENUE_ID)
        .order('created_at', { ascending: false })
        .limit(200)

      if (err) throw err
      setErrors(data ?? [])

      // Compute daily counts for last 30 days
      const thirtyDaysAgo = new Date()
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

      const dailyMap: Record<string, number> = {}
      for (const e of data ?? []) {
        const d = new Date(e.created_at)
        if (d < thirtyDaysAgo) continue
        const key = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        dailyMap[key] = (dailyMap[key] || 0) + 1
      }

      setDailyCounts(
        Object.entries(dailyMap).map(([date, count]) => ({ date, count }))
      )

      setFetchError(null)
    } catch (err) {
      console.error('Failed to fetch errors:', err)
      setFetchError('Failed to load error logs')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchErrors()
  }, [fetchErrors])

  // ---- Resolve handler ----
  const handleResolve = async (errorId: string, notes: string) => {
    try {
      const { error: updateError } = await supabase
        .from('error_logs')
        .update({
          resolved: true,
          resolved_at: new Date().toISOString(),
          resolve_notes: notes || null,
        })
        .eq('id', errorId)

      if (updateError) throw updateError
      setResolvingError(null)
      await fetchErrors()
    } catch (err) {
      console.error('Failed to resolve error:', err)
    }
  }

  // ---- Filtering ----
  const filteredErrors = useMemo(() => {
    let result = [...errors]

    if (statusFilter === 'unresolved') {
      result = result.filter((e) => !e.resolved)
    } else if (statusFilter === 'resolved') {
      result = result.filter((e) => e.resolved)
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (e) =>
          e.error_type.toLowerCase().includes(q) ||
          e.message.toLowerCase().includes(q)
      )
    }

    return result
  }, [errors, statusFilter, searchQuery])

  // ---- Stats ----
  const unresolvedCount = errors.filter((e) => !e.resolved).length
  const resolvedCount = errors.filter((e) => e.resolved).length

  const errorTypeBreakdown = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const e of errors.filter((e) => !e.resolved)) {
      counts[e.error_type] = (counts[e.error_type] || 0) + 1
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
  }, [errors])

  // System health based on recent error rate
  const recentErrors = errors.filter((e) => {
    const d = new Date(e.created_at)
    return Date.now() - d.getTime() < 24 * 60 * 60 * 1000 && !e.resolved
  }).length

  const healthStatus =
    recentErrors === 0
      ? { label: 'Healthy', bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200' }
      : recentErrors <= 3
        ? { label: 'Warning', bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200' }
        : { label: 'Issues Detected', bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200' }

  const tabs: { key: StatusFilter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: errors.length },
    { key: 'unresolved', label: 'Unresolved', count: unresolvedCount },
    { key: 'resolved', label: 'Resolved', count: resolvedCount },
  ]

  return (
    <div className="space-y-6">
      {/* ---- Header ---- */}
      <div>
        <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
          Error Monitoring
        </h1>
        <p className="text-sage-600">
          Monitor failed email syncs, AI errors, and pipeline issues in one place. Resolve errors to keep your agent running smoothly — most issues fix themselves, but flagged ones need your attention.
        </p>
      </div>

      {/* ---- Fetch Error ---- */}
      {fetchError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{fetchError}</p>
          <button
            onClick={() => {
              setFetchError(null)
              setLoading(true)
              fetchErrors()
            }}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* ---- Stats Row ---- */}
      {!loading && (
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          {/* System Health */}
          <div className={`${healthStatus.bg} border ${healthStatus.border} rounded-xl p-5 shadow-sm`}>
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-surface flex items-center justify-center">
                <Shield className={`w-5 h-5 ${healthStatus.text}`} />
              </div>
              <div>
                <p className={`text-lg font-bold ${healthStatus.text}`}>
                  {healthStatus.label}
                </p>
                <p className="text-xs text-sage-500">System Health</p>
              </div>
            </div>
          </div>

          <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-red-50 flex items-center justify-center">
                <AlertCircle className="w-5 h-5 text-red-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-sage-900">{unresolvedCount}</p>
                <p className="text-xs text-sage-500">Unresolved</p>
              </div>
            </div>
          </div>

          <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-emerald-50 flex items-center justify-center">
                <CheckCircle2 className="w-5 h-5 text-emerald-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-sage-900">{resolvedCount}</p>
                <p className="text-xs text-sage-500">Resolved</p>
              </div>
            </div>
          </div>

          <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-sage-50 flex items-center justify-center">
                <Bug className="w-5 h-5 text-sage-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-sage-900 mb-1">Top Types</p>
                <div className="flex flex-wrap gap-1">
                  {errorTypeBreakdown.length === 0 && (
                    <span className="text-xs text-sage-400">None</span>
                  )}
                  {errorTypeBreakdown.map(([type, count]) => (
                    <span
                      key={type}
                      className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-sage-100 text-sage-700"
                    >
                      {type} ({count})
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ---- Error Rate Chart ---- */}
      {!loading && dailyCounts.length > 0 && (
        <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
          <h2 className="font-heading text-base font-semibold text-sage-900 mb-4">
            Errors Per Day (Last 30 Days)
          </h2>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={dailyCounts}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E8E6E1" />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#7D8471' }} />
              <YAxis tick={{ fontSize: 11, fill: '#7D8471' }} allowDecimals={false} />
              <Tooltip
                contentStyle={{
                  borderRadius: '8px',
                  border: '1px solid #E8E6E1',
                  fontSize: '12px',
                }}
              />
              <Bar dataKey="count" fill="#EF4444" radius={[4, 4, 0, 0]} barSize={16} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ---- Filters ---- */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="flex items-center gap-1 bg-sage-50 rounded-lg p-1">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setStatusFilter(tab.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                statusFilter === tab.key
                  ? 'bg-surface text-sage-900 shadow-sm'
                  : 'text-sage-600 hover:text-sage-800'
              }`}
            >
              {tab.label}
              <span
                className={`text-xs px-1.5 py-0.5 rounded-full ${
                  statusFilter === tab.key
                    ? 'bg-sage-100 text-sage-700'
                    : 'bg-sage-100/50 text-sage-500'
                }`}
              >
                {tab.count}
              </span>
            </button>
          ))}
        </div>

        <div className="relative sm:ml-auto">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sage-400" />
          <input
            type="text"
            placeholder="Search errors..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 pr-4 py-2 text-sm border border-sage-200 rounded-lg text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 w-full sm:w-64 bg-warm-white"
          />
        </div>
      </div>

      {/* ---- Error Table ---- */}
      {loading ? (
        <TableSkeleton />
      ) : filteredErrors.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <AlertCircle className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
            {searchQuery
              ? 'No matching errors'
              : statusFilter !== 'all'
                ? `No ${statusFilter} errors`
                : 'No errors logged'}
          </h3>
          <p className="text-sm text-sage-600 max-w-md mx-auto">
            {searchQuery
              ? `No errors match "${searchQuery}".`
              : 'System errors from the Agent pipeline will appear here for monitoring and resolution.'}
          </p>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                      Timestamp
                    </span>
                  </th>
                  <th className="text-left px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                      Type
                    </span>
                  </th>
                  <th className="text-left px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                      Message
                    </span>
                  </th>
                  <th className="text-left px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                      Status
                    </span>
                  </th>
                  <th className="text-right px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                      Action
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredErrors.map((err) => {
                  const badge = errorTypeBadge(err.error_type)
                  return (
                    <tr
                      key={err.id}
                      className="hover:bg-sage-50/50 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <span className="text-sm text-sage-600 whitespace-nowrap">
                          {timeAgo(err.created_at)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium whitespace-nowrap ${badge.bg} ${badge.text}`}
                        >
                          {err.error_type.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="px-4 py-3 max-w-md">
                        <p className="text-sm text-sage-900 truncate">
                          {err.message}
                        </p>
                        {err.resolve_notes && (
                          <p className="text-xs text-sage-500 truncate mt-0.5">
                            Resolution: {err.resolve_notes}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {err.resolved ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-50 text-emerald-700">
                            Resolved
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-red-50 text-red-700">
                            Unresolved
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {!err.resolved && (
                          <button
                            onClick={() => setResolvingError(err)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-sage-700 bg-sage-100 hover:bg-sage-200 rounded-lg transition-colors"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Resolve
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---- Resolve Modal ---- */}
      {resolvingError && (
        <ResolveModal
          errorLog={resolvingError}
          onClose={() => setResolvingError(null)}
          onResolve={handleResolve}
        />
      )}
    </div>
  )
}
