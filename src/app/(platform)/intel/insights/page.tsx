'use client'

import { useState, useEffect, useCallback } from 'react'
import { InsightCard, type InsightRow } from '@/components/intel/insight-card'
import {
  Lightbulb, Filter, Loader2, ChevronLeft, ChevronRight,
  Zap, Check, XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Filter options
// ---------------------------------------------------------------------------

const TYPE_OPTIONS = [
  { value: '', label: 'All Types' },
  { value: 'correlation', label: 'Correlation' },
  { value: 'anomaly', label: 'Anomaly' },
  { value: 'prediction', label: 'Prediction' },
  { value: 'recommendation', label: 'Recommendation' },
  { value: 'benchmark', label: 'Benchmark' },
  { value: 'trend', label: 'Trend' },
  { value: 'risk', label: 'Risk' },
  { value: 'opportunity', label: 'Opportunity' },
]

const CATEGORY_OPTIONS = [
  { value: '', label: 'All Categories' },
  { value: 'lead_conversion', label: 'Lead Conversion' },
  { value: 'response_time', label: 'Response Time' },
  { value: 'team_performance', label: 'Team Performance' },
  { value: 'pricing', label: 'Pricing' },
  { value: 'seasonal', label: 'Seasonal' },
  { value: 'source_attribution', label: 'Source Attribution' },
  { value: 'couple_behavior', label: 'Couple Behavior' },
  { value: 'capacity', label: 'Capacity' },
  { value: 'competitive', label: 'Competitive' },
  { value: 'weather', label: 'Weather' },
  { value: 'market', label: 'Market' },
]

const PRIORITY_OPTIONS = [
  { value: '', label: 'All Priorities' },
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
]

const STATUS_OPTIONS = [
  { value: '', label: 'Active (New + Seen)' },
  { value: 'acted_on', label: 'Acted On' },
  { value: 'dismissed', label: 'Dismissed' },
]

const PAGE_SIZE = 25

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function InsightsPage() {
  const [insights, setInsights] = useState<InsightRow[]>([])
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)

  // Filters
  const [typeFilter, setTypeFilter] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [priorityFilter, setPriorityFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  // Stats
  const [stats, setStats] = useState({ new_count: 0, acted_on_this_month: 0, dismissed_this_month: 0 })

  const fetchInsights = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('limit', String(PAGE_SIZE))
      params.set('offset', String(page * PAGE_SIZE))
      if (typeFilter) params.set('type', typeFilter)
      if (categoryFilter) params.set('category', categoryFilter)
      if (priorityFilter) params.set('priority', priorityFilter)
      if (statusFilter) params.set('status', statusFilter)

      const res = await fetch(`/api/intel/insights?${params.toString()}`)
      if (!res.ok) return

      const data = await res.json()
      setInsights(data.insights ?? [])
      setTotal(data.total ?? 0)
      setStats(data.stats ?? { new_count: 0, acted_on_this_month: 0, dismissed_this_month: 0 })
    } catch (err) {
      console.error('Failed to fetch insights:', err)
    } finally {
      setLoading(false)
    }
  }, [page, typeFilter, categoryFilter, priorityFilter, statusFilter])

  useEffect(() => {
    fetchInsights()
  }, [fetchInsights])

  function handleStatusChange(id: string, newStatus: string) {
    if (newStatus === 'seen') {
      setInsights((prev) =>
        prev.map((i) =>
          i.id === id ? { ...i, status: 'seen', seen_at: new Date().toISOString() } : i
        )
      )
    } else {
      // Remove from list for acted_on/dismissed
      setInsights((prev) => prev.filter((i) => i.id !== id))
      setTotal((prev) => Math.max(0, prev - 1))
    }
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
          Intelligence Insights
        </h1>
        <p className="text-sage-600">
          Every pattern, anomaly, and recommendation the intelligence engine has detected — ranked by priority and impact. Act on high-value insights to improve your conversion rates, pricing, and operations.
        </p>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-surface border border-border rounded-xl p-4 flex items-center gap-3">
          <div className="bg-sage-50 p-2 rounded-lg">
            <Lightbulb className="w-4 h-4 text-sage-600" />
          </div>
          <div>
            <p className="text-xs text-muted">New Insights</p>
            <p className="text-xl font-bold text-sage-900">{stats.new_count}</p>
          </div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4 flex items-center gap-3">
          <div className="bg-emerald-50 p-2 rounded-lg">
            <Zap className="w-4 h-4 text-emerald-600" />
          </div>
          <div>
            <p className="text-xs text-muted">Acted On (this month)</p>
            <p className="text-xl font-bold text-sage-900">{stats.acted_on_this_month}</p>
          </div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4 flex items-center gap-3">
          <div className="bg-gray-50 p-2 rounded-lg">
            <XCircle className="w-4 h-4 text-gray-500" />
          </div>
          <div>
            <p className="text-xs text-muted">Dismissed (this month)</p>
            <p className="text-xl font-bold text-sage-900">{stats.dismissed_this_month}</p>
          </div>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5 text-xs text-sage-500">
          <Filter className="w-3.5 h-3.5" />
          Filters:
        </div>

        <select
          value={typeFilter}
          onChange={(e) => { setTypeFilter(e.target.value); setPage(0) }}
          className="px-3 py-1.5 text-sm border border-sage-200 rounded-lg bg-surface text-sage-700 focus:outline-none focus:ring-2 focus:ring-sage-300"
        >
          {TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        <select
          value={categoryFilter}
          onChange={(e) => { setCategoryFilter(e.target.value); setPage(0) }}
          className="px-3 py-1.5 text-sm border border-sage-200 rounded-lg bg-surface text-sage-700 focus:outline-none focus:ring-2 focus:ring-sage-300"
        >
          {CATEGORY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        <select
          value={priorityFilter}
          onChange={(e) => { setPriorityFilter(e.target.value); setPage(0) }}
          className="px-3 py-1.5 text-sm border border-sage-200 rounded-lg bg-surface text-sage-700 focus:outline-none focus:ring-2 focus:ring-sage-300"
        >
          {PRIORITY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(0) }}
          className="px-3 py-1.5 text-sm border border-sage-200 rounded-lg bg-surface text-sage-700 focus:outline-none focus:ring-2 focus:ring-sage-300"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        {(typeFilter || categoryFilter || priorityFilter || statusFilter) && (
          <button
            onClick={() => {
              setTypeFilter('')
              setCategoryFilter('')
              setPriorityFilter('')
              setStatusFilter('')
              setPage(0)
            }}
            className="text-xs text-sage-500 hover:text-sage-700 underline"
          >
            Clear all
          </button>
        )}
      </div>

      {/* Insight list */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 text-sage-400 animate-spin" />
        </div>
      ) : insights.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 text-center">
          <Lightbulb className="w-8 h-8 text-sage-300 mx-auto mb-3" />
          <p className="text-sage-600 font-medium">No insights found</p>
          <p className="text-sm text-muted mt-1">
            {statusFilter
              ? 'Try changing the status filter.'
              : 'The intelligence engine will surface patterns as your data grows.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {insights.map((insight) => (
            <InsightCard
              key={insight.id}
              insight={insight}
              onStatusChange={handleStatusChange}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <p className="text-xs text-muted">
            Showing {page * PAGE_SIZE + 1}-{Math.min((page + 1) * PAGE_SIZE, total)} of {total} insights
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className={cn(
                'flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border transition-colors',
                page === 0
                  ? 'border-gray-200 text-gray-300 cursor-not-allowed'
                  : 'border-sage-200 text-sage-600 hover:bg-sage-50'
              )}
            >
              <ChevronLeft className="w-4 h-4" />
              Previous
            </button>
            <span className="text-sm text-sage-600 tabular-nums">
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className={cn(
                'flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border transition-colors',
                page >= totalPages - 1
                  ? 'border-gray-200 text-gray-300 cursor-not-allowed'
                  : 'border-sage-200 text-sage-600 hover:bg-sage-50'
              )}
            >
              Next
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
