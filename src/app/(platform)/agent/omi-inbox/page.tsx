'use client'

/**
 * Agent → Omi Inbox
 *
 * Phase 7 Task 61. Triage surface for Omi transcripts that couldn't be
 * auto-matched to a scheduled tour (walk-ins, testing sessions, anything
 * outside the match window, or venues with auto-match disabled).
 *
 * Per-row actions:
 *   - Attach to tour: pick from recent tours for this venue; server copies
 *     the orphan transcript into tours.transcript + binds omi_session_id.
 *   - Dismiss: marks status='dismissed', nothing touches tours.
 *
 * White-label: no venue-name or AI-name hardcoding. Help copy resolves
 * venue_ai_config.ai_name so Rixey sees "Sage", Oakwood sees "Iris", etc.
 */

import { useState, useEffect, useCallback } from 'react'
import { useScope } from '@/lib/hooks/use-scope'
import { createClient } from '@/lib/supabase/client'
import { Inbox, Paperclip, X, MapPin } from 'lucide-react'

interface Orphan {
  id: string
  venue_id: string
  omi_session_id: string
  transcript: string
  segments_count: number
  first_segment_at: string
  last_segment_at: string
  status: 'pending' | 'attached' | 'dismissed'
  created_at: string
}

interface TourOption {
  id: string
  scheduled_at: string | null
  tour_type: string | null
  outcome: string | null
  wedding_id: string | null
  notes: string | null
}

export default function OmiInboxPage() {
  const { venueId } = useScope()
  const [orphans, setOrphans] = useState<Orphan[]>([])
  const [tours, setTours] = useState<TourOption[]>([])
  const [aiName, setAiName] = useState<string>('your assistant')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [selection, setSelection] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    if (!venueId) return
    setLoading(true)
    setError(null)
    try {
      const supabase = createClient()
      const [{ data: orphanData, error: oErr }, { data: tourData }, { data: aiData }] =
        await Promise.all([
          supabase
            .from('tour_transcript_orphans')
            .select('*')
            .eq('venue_id', venueId)
            .eq('status', 'pending')
            .order('last_segment_at', { ascending: false }),
          supabase
            .from('tours')
            .select('id, scheduled_at, tour_type, outcome, wedding_id, notes')
            .eq('venue_id', venueId)
            .in('outcome', ['pending', 'completed'])
            .order('scheduled_at', { ascending: false })
            .limit(50),
          supabase
            .from('venue_ai_config')
            .select('ai_name')
            .eq('venue_id', venueId)
            .maybeSingle(),
        ])
      if (oErr) throw oErr
      setOrphans((orphanData ?? []) as Orphan[])
      setTours((tourData ?? []) as TourOption[])
      setAiName((aiData?.ai_name as string | undefined) || 'your assistant')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [venueId])

  useEffect(() => {
    load()
  }, [load])

  async function handleAttach(orphan: Orphan) {
    const tourId = selection[orphan.id]
    if (!tourId) {
      setError('Pick a tour first.')
      return
    }
    setBusyId(orphan.id)
    setError(null)
    try {
      const res = await fetch(`/api/omi/orphans/${orphan.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attachToTourId: tourId }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Failed' }))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      setOrphans((rows) => rows.filter((r) => r.id !== orphan.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to attach')
    } finally {
      setBusyId(null)
    }
  }

  async function handleDismiss(orphan: Orphan) {
    if (!confirm('Dismiss this transcript? It stays in the database but will not appear here again.')) return
    setBusyId(orphan.id)
    setError(null)
    try {
      const res = await fetch(`/api/omi/orphans/${orphan.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dismiss: true }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setOrphans((rows) => rows.filter((r) => r.id !== orphan.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to dismiss')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="max-w-5xl space-y-6">
      <header className="flex items-center gap-3">
        <Inbox className="w-6 h-6 text-sage-600" />
        <div>
          <h1 className="text-2xl font-serif text-sage-900">Omi Inbox</h1>
          <p className="text-sm text-sage-600 mt-1">
            Transcripts from the Omi wearable that couldn't be matched to a
            scheduled tour. Attach one to a tour so {aiName} can learn from
            it, or dismiss if it was a test or personal recording.
          </p>
        </div>
      </header>

      {error && (
        <div className="border border-red-200 bg-red-50 text-red-700 text-sm rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-sage-500">Loading...</div>
      ) : orphans.length === 0 ? (
        <div className="text-sm text-sage-500 border border-dashed border-border rounded-lg px-4 py-10 text-center">
          Nothing to triage. Orphaned Omi sessions will show up here for attach or dismissal.
        </div>
      ) : (
        <div className="space-y-3">
          {orphans.map((orphan) => {
            const preview = (orphan.transcript || '').slice(0, 200)
            const shortSession = orphan.omi_session_id.slice(0, 12)
            return (
              <div
                key={orphan.id}
                className="border border-border rounded-lg bg-warm-white p-4 space-y-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs text-sage-600">
                    <span className="font-mono bg-sage-50 px-2 py-0.5 rounded border border-sage-200">
                      {shortSession}
                    </span>
                    <span>{new Date(orphan.first_segment_at).toLocaleString()}</span>
                    <span className="text-sage-400">·</span>
                    <span>{orphan.segments_count} segments</span>
                  </div>
                </div>

                <p className="text-sm text-sage-800 leading-relaxed">
                  {preview.trim() || <span className="italic text-sage-500">Empty transcript</span>}
                  {orphan.transcript && orphan.transcript.length > 200 && (
                    <span className="text-sage-400">...</span>
                  )}
                </p>

                <div className="flex flex-col sm:flex-row gap-2 pt-1">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <MapPin className="w-4 h-4 text-sage-500 shrink-0" />
                    <select
                      value={selection[orphan.id] ?? ''}
                      onChange={(e) =>
                        setSelection((prev) => ({ ...prev, [orphan.id]: e.target.value }))
                      }
                      disabled={busyId === orphan.id || tours.length === 0}
                      className="flex-1 min-w-0 border border-border rounded-lg px-3 py-2 bg-warm-white text-sage-900 text-sm focus:outline-none focus:ring-2 focus:ring-sage-300"
                    >
                      <option value="">
                        {tours.length === 0 ? 'No tours for this venue yet' : 'Attach to tour...'}
                      </option>
                      {tours.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.scheduled_at
                            ? new Date(t.scheduled_at).toLocaleString()
                            : 'No scheduled time'}
                          {t.tour_type ? ` · ${t.tour_type}` : ''}
                          {t.outcome ? ` · ${t.outcome}` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => handleAttach(orphan)}
                      disabled={busyId === orphan.id || !selection[orphan.id]}
                      className="inline-flex items-center gap-1.5 px-3 py-2 bg-sage-600 text-white rounded-lg text-sm font-medium hover:bg-sage-700 disabled:opacity-50 transition-colors"
                    >
                      <Paperclip className="w-4 h-4" />
                      Attach
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDismiss(orphan)}
                      disabled={busyId === orphan.id}
                      className="inline-flex items-center gap-1.5 px-3 py-2 border border-border text-sage-700 rounded-lg text-sm hover:bg-sage-50 disabled:opacity-50 transition-colors"
                    >
                      <X className="w-4 h-4" />
                      Dismiss
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
