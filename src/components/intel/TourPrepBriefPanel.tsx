'use client'

/**
 * Wave 13 — tour-prep brief panel for the lead detail page.
 *
 * Surfaces a generated brief when there's an upcoming tour on this
 * wedding. Hides entirely when there's no upcoming tour OR no brief
 * (rather than spam the page with empty states). Coordinator can
 * click "Generate brief" when an upcoming tour exists but no brief
 * has landed yet (the daily sweep fires within 24-48h, but the manual
 * trigger is for coordinators who want to walk in prepared earlier).
 */

import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Sparkles, Loader2, AlertCircle, Calendar } from 'lucide-react'

interface KeyFact {
  fact: string
  why_it_matters: string
}
interface SensitivityFlag {
  category: string
  handle_with: string
}
interface TourPrepBrief {
  key_facts: KeyFact[]
  sensitivity_flags: SensitivityFlag[]
  persona_summary: string
  what_to_lead_with: string
  what_to_avoid: string
  recent_signals_summary: string
  recommended_questions: string[]
  expected_concerns: string[]
}

interface UpcomingTour {
  id: string
  scheduled_at: string
  tour_type: string | null
}

interface StoredBriefRow {
  id: string
  tour_id: string
  brief_jsonb: TourPrepBrief
  generated_at: string
}

export function TourPrepBriefPanel({ weddingId }: { weddingId: string }) {
  const supabase = createClient()
  const [upcomingTour, setUpcomingTour] = useState<UpcomingTour | null>(null)
  const [brief, setBrief] = useState<StoredBriefRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const nowIso = new Date().toISOString()
      const { data: tours } = await supabase
        .from('tours')
        .select('id, scheduled_at, tour_type')
        .eq('wedding_id', weddingId)
        .gte('scheduled_at', nowIso)
        .order('scheduled_at', { ascending: true })
        .limit(1)
      const tour = tours && tours.length > 0 ? (tours[0] as UpcomingTour) : null
      setUpcomingTour(tour)
      if (tour) {
        const { data: briefRow } = await supabase
          .from('tour_prep_briefs')
          .select('id, tour_id, brief_jsonb, generated_at')
          .eq('tour_id', tour.id)
          .maybeSingle()
        setBrief((briefRow as StoredBriefRow | null) ?? null)
      } else {
        setBrief(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [supabase, weddingId])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  const triggerGenerate = async () => {
    if (!upcomingTour) return
    setGenerating(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/tour/prep-brief/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tourId: upcomingTour.id, force: true }),
      })
      const data = await res.json()
      if (!res.ok || !data?.ok) {
        setError(data?.error ?? data?.reason ?? `HTTP ${res.status}`)
        return
      }
      await fetchAll()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setGenerating(false)
    }
  }

  // Hide entirely when there's no upcoming tour.
  if (loading) {
    return null
  }
  if (!upcomingTour) return null

  const b = brief?.brief_jsonb

  return (
    <div className="bg-gradient-to-br from-amber-50 via-white to-white border border-amber-200 rounded-lg p-5 mb-4">
      <div className="flex items-center gap-2 mb-3">
        <Sparkles className="w-4 h-4 text-amber-700" />
        <h3 className="font-medium text-stone-900">Tour-prep brief</h3>
        <span className="text-xs text-stone-500">
          Tour {new Date(upcomingTour.scheduled_at).toLocaleString(undefined, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })}
        </span>
        <button
          onClick={triggerGenerate}
          disabled={generating}
          className="ml-auto text-xs px-2.5 py-1 rounded-md border border-amber-300 bg-white text-amber-800 hover:bg-amber-100 disabled:opacity-50"
        >
          {generating ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" /> generating
            </span>
          ) : brief ? (
            'Regenerate'
          ) : (
            'Generate'
          )}
        </button>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 text-red-800 px-3 py-2 text-sm mb-3 flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {!brief && !error && (
        <div className="text-sm text-stone-600 flex items-center gap-2">
          <Calendar className="w-3.5 h-3.5 text-stone-500" />
          <span>
            No brief yet. Click <em>Generate</em> to draft one now, or wait for
            the daily sweep (24-48h pre-tour).
          </span>
        </div>
      )}

      {b && (
        <div className="space-y-3 text-sm">
          <div className="text-stone-800">
            <span className="font-medium">Persona:</span> {b.persona_summary}
          </div>

          {b.key_facts.length > 0 && (
            <div>
              <div className="text-xs uppercase tracking-wide text-stone-500 mb-1">
                Key facts
              </div>
              <ul className="space-y-1.5">
                {b.key_facts.map((f, i) => (
                  <li key={i} className="text-stone-700">
                    <span className="font-medium">{f.fact}</span>
                    {f.why_it_matters && (
                      <span className="text-stone-500"> — {f.why_it_matters}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <div className="text-xs uppercase tracking-wide text-emerald-700 mb-1">
                Lead with
              </div>
              <p className="text-stone-700">{b.what_to_lead_with}</p>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-rose-700 mb-1">
                Avoid
              </div>
              <p className="text-stone-700">{b.what_to_avoid}</p>
            </div>
          </div>

          {b.sensitivity_flags.length > 0 && (
            <div>
              <div className="text-xs uppercase tracking-wide text-stone-500 mb-1">
                Sensitivity (voice-shape only)
              </div>
              <ul className="space-y-1">
                {b.sensitivity_flags.map((f, i) => (
                  <li key={i} className="text-stone-700">
                    <span className="text-amber-700">{f.category}:</span>{' '}
                    {f.handle_with}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {b.recommended_questions.length > 0 && (
            <div>
              <div className="text-xs uppercase tracking-wide text-stone-500 mb-1">
                Recommended questions
              </div>
              <ul className="list-disc list-inside text-stone-700 space-y-0.5">
                {b.recommended_questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </div>
          )}

          {b.expected_concerns.length > 0 && (
            <div>
              <div className="text-xs uppercase tracking-wide text-stone-500 mb-1">
                Expected concerns
              </div>
              <ul className="list-disc list-inside text-stone-700 space-y-0.5">
                {b.expected_concerns.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}

          {brief && (
            <div className="text-xs text-stone-500 pt-1">
              Brief generated{' '}
              {new Date(brief.generated_at).toLocaleString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
