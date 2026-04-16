'use client'

import { useState } from 'react'
import {
  TrendingUp, AlertTriangle, Target, Lightbulb, BarChart3,
  Activity, ShieldAlert, Sparkles,
  ChevronDown, ChevronUp, Check, Zap, X,
  Loader2,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InsightRow {
  id: string
  venue_id: string
  insight_type: string
  category: string
  title: string
  body: string
  action: string | null
  priority: 'critical' | 'high' | 'medium' | 'low'
  confidence: number
  impact_score: number | null
  data_points: Record<string, unknown>
  compared_to: string | null
  status: string
  seen_at: string | null
  acted_on_at: string | null
  dismissed_at: string | null
  expires_at: string | null
  created_at: string
  updated_at: string
}

interface InsightCardProps {
  insight: InsightRow
  onStatusChange?: (id: string, newStatus: string) => void
  compact?: boolean
}

// ---------------------------------------------------------------------------
// Priority styles
// ---------------------------------------------------------------------------

const PRIORITY_DOT: Record<string, string> = {
  critical: 'bg-red-500',
  high: 'bg-amber-500',
  medium: 'bg-sage-500',
  low: 'bg-gray-400',
}

const PRIORITY_RING: Record<string, string> = {
  critical: 'ring-red-200',
  high: 'ring-amber-200',
  medium: 'ring-sage-200',
  low: 'ring-gray-200',
}

// ---------------------------------------------------------------------------
// Insight type icons + badge styles
// ---------------------------------------------------------------------------

const TYPE_CONFIG: Record<string, { icon: typeof TrendingUp; label: string; bg: string; text: string }> = {
  correlation:     { icon: TrendingUp,    label: 'Correlation',     bg: 'bg-blue-50',    text: 'text-blue-700' },
  anomaly:         { icon: AlertTriangle, label: 'Anomaly',         bg: 'bg-amber-50',   text: 'text-amber-700' },
  prediction:      { icon: Target,        label: 'Prediction',      bg: 'bg-purple-50',  text: 'text-purple-700' },
  recommendation:  { icon: Lightbulb,     label: 'Recommendation',  bg: 'bg-emerald-50', text: 'text-emerald-700' },
  benchmark:       { icon: BarChart3,     label: 'Benchmark',       bg: 'bg-teal-50',    text: 'text-teal-700' },
  trend:           { icon: Activity,      label: 'Trend',           bg: 'bg-indigo-50',  text: 'text-indigo-700' },
  risk:            { icon: ShieldAlert,   label: 'Risk',            bg: 'bg-red-50',     text: 'text-red-700' },
  opportunity:     { icon: Sparkles,      label: 'Opportunity',     bg: 'bg-gold-50',    text: 'text-gold-700' },
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function InsightCard({ insight, onStatusChange, compact = false }: InsightCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [showData, setShowData] = useState(false)
  const [showNoteModal, setShowNoteModal] = useState(false)
  const [actionNote, setActionNote] = useState('')
  const [updating, setUpdating] = useState<string | null>(null)

  const typeConfig = TYPE_CONFIG[insight.insight_type] ?? TYPE_CONFIG.recommendation
  const TypeIcon = typeConfig.icon

  async function updateStatus(status: string, note?: string) {
    setUpdating(status)
    try {
      const res = await fetch(`/api/intel/insights/${insight.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, note }),
      })
      if (res.ok) {
        onStatusChange?.(insight.id, status)
      }
    } catch (err) {
      console.error('Failed to update insight:', err)
    } finally {
      setUpdating(null)
      setShowNoteModal(false)
      setActionNote('')
    }
  }

  function handleActOnThis() {
    setShowNoteModal(true)
  }

  function handleSubmitAction() {
    updateStatus('acted_on', actionNote || undefined)
  }

  // Format data points for display
  const dataEntries = Object.entries(insight.data_points ?? {}).filter(
    ([key]) => key !== 'action_note' && key !== 'action_taken_by'
  )

  return (
    <div
      className={cn(
        'relative bg-surface border rounded-xl overflow-hidden transition-all',
        insight.status === 'new' ? 'border-sage-300 shadow-sm' : 'border-border',
        compact ? 'p-3' : 'p-4'
      )}
    >
      {/* Top row: priority dot + type badge + title */}
      <div className="flex items-start gap-3">
        {/* Priority indicator */}
        <div className={cn(
          'w-2.5 h-2.5 rounded-full shrink-0 mt-1.5 ring-2',
          PRIORITY_DOT[insight.priority] ?? 'bg-gray-400',
          PRIORITY_RING[insight.priority] ?? 'ring-gray-200',
        )} />

        <div className="flex-1 min-w-0">
          {/* Type badge + confidence */}
          <div className="flex items-center gap-2 mb-1">
            <span className={cn(
              'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider',
              typeConfig.bg, typeConfig.text,
            )}>
              <TypeIcon className="w-3 h-3" />
              {typeConfig.label}
            </span>
            {insight.confidence >= 0.7 && (
              <span className="text-[10px] text-sage-400 font-medium">
                {Math.round(insight.confidence * 100)}% confidence
              </span>
            )}
            {insight.status === 'new' && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-sage-100 text-sage-600">
                NEW
              </span>
            )}
          </div>

          {/* Title */}
          <h3 className={cn(
            'font-medium text-sage-900 leading-snug',
            compact ? 'text-sm' : 'text-sm'
          )}>
            {insight.title}
          </h3>

          {/* Body — truncated unless expanded */}
          <p className={cn(
            'text-sm text-sage-600 mt-1 leading-relaxed',
            !expanded && 'line-clamp-2'
          )}>
            {insight.body}
          </p>

          {insight.body.length > 140 && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-xs text-sage-500 hover:text-sage-700 mt-0.5 flex items-center gap-0.5"
            >
              {expanded ? (
                <>Show less <ChevronUp className="w-3 h-3" /></>
              ) : (
                <>Read more <ChevronDown className="w-3 h-3" /></>
              )}
            </button>
          )}

          {/* Action recommendation */}
          {insight.action && (
            <div className="mt-2 px-3 py-2 bg-sage-50 border border-sage-100 rounded-lg">
              <p className="text-xs font-semibold text-sage-700 uppercase tracking-wider mb-0.5">
                Recommended Action
              </p>
              <p className="text-sm text-sage-700">{insight.action}</p>
            </div>
          )}

          {/* Data points (collapsible) */}
          {dataEntries.length > 0 && (
            <div className="mt-2">
              <button
                onClick={() => setShowData(!showData)}
                className="text-xs text-sage-500 hover:text-sage-700 flex items-center gap-1"
              >
                {showData ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                {showData ? 'Hide data' : 'Show data'}
              </button>
              {showData && (
                <div className="mt-1.5 grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                  {dataEntries.map(([key, value]) => (
                    <div key={key} className="bg-gray-50 rounded-md px-2 py-1">
                      <p className="text-[10px] text-muted truncate">{key.replace(/_/g, ' ')}</p>
                      <p className="text-xs font-mono font-medium text-sage-800">
                        {typeof value === 'number'
                          ? value % 1 !== 0
                            ? value < 1
                              ? `${(value * 100).toFixed(0)}%`
                              : value.toFixed(2)
                            : value.toLocaleString()
                          : String(value)}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Action buttons */}
      {!compact && (
        <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border">
          <button
            onClick={() => updateStatus('seen')}
            disabled={updating !== null || insight.status === 'seen'}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
              insight.status === 'seen'
                ? 'bg-sage-100 text-sage-500 cursor-default'
                : 'text-sage-600 hover:bg-sage-50 border border-sage-200 hover:border-sage-300'
            )}
          >
            {updating === 'seen' ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Check className="w-3 h-3" />
            )}
            {insight.status === 'seen' ? 'Seen' : 'Got it'}
          </button>

          <button
            onClick={handleActOnThis}
            disabled={updating !== null}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-sage-500 text-white hover:bg-sage-600 transition-colors disabled:opacity-50"
          >
            {updating === 'acted_on' ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Zap className="w-3 h-3" />
            )}
            Act on this
          </button>

          <button
            onClick={() => updateStatus('dismissed')}
            disabled={updating !== null}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-gray-500 hover:bg-gray-50 border border-gray-200 hover:border-gray-300 transition-colors disabled:opacity-50"
          >
            {updating === 'dismissed' ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <X className="w-3 h-3" />
            )}
            Dismiss
          </button>

          {insight.compared_to && (
            <span className="ml-auto text-[10px] text-muted">
              vs. {insight.compared_to.replace(/_/g, ' ')}
            </span>
          )}
        </div>
      )}

      {/* Action note modal */}
      {showNoteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30">
          <div className="bg-surface rounded-xl border border-border shadow-xl max-w-md w-full p-5">
            <h3 className="font-heading text-base font-semibold text-sage-900 mb-1">
              Act on this insight
            </h3>
            <p className="text-sm text-sage-600 mb-3">
              {insight.title}
            </p>
            <label className="block text-xs font-medium text-sage-700 mb-1">
              What action are you taking? (optional)
            </label>
            <textarea
              value={actionNote}
              onChange={(e) => setActionNote(e.target.value)}
              placeholder="e.g., Turned on auto-send for high-confidence drafts..."
              className="w-full px-3 py-2 text-sm border border-sage-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-sage-300 resize-none"
              rows={3}
            />
            <div className="flex items-center gap-2 mt-3">
              <button
                onClick={handleSubmitAction}
                disabled={updating !== null}
                className="flex items-center gap-1.5 px-4 py-2 bg-sage-500 text-white text-sm font-medium rounded-lg hover:bg-sage-600 transition-colors disabled:opacity-50"
              >
                {updating === 'acted_on' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Check className="w-3.5 h-3.5" />
                )}
                Mark as acted on
              </button>
              <button
                onClick={() => { setShowNoteModal(false); setActionNote('') }}
                className="px-4 py-2 text-sm text-sage-600 hover:bg-sage-50 rounded-lg transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
