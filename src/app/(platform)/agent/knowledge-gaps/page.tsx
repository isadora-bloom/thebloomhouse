'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { createClient } from '@/lib/supabase/client'
import {
  HelpCircle,
  CheckCircle2,
  Search,
  Filter,
  AlertTriangle,
  TrendingUp,
  FolderOpen,
  X,
  Plus,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface KnowledgeGap {
  id: string
  venue_id: string
  question: string
  category: string | null
  frequency: number
  status: 'open' | 'resolved'
  resolution: string | null
  resolved_at: string | null
  created_at: string
  updated_at: string
}

type StatusFilter = 'all' | 'open' | 'resolved'

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

function categoryBadge(category: string | null): { bg: string; text: string; label: string } {
  switch (category) {
    case 'pricing':
      return { bg: 'bg-emerald-50', text: 'text-emerald-700', label: 'Pricing' }
    case 'availability':
      return { bg: 'bg-blue-50', text: 'text-blue-700', label: 'Availability' }
    case 'logistics':
      return { bg: 'bg-amber-50', text: 'text-amber-700', label: 'Logistics' }
    case 'policy':
      return { bg: 'bg-purple-50', text: 'text-purple-700', label: 'Policy' }
    case 'vendor':
      return { bg: 'bg-rose-50', text: 'text-rose-700', label: 'Vendor' }
    case 'ceremony':
      return { bg: 'bg-teal-50', text: 'text-teal-700', label: 'Ceremony' }
    case 'catering':
      return { bg: 'bg-orange-50', text: 'text-orange-700', label: 'Catering' }
    default:
      return { bg: 'bg-sage-50', text: 'text-sage-600', label: category || 'Uncategorized' }
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
              <div className="h-4 w-64 bg-sage-100 rounded" />
              <div className="h-4 w-20 bg-sage-100 rounded-full" />
              <div className="h-4 w-10 bg-sage-100 rounded" />
              <div className="h-4 w-16 bg-sage-50 rounded" />
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
  gap,
  onClose,
  onResolve,
}: {
  gap: KnowledgeGap
  onClose: () => void
  onResolve: (gapId: string, resolution: string, addToKB: boolean) => Promise<void>
}) {
  const [resolution, setResolution] = useState('')
  const [addToKB, setAddToKB] = useState(true)
  const [saving, setSaving] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!resolution.trim()) return
    setSaving(true)
    await onResolve(gap.id, resolution, addToKB)
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-surface rounded-xl shadow-xl border border-border w-full max-w-lg">
        <div className="flex items-center justify-between p-5 border-b border-border">
          <h2 className="font-heading text-lg font-semibold text-sage-900">
            Resolve Knowledge Gap
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
              Question
            </label>
            <p className="text-sm text-sage-600 bg-sage-50 rounded-lg p-3">
              {gap.question}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">
              Resolution / Answer
            </label>
            <textarea
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              rows={4}
              className={inputClasses}
              placeholder="Provide the answer to this question..."
            />
          </div>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={addToKB}
              onChange={(e) => setAddToKB(e.target.checked)}
              className="w-4 h-4 rounded border-sage-300 text-sage-600 focus:ring-sage-500"
            />
            <span className="text-sm text-sage-700">
              Also add this answer to the Knowledge Base
            </span>
          </label>

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
              disabled={saving || !resolution.trim()}
              className="flex items-center gap-2 px-4 py-2.5 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <CheckCircle2 className="w-4 h-4" />
              {saving ? 'Saving...' : 'Resolve Gap'}
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

export default function KnowledgeGapsPage() {
  const VENUE_ID = useVenueId()
  const [gaps, setGaps] = useState<KnowledgeGap[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [resolvingGap, setResolvingGap] = useState<KnowledgeGap | null>(null)

  const supabase = createClient()

  // ---- Fetch gaps ----
  const fetchGaps = useCallback(async () => {
    try {
      const { data, error: fetchError } = await supabase
        .from('knowledge_gaps')
        .select('*')
        .eq('venue_id', VENUE_ID)
        .order('frequency', { ascending: false })

      if (fetchError) throw fetchError
      setGaps(data ?? [])
      setError(null)
    } catch (err) {
      console.error('Failed to fetch knowledge gaps:', err)
      setError('Failed to load knowledge gaps')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchGaps()
  }, [fetchGaps])

  // ---- Resolve handler ----
  const handleResolve = async (gapId: string, resolution: string, addToKB: boolean) => {
    try {
      const { error: updateError } = await supabase
        .from('knowledge_gaps')
        .update({
          status: 'resolved',
          resolution,
          resolved_at: new Date().toISOString(),
        })
        .eq('id', gapId)

      if (updateError) throw updateError

      // Optionally add to knowledge base
      if (addToKB) {
        const gap = gaps.find((g) => g.id === gapId)
        if (gap) {
          await supabase.from('knowledge_base').insert({
            venue_id: VENUE_ID,
            question: gap.question,
            answer: resolution,
            category: gap.category || 'general',
            source: 'knowledge_gap_resolution',
          })
        }
      }

      setResolvingGap(null)
      await fetchGaps()
    } catch (err) {
      console.error('Failed to resolve gap:', err)
    }
  }

  // ---- Compute categories ----
  const categories = useMemo(() => {
    const cats = new Set<string>()
    for (const g of gaps) {
      if (g.category) cats.add(g.category)
    }
    return Array.from(cats).sort()
  }, [gaps])

  // ---- Filtering ----
  const filteredGaps = useMemo(() => {
    let result = [...gaps]

    if (statusFilter !== 'all') {
      result = result.filter((g) => g.status === statusFilter)
    }

    if (categoryFilter !== 'all') {
      result = result.filter((g) => g.category === categoryFilter)
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (g) =>
          g.question.toLowerCase().includes(q) ||
          (g.resolution?.toLowerCase().includes(q) ?? false)
      )
    }

    return result
  }, [gaps, statusFilter, categoryFilter, searchQuery])

  // ---- Stats ----
  const openGaps = gaps.filter((g) => g.status === 'open')
  const topCategories = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const g of openGaps) {
      const cat = g.category || 'uncategorized'
      counts[cat] = (counts[cat] || 0) + 1
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
  }, [openGaps])

  const tabs: { key: StatusFilter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: gaps.length },
    { key: 'open', label: 'Open', count: openGaps.length },
    { key: 'resolved', label: 'Resolved', count: gaps.filter((g) => g.status === 'resolved').length },
  ]

  return (
    <div className="space-y-6">
      {/* ---- Header ---- */}
      <div>
        <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
          Knowledge Gaps
        </h1>
        <p className="text-sage-600">
          Questions that Sage couldn&apos;t confidently answer. Resolve each gap by adding the correct answer — it gets saved to your Knowledge Base so Sage never misses it again.
        </p>
      </div>

      {/* ---- Error ---- */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={() => {
              setError(null)
              setLoading(true)
              fetchGaps()
            }}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* ---- Stats Cards ---- */}
      {!loading && gaps.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-9 h-9 rounded-lg bg-amber-50 flex items-center justify-center">
                <HelpCircle className="w-5 h-5 text-amber-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-sage-900">{openGaps.length}</p>
                <p className="text-xs text-sage-500">Open Gaps</p>
              </div>
            </div>
          </div>

          <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-9 h-9 rounded-lg bg-teal-50 flex items-center justify-center">
                <TrendingUp className="w-5 h-5 text-teal-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-sage-900">
                  {openGaps.length > 0 ? openGaps[0].frequency : 0}
                </p>
                <p className="text-xs text-sage-500">Most Asked (times)</p>
              </div>
            </div>
          </div>

          <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-9 h-9 rounded-lg bg-sage-50 flex items-center justify-center">
                <FolderOpen className="w-5 h-5 text-sage-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-sage-900 mb-1">Top Categories</p>
                <div className="flex flex-wrap gap-1">
                  {topCategories.length === 0 && (
                    <span className="text-xs text-sage-400">None yet</span>
                  )}
                  {topCategories.map(([cat, count]) => (
                    <span
                      key={cat}
                      className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-sage-100 text-sage-700"
                    >
                      {cat} ({count})
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
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

        {/* Category filter */}
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-sage-400" />
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="text-sm border border-sage-200 rounded-lg px-3 py-1.5 text-sage-700 bg-warm-white focus:outline-none focus:ring-2 focus:ring-sage-300"
          >
            <option value="all">All Categories</option>
            {categories.map((cat) => (
              <option key={cat} value={cat}>
                {cat.charAt(0).toUpperCase() + cat.slice(1)}
              </option>
            ))}
          </select>
        </div>

        {/* Search */}
        <div className="relative sm:ml-auto">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sage-400" />
          <input
            type="text"
            placeholder="Search gaps..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 pr-4 py-2 text-sm border border-sage-200 rounded-lg text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 w-full sm:w-64 bg-warm-white"
          />
        </div>
      </div>

      {/* ---- Gaps Table ---- */}
      {loading ? (
        <TableSkeleton />
      ) : filteredGaps.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <HelpCircle className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
            {searchQuery
              ? 'No matching gaps'
              : statusFilter !== 'all'
                ? `No ${statusFilter} knowledge gaps`
                : 'No knowledge gaps recorded'}
          </h3>
          <p className="text-sm text-sage-600 max-w-md mx-auto">
            {searchQuery
              ? `No gaps match "${searchQuery}".`
              : 'When Sage encounters questions it cannot answer, they appear here for resolution.'}
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
                      Question
                    </span>
                  </th>
                  <th className="text-left px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                      Category
                    </span>
                  </th>
                  <th className="text-left px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                      Times Asked
                    </span>
                  </th>
                  <th className="text-left px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                      Status
                    </span>
                  </th>
                  <th className="text-left px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                      First Seen
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
                {filteredGaps.map((gap) => {
                  const cat = categoryBadge(gap.category)
                  return (
                    <tr
                      key={gap.id}
                      className="hover:bg-sage-50/50 transition-colors"
                    >
                      <td className="px-4 py-3 max-w-md">
                        <p className="text-sm font-medium text-sage-900 truncate">
                          {gap.question}
                        </p>
                        {gap.resolution && (
                          <p className="text-xs text-sage-500 truncate mt-0.5">
                            Resolution: {gap.resolution}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${cat.bg} ${cat.text}`}
                        >
                          {cat.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-semibold text-sage-900 tabular-nums">
                            {gap.frequency}
                          </span>
                          {gap.frequency >= 5 && (
                            <TrendingUp className="w-3.5 h-3.5 text-amber-500" />
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {gap.status === 'open' ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-700">
                            Open
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-50 text-emerald-700">
                            Resolved
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-sm text-sage-600">
                          {timeAgo(gap.created_at)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {gap.status === 'open' && (
                          <button
                            onClick={() => setResolvingGap(gap)}
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
      {resolvingGap && (
        <ResolveModal
          gap={resolvingGap}
          onClose={() => setResolvingGap(null)}
          onResolve={handleResolve}
        />
      )}
    </div>
  )
}
