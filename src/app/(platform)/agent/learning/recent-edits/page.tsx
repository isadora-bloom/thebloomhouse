'use client'

/**
 * Bloom House - Wave 26 learning history view.
 *
 * Shows the audit-of-learnings: every insight extracted from operator
 * edits, what kind it was, where it landed, and when the operator saw
 * it. Operator can drill in to see the verbatim sage_text /
 * operator_text excerpts and (if they flagged it wrong) the correction.
 */

import { useEffect, useState } from 'react'
import { BookOpen, Check, AlertCircle, ChevronRight } from 'lucide-react'

interface Insight {
  id: string
  draft_id: string
  venue_id: string
  insight_kind: string
  sage_text: string | null
  operator_text: string | null
  learning_summary: string
  persisted_to: string
  persisted_ref: string | null
  confidence_0_100: number
  operator_acknowledged_at: string | null
  operator_correction: string | null
  created_at: string
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function kindMeta(kind: string): { label: string; bg: string; text: string } {
  switch (kind) {
    case 'voice_rule':
      return { label: 'Voice rule', bg: 'bg-amber-50', text: 'text-amber-700' }
    case 'tone_shift':
      return { label: 'Tone shift', bg: 'bg-amber-50', text: 'text-amber-700' }
    case 'content_addition':
      return { label: 'Content added', bg: 'bg-emerald-50', text: 'text-emerald-700' }
    case 'fact_correction':
      return { label: 'Fact corrected', bg: 'bg-emerald-50', text: 'text-emerald-700' }
    case 'structure_change':
      return { label: 'Structure', bg: 'bg-sage-50', text: 'text-sage-700' }
    case 'formatting_change':
      return { label: 'Formatting', bg: 'bg-sage-50', text: 'text-sage-700' }
    default:
      return { label: kind, bg: 'bg-sage-50', text: 'text-sage-600' }
  }
}

function persistedMeta(persisted: string): { label: string; bg: string; text: string } {
  switch (persisted) {
    case 'voice_preferences':
      return { label: 'Saved to voice preferences', bg: 'bg-amber-50', text: 'text-amber-700' }
    case 'knowledge_captures':
      return { label: 'Saved to venue knowledge', bg: 'bg-emerald-50', text: 'text-emerald-700' }
    case 'draft_edit_insights_only':
      return { label: 'Noted (not persisted)', bg: 'bg-sage-50', text: 'text-sage-600' }
    case 'discarded':
      return { label: 'Discarded (low confidence)', bg: 'bg-red-50', text: 'text-red-600' }
    default:
      return { label: persisted, bg: 'bg-sage-50', text: 'text-sage-600' }
  }
}

export default function RecentLearningsPage() {
  const [insights, setInsights] = useState<Insight[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<string>('')

  useEffect(() => {
    const fetchInsights = async () => {
      setLoading(true)
      try {
        const url = filter
          ? `/api/agent/learning/recent-edits?limit=100&kind=${encodeURIComponent(filter)}`
          : '/api/agent/learning/recent-edits?limit=100'
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const j = await res.json()
        setInsights(j.insights ?? [])
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load insights')
      } finally {
        setLoading(false)
      }
    }
    fetchInsights()
  }, [filter])

  const filters: { key: string; label: string }[] = [
    { key: '', label: 'All' },
    { key: 'voice_rule', label: 'Voice rules' },
    { key: 'tone_shift', label: 'Tone' },
    { key: 'content_addition', label: 'Content' },
    { key: 'fact_correction', label: 'Facts' },
    { key: 'structure_change', label: 'Structure' },
    { key: 'formatting_change', label: 'Formatting' },
    { key: 'other', label: 'Other' },
  ]

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-3 mb-1">
          <BookOpen className="w-6 h-6 text-sage-600" />
          <h1 className="font-heading text-3xl font-bold text-sage-900">
            Recent learnings
          </h1>
        </div>
        <p className="text-sage-600">
          Every time you edit a draft, Sage extracts what it learned and where the lesson landed. Audit the history here. Click any item to see the verbatim excerpts.
        </p>
      </div>

      <div className="flex items-center gap-1 bg-sage-50 rounded-lg p-1 overflow-x-auto">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
              filter === f.key
                ? 'bg-surface text-sage-900 shadow-sm'
                : 'text-sage-600 hover:text-sage-800'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <div className="animate-pulse space-y-3">
                <div className="h-4 w-3/4 bg-sage-100 rounded" />
                <div className="h-3 w-1/2 bg-sage-50 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : insights.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 text-center shadow-sm">
          <BookOpen className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
            No learnings yet
          </h3>
          <p className="text-sm text-sage-600 max-w-md mx-auto">
            When you edit a Sage draft, the platform extracts what changed and saves the learning. Approve an edited draft to start the loop.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {insights.map((ins) => {
            const kind = kindMeta(ins.insight_kind)
            const persisted = persistedMeta(ins.persisted_to)
            const open = expandedId === ins.id
            const wasCorrected = !!ins.operator_correction
            return (
              <li
                key={ins.id}
                className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden"
              >
                <button
                  className="w-full text-left p-5 hover:bg-warm-white transition-colors"
                  onClick={() => setExpandedId(open ? null : ins.id)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap mb-2">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${kind.bg} ${kind.text}`}
                        >
                          {kind.label}
                        </span>
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${persisted.bg} ${persisted.text}`}
                        >
                          {persisted.label}
                        </span>
                        {wasCorrected && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-50 text-red-600">
                            <AlertCircle className="w-3 h-3" />
                            Corrected
                          </span>
                        )}
                        {ins.operator_acknowledged_at && !wasCorrected && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-50 text-emerald-700">
                            <Check className="w-3 h-3" />
                            Seen
                          </span>
                        )}
                        <span className="text-[10px] text-sage-400 ml-auto">
                          {timeAgo(ins.created_at)}
                        </span>
                      </div>
                      <p className="text-sm text-sage-800 leading-relaxed">
                        {ins.learning_summary}
                      </p>
                    </div>
                    <ChevronRight
                      className={`w-4 h-4 text-sage-400 shrink-0 mt-1 transition-transform ${
                        open ? 'rotate-90' : ''
                      }`}
                    />
                  </div>
                </button>
                {open && (
                  <div className="px-5 pb-5 pt-1 border-t border-border bg-warm-white space-y-3">
                    {ins.sage_text && (
                      <div>
                        <p className="text-xs font-medium text-sage-500 mb-1">Sage wrote</p>
                        <p className="text-sm text-sage-700 italic whitespace-pre-wrap leading-relaxed">
                          {ins.sage_text}
                        </p>
                      </div>
                    )}
                    {ins.operator_text && (
                      <div>
                        <p className="text-xs font-medium text-sage-500 mb-1">You changed it to</p>
                        <p className="text-sm text-sage-900 whitespace-pre-wrap leading-relaxed">
                          {ins.operator_text}
                        </p>
                      </div>
                    )}
                    <div className="flex items-center gap-3 pt-1 text-xs text-sage-500">
                      <span>Confidence: {ins.confidence_0_100}%</span>
                      {ins.persisted_ref && (
                        <span className="font-mono">ref: {ins.persisted_ref.slice(0, 8)}</span>
                      )}
                    </div>
                    {ins.operator_correction && (
                      <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2">
                        <p className="text-xs font-medium text-red-700 mb-1">Your correction</p>
                        <p className="text-sm text-red-800">{ins.operator_correction}</p>
                      </div>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
