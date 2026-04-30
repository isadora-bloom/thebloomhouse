'use client'

/**
 * Tour Insights panel for the lead detail page (Connective tissue II / fix #1).
 *
 * For each tour the wedding has, surfaces the cached AI-generated
 * post-tour brief: what happened, what they cared about, open
 * questions, next-step recommendation. Coordinator can regenerate
 * via the existing POST endpoint when they want a fresh take.
 *
 * Self-hides when the wedding has no tours, or when no tour has a
 * persisted brief and the coordinator hasn't asked to generate one.
 */

import { useEffect, useState } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import { Telescope, Sparkles, RefreshCw, Loader2 } from 'lucide-react'

interface TourLite {
  id: string
  scheduled_at: string | null
  outcome: string | null
  tour_brief_generated_at: string | null
  tour_brief_text: string | null
  tour_brief_confidence: 'high' | 'medium' | 'low' | null
  tour_brief_followup_draft: string | null
}

interface Props {
  weddingId: string
}

function getSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}

function fmtTourDate(d: string | null): string {
  if (!d) return 'Tour'
  // UTC formatting for cross-timezone consistency.
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

function confidenceBadgeClass(c: 'high' | 'medium' | 'low' | null): string {
  if (c === 'high') return 'bg-emerald-50 text-emerald-700 border-emerald-200'
  if (c === 'low') return 'bg-amber-50 text-amber-700 border-amber-200'
  return 'bg-sage-50 text-sage-700 border-sage-200'
}

export function TourInsightsPanel({ weddingId }: Props) {
  const [tours, setTours] = useState<TourLite[]>([])
  const [loading, setLoading] = useState(true)
  const [generatingId, setGeneratingId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const sb = getSupabase()
    ;(async () => {
      setLoading(true)
      const { data } = await sb
        .from('tours')
        .select('id, scheduled_at, outcome, tour_brief_generated_at, tour_brief_text, tour_brief_confidence, tour_brief_followup_draft')
        .eq('wedding_id', weddingId)
        .order('scheduled_at', { ascending: false })
      if (!cancelled) {
        setTours((data ?? []) as TourLite[])
        setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [weddingId])

  if (loading) return null
  if (tours.length === 0) return null

  // Show only tours that have a brief OR can have one generated.
  // For now: all tours qualify (the regenerate button handles cold start).
  const visibleTours = tours

  async function regenerate(tourId: string) {
    setGeneratingId(tourId)
    try {
      const res = await fetch('/api/agent/post-tour-brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tourId }),
      })
      if (!res.ok) {
        alert('Could not regenerate the brief. Tour may not have a transcript yet.')
        return
      }
      const json = (await res.json()) as { brief?: { brief: string; suggestedFollowUpDraft: string | null; confidence: 'high' | 'medium' | 'low' } | null }
      if (json.brief) {
        setTours((prev) => prev.map((t) => t.id === tourId ? {
          ...t,
          tour_brief_text: json.brief!.brief,
          tour_brief_followup_draft: json.brief!.suggestedFollowUpDraft,
          tour_brief_confidence: json.brief!.confidence,
          tour_brief_generated_at: new Date().toISOString(),
        } : t))
      }
    } finally {
      setGeneratingId(null)
    }
  }

  return (
    <div className="bg-surface border border-border rounded-xl p-5 shadow-sm space-y-3">
      <div className="flex items-center gap-2">
        <Telescope className="w-4 h-4 text-sage-500" />
        <h3 className="text-sm font-semibold text-sage-900">Tour insights</h3>
      </div>
      <div className="space-y-3">
        {visibleTours.map((t) => (
          <div key={t.id} className="border border-sage-100 rounded-lg p-3 bg-warm-white">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="min-w-0 flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-sage-900">{fmtTourDate(t.scheduled_at)}</span>
                {t.outcome && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full border border-sage-200 text-sage-600">
                    {t.outcome.replace(/_/g, ' ')}
                  </span>
                )}
                {t.tour_brief_confidence && (
                  <span className={`text-[10px] px-2 py-0.5 rounded-full border ${confidenceBadgeClass(t.tour_brief_confidence)}`}>
                    AI · {t.tour_brief_confidence} confidence
                  </span>
                )}
              </div>
              <button
                onClick={() => regenerate(t.id)}
                disabled={generatingId === t.id}
                className="text-[11px] text-sage-500 hover:text-sage-700 inline-flex items-center gap-1 disabled:opacity-50 shrink-0"
                title={t.tour_brief_text ? 'Regenerate brief' : 'Generate brief'}
              >
                {generatingId === t.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                {t.tour_brief_text ? 'Regenerate' : 'Generate'}
              </button>
            </div>
            {t.tour_brief_text ? (
              <>
                <p className="text-xs text-sage-800 leading-relaxed whitespace-pre-wrap">{t.tour_brief_text}</p>
                {t.tour_brief_followup_draft && (
                  <details className="mt-2 group">
                    <summary className="text-[11px] text-sage-500 cursor-pointer inline-flex items-center gap-1 hover:text-sage-700">
                      <Sparkles className="w-3 h-3" />
                      Suggested follow-up draft
                    </summary>
                    <div className="mt-2 p-2 bg-sage-50/50 border border-sage-100 rounded text-xs text-sage-700 whitespace-pre-wrap">
                      {t.tour_brief_followup_draft}
                    </div>
                  </details>
                )}
              </>
            ) : (
              <p className="text-xs text-sage-500 italic">
                No brief yet. Click Generate to have {' '}
                <Sparkles className="w-3 h-3 inline mx-0.5 text-sage-500" />
                summarize what happened — works best after the tour transcript has been extracted.
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
