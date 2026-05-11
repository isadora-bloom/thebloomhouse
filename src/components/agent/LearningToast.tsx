'use client'

/**
 * Bloom House - Wave 26 learning toast.
 *
 * Shown right after an operator edits + approves a draft. Lists what
 * Sage learned and where it landed, with deep-links and a "correct
 * this" affordance per insight. Operator must dismiss explicitly so
 * the audit stamp (operator_acknowledged_at) records that the
 * learning was seen.
 *
 * Wave 4 doctrine: every learning carries verbatim evidence (sage_text
 * + operator_text). Operator can flag any insight as wrong - the
 * backend unwinds the underlying persistence.
 */

import { useEffect, useState } from 'react'
import { X, Check, AlertCircle, Sparkles, BookOpen } from 'lucide-react'

interface Insight {
  id: string
  insight_kind: string
  sage_text: string | null
  operator_text: string | null
  learning_summary: string
  persisted_to: string
  persisted_ref: string | null
  confidence_0_100: number
}

function persistedLabel(persisted: string): string {
  switch (persisted) {
    case 'voice_preferences':
      return 'Saved to voice preferences'
    case 'knowledge_captures':
      return 'Saved to venue knowledge'
    case 'draft_edit_insights_only':
      return 'Noted (not persisted)'
    case 'discarded':
      return 'Discarded (low confidence)'
    default:
      return persisted
  }
}

export function LearningToast({
  draftId,
  onClose,
}: {
  draftId: string
  onClose: () => void
}) {
  const [insights, setInsights] = useState<Insight[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [correctingId, setCorrectingId] = useState<string | null>(null)
  const [correctionText, setCorrectionText] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Fetch insights once on mount. We poll once - if the analyzer is
  // still running (it's a Haiku call, ~2s) we retry after a beat so
  // the toast isn't empty just because we raced the LLM.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch(`/api/agent/drafts/${draftId}/insights`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const j = await res.json()
        if (cancelled) return
        const list = j.insights ?? []
        // Retry once if empty - the analyzer may still be running.
        if (list.length === 0) {
          await new Promise((r) => setTimeout(r, 2500))
          if (cancelled) return
          const res2 = await fetch(`/api/agent/drafts/${draftId}/insights`)
          const j2 = await res2.json()
          if (cancelled) return
          setInsights(j2.insights ?? [])
        } else {
          setInsights(list)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load insights')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [draftId])

  const handleDismiss = async () => {
    try {
      await fetch(`/api/agent/drafts/${draftId}/insights`, { method: 'POST' })
    } catch {
      // best-effort
    }
    onClose()
  }

  const handleSubmitCorrection = async (insightId: string) => {
    if (!correctionText.trim()) return
    setSubmitting(true)
    try {
      await fetch(`/api/agent/drafts/${draftId}/insights/${insightId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ correction: correctionText.trim() }),
      })
      // Reflect the unwound state locally.
      setInsights((prev) =>
        prev.map((i) =>
          i.id === insightId
            ? { ...i, persisted_to: 'discarded', persisted_ref: null }
            : i,
        ),
      )
      setCorrectingId(null)
      setCorrectionText('')
    } catch {
      // ignore
    } finally {
      setSubmitting(false)
    }
  }

  // Hide entirely when there's nothing to show.
  if (!loading && insights.length === 0 && !error) {
    // Stamp acknowledge so the row (if any) flips visible=false.
    fetch(`/api/agent/drafts/${draftId}/insights`, { method: 'POST' }).catch(() => {})
    return null
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleDismiss()
      }}
    >
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative bg-surface rounded-2xl shadow-2xl w-full max-w-2xl border border-border max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-amber-500" />
            <h2 className="font-heading text-lg font-semibold text-sage-900">
              {loading
                ? 'Analyzing your edit...'
                : insights.length === 0
                  ? 'No learnings from this edit'
                  : `I noticed ${insights.length} thing${insights.length === 1 ? '' : 's'} from your edits`}
            </h2>
          </div>
          <button
            onClick={handleDismiss}
            className="p-1.5 rounded-lg text-sage-400 hover:text-sage-600 hover:bg-sage-50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-4 overflow-y-auto flex-1">
          {error && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          {loading && !error && (
            <div className="space-y-3">
              {[0, 1].map((i) => (
                <div key={i} className="animate-pulse bg-sage-50 rounded-lg h-20" />
              ))}
            </div>
          )}

          {!loading && insights.length > 0 && (
            <ul className="space-y-3">
              {insights.map((ins) => (
                <li
                  key={ins.id}
                  className="rounded-lg border border-border bg-warm-white p-3 space-y-2"
                >
                  <div className="flex items-start gap-2">
                    <Check className="w-4 h-4 text-sage-600 shrink-0 mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-sage-800 leading-snug">
                        {ins.learning_summary}
                      </p>
                      <p className="text-xs text-sage-500 mt-1">
                        {persistedLabel(ins.persisted_to)}
                        {ins.persisted_ref && (
                          <>
                            {' · '}
                            <span className="font-mono">{ins.persisted_ref.slice(0, 8)}</span>
                          </>
                        )}
                        {' · '}
                        {ins.confidence_0_100}% confident
                      </p>
                      {ins.sage_text && ins.operator_text && (
                        <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
                          <div className="rounded bg-red-50 border border-red-100 px-2 py-1 text-red-700 italic">
                            <span className="font-medium not-italic">Was:</span>{' '}
                            {ins.sage_text}
                          </div>
                          <div className="rounded bg-emerald-50 border border-emerald-100 px-2 py-1 text-emerald-800">
                            <span className="font-medium">Now:</span> {ins.operator_text}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {correctingId === ins.id ? (
                    <div className="space-y-2 pl-6">
                      <textarea
                        value={correctionText}
                        onChange={(e) => setCorrectionText(e.target.value)}
                        rows={2}
                        placeholder="What did you actually mean?"
                        className="w-full text-xs px-2 py-1.5 border border-sage-200 rounded-md focus:outline-none focus:ring-1 focus:ring-sage-300"
                      />
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleSubmitCorrection(ins.id)}
                          disabled={submitting || !correctionText.trim()}
                          className="text-xs px-2 py-1 bg-sage-600 text-white rounded-md hover:bg-sage-700 disabled:opacity-50"
                        >
                          {submitting ? 'Saving...' : 'Save correction'}
                        </button>
                        <button
                          onClick={() => {
                            setCorrectingId(null)
                            setCorrectionText('')
                          }}
                          className="text-xs px-2 py-1 border border-sage-200 rounded-md text-sage-600"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    ins.persisted_to !== 'discarded' && (
                      <button
                        onClick={() => {
                          setCorrectingId(ins.id)
                          setCorrectionText('')
                        }}
                        className="ml-6 text-[11px] inline-flex items-center gap-1 text-red-600 hover:text-red-800"
                      >
                        <AlertCircle className="w-3 h-3" />
                        That's not what I meant
                      </button>
                    )
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="px-6 py-4 border-t border-border flex items-center justify-between">
          <a
            href="/agent/learning/recent-edits"
            className="text-xs inline-flex items-center gap-1 text-sage-600 hover:text-sage-900 underline-offset-2 hover:underline"
          >
            <BookOpen className="w-3.5 h-3.5" />
            See all learnings
          </a>
          <button
            onClick={handleDismiss}
            className="px-4 py-2 text-sm font-medium bg-sage-500 hover:bg-sage-600 text-white rounded-lg transition-colors"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}
