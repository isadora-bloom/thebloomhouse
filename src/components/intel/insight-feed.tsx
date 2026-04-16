'use client'

import { useEffect, useState, useCallback } from 'react'
import { InsightCard, type InsightRow } from './insight-card'
import { Lightbulb, Loader2 } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface InsightFeedProps {
  /** Venue scope — passed from useScope(). If omitted, relies on server auth. */
  venueId?: string
  /** Max insights to display */
  limit?: number
  /** Filter by insight_type */
  type?: string
  /** Filter by category */
  category?: string
  /** Filter by priority */
  priority?: string
  /** Show "View all" link */
  showViewAll?: boolean
  /** Additional class names */
  className?: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function InsightFeed({
  limit = 5,
  type,
  category,
  priority,
  showViewAll = true,
  className,
}: InsightFeedProps) {
  const [insights, setInsights] = useState<InsightRow[]>([])
  const [loading, setLoading] = useState(true)
  const [newCount, setNewCount] = useState(0)

  const fetchInsights = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      params.set('limit', String(limit))
      if (type) params.set('type', type)
      if (category) params.set('category', category)
      if (priority) params.set('priority', priority)

      const res = await fetch(`/api/intel/insights?${params.toString()}`)
      if (!res.ok) return

      const data = await res.json()
      setInsights(data.insights ?? [])
      setNewCount(data.stats?.new_count ?? 0)
    } catch (err) {
      console.error('Failed to fetch insights:', err)
    } finally {
      setLoading(false)
    }
  }, [limit, type, category, priority])

  useEffect(() => {
    fetchInsights()
  }, [fetchInsights])

  function handleStatusChange(id: string, newStatus: string) {
    setInsights((prev) => prev.filter((i) => {
      if (i.id !== id) return true
      // Remove dismissed/acted_on from the active feed
      return newStatus === 'seen'
    }).map((i) => {
      if (i.id === id && newStatus === 'seen') {
        return { ...i, status: 'seen', seen_at: new Date().toISOString() }
      }
      return i
    }))
    // Update the new count
    if (newStatus !== 'seen') {
      setNewCount((prev) => Math.max(0, prev - 1))
    }
  }

  if (loading) {
    return (
      <div className={cn('bg-surface border border-border rounded-xl p-6', className)}>
        <div className="flex items-center gap-2 mb-4">
          <Lightbulb className="w-4 h-4 text-sage-500" />
          <h2 className="font-heading text-base font-semibold text-sage-900">
            Intelligence Insights
          </h2>
        </div>
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 text-sage-400 animate-spin" />
        </div>
      </div>
    )
  }

  if (insights.length === 0) {
    return null // Don't render empty feed
  }

  return (
    <div className={cn('bg-surface border border-border rounded-xl overflow-hidden', className)}>
      {/* Header */}
      <div className="px-6 py-4 border-b border-border bg-sage-50/30 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Lightbulb className="w-4 h-4 text-sage-500" />
          <h2 className="font-heading text-base font-semibold text-sage-900">
            Intelligence Insights
          </h2>
          {newCount > 0 && (
            <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-sage-500 text-white">
              {newCount} new
            </span>
          )}
        </div>
        {showViewAll && (
          <Link
            href="/intel/insights"
            className="text-xs text-sage-600 hover:text-sage-800 font-medium transition-colors"
          >
            View all
          </Link>
        )}
      </div>

      {/* Cards */}
      <div className="p-4 space-y-3">
        {insights.map((insight) => (
          <InsightCard
            key={insight.id}
            insight={insight}
            onStatusChange={handleStatusChange}
          />
        ))}
      </div>
    </div>
  )
}
