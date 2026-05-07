'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { createClient } from '@/lib/supabase/client'
import { useSupabaseList } from '@/lib/hooks/use-supabase-list'
import { CalendarOff, Plus, Trash2, AlertTriangle, User, Save } from 'lucide-react'
import { CopyFromVenueButton } from '@/components/portal/copy-from-venue'

// ---------------------------------------------------------------------------
// Coordinator absences admin (T2-B Phase 2 / LIMB-16.2.1)
//
// anomaly-detection.ts reads these so "coordinator was out" is the FIRST
// hypothesis when response-time or auto-send drops are detected. Pre-T2-B
// the AI prompt always defaulted to funnel-shape causes.
// ---------------------------------------------------------------------------

interface Absence {
  id: string
  venue_id: string
  assigned_consultant_id: string | null
  start_at: string
  end_at: string
  reason: string
  handoff_notes: string | null
  created_at: string
  consultant_name?: string | null
}

interface ConsultantOption {
  id: string
  name: string
}

const REASON_SUGGESTIONS = [
  'Vacation', 'Conference', 'Illness', 'Family leave',
  'Holiday closure', 'Weather', 'Offsite training', 'Other',
]

function formatRange(startIso: string, endIso: string): string {
  const s = new Date(startIso)
  const e = new Date(endIso)
  const sameDay = s.toDateString() === e.toDateString()
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }
  if (sameDay) return s.toLocaleDateString('en-US', opts)
  const sStr = s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const eStr = e.toLocaleDateString('en-US', opts)
  return `${sStr} – ${eStr}`
}

export default function AbsencesConfigPage() {
  const venueId = useVenueId()
  const supabase = createClient()
  const [consultants, setConsultants] = useState<ConsultantOption[]>([])
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const [newConsultantId, setNewConsultantId] = useState<string>('')
  const [newStart, setNewStart] = useState('')
  const [newEnd, setNewEnd] = useState('')
  const [newReason, setNewReason] = useState('')
  const [newHandoff, setNewHandoff] = useState('')

  // 2026-05-01 (review pass 4 follow-up): consultants fetched separately
  // since the form needs them; absences flow through the shared hook.
  // Both keyed off venueId so they re-fetch on venue switch.
  useEffect(() => {
    if (!venueId) return
    let alive = true
    ;(async () => {
      const { data } = await supabase
        .from('user_profiles')
        .select('id, first_name, last_name')
        .eq('venue_id', venueId)
      if (!alive) return
      const list: ConsultantOption[] = ((data ?? []) as Array<{
        id: string
        first_name: string | null
        last_name: string | null
      }>).map((u) => ({
        id: u.id,
        name: [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || 'Unnamed user',
      }))
      setConsultants(list)
    })()
    return () => { alive = false }
  }, [venueId, supabase])

  const fetcher = useCallback(async (): Promise<Absence[]> => {
    if (!venueId) return []
    const { data, error: fetchErr } = await supabase
      .from('coordinator_absences')
      .select('id, venue_id, assigned_consultant_id, start_at, end_at, reason, handoff_notes, created_at')
      .eq('venue_id', venueId)
      .is('deleted_at', null)
      .order('start_at', { ascending: false })
    if (fetchErr) throw fetchErr
    const consultantMap = new Map(consultants.map((c) => [c.id, c.name]))
    return ((data ?? []) as Absence[]).map((a) => ({
      ...a,
      consultant_name: a.assigned_consultant_id
        ? consultantMap.get(a.assigned_consultant_id) ?? 'Unknown'
        : null,
    }))
  }, [venueId, supabase, consultants])

  const {
    rows: absences,
    loading,
    error: loadError,
    reload: fetchData,
  } = useSupabaseList<Absence>(fetcher, [venueId, consultants])
  const displayError = error ?? loadError

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!venueId || !newStart || !newEnd || !newReason.trim() || submitting) return
    if (new Date(newEnd) <= new Date(newStart)) {
      setError('End must be after start')
      return
    }
    setSubmitting(true)
    try {
      const { error: insertErr } = await supabase.from('coordinator_absences').insert({
        venue_id: venueId,
        assigned_consultant_id: newConsultantId || null,
        start_at: new Date(newStart).toISOString(),
        end_at: new Date(newEnd).toISOString(),
        reason: newReason.trim(),
        handoff_notes: newHandoff.trim() || null,
      })
      if (insertErr) throw insertErr
      setNewConsultantId('')
      setNewStart('')
      setNewEnd('')
      setNewReason('')
      setNewHandoff('')
      await fetchData()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to add'
      setError(msg)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(id: string) {
    if (!venueId) return
    try {
      const { error: delErr } = await supabase
        .from('coordinator_absences')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id)
      if (delErr) throw delErr
      await fetchData()
    } catch (err) {
      console.error('Failed to delete absence:', err)
      setError('Failed to delete')
    }
  }

  const { upcoming, past } = useMemo(() => {
    const now = Date.now()
    const upcoming: Absence[] = []
    const past: Absence[] = []
    for (const a of absences) {
      if (new Date(a.end_at).getTime() >= now) upcoming.push(a)
      else past.push(a)
    }
    upcoming.sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime())
    past.sort((a, b) => new Date(b.start_at).getTime() - new Date(a.start_at).getTime())
    return { upcoming, past }
  }, [absences])

  if (loading) return <div className="p-8"><p className="text-sage-500 text-sm">Loading…</p></div>

  return (
    <div className="p-8 max-w-4xl space-y-6">
      <header className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CalendarOff className="w-5 h-5 text-sage-700" />
            <h1 className="font-heading text-2xl font-semibold text-sage-900">Coordinator absences</h1>
          </div>
          <CopyFromVenueButton
            table="coordinator_absences"
            onCopied={() => window.location.reload()}
          />
        </div>
        <p className="text-sm text-sage-600 max-w-2xl">
          Log windows when you or a coordinator are out of office. Anomaly
          detection reads these so &quot;coordinator was out&quot; is the
          first hypothesis when inquiry response time drops or auto-send
          volume changes — instead of chasing harder funnel explanations.
        </p>
      </header>

      {displayError && (
        <div className="flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4 mt-0.5" />
          <span>{displayError}</span>
        </div>
      )}

      <form onSubmit={handleAdd} className="rounded-lg border border-sage-200 bg-white p-4 space-y-3">
        <h2 className="font-medium text-sage-900">Log an absence</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-sage-600">Coordinator</label>
            <select
              value={newConsultantId}
              onChange={(e) => setNewConsultantId(e.target.value)}
              className="mt-1 w-full rounded border border-sage-200 px-3 py-2 text-sm"
            >
              <option value="">Whole venue (closure)</option>
              {consultants.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-sage-600">Reason</label>
            <input
              type="text"
              required
              list="reason-suggestions"
              placeholder="Vacation / conference / illness / closure"
              value={newReason}
              onChange={(e) => setNewReason(e.target.value)}
              className="mt-1 w-full rounded border border-sage-200 px-3 py-2 text-sm"
            />
            <datalist id="reason-suggestions">
              {REASON_SUGGESTIONS.map((r) => <option key={r} value={r} />)}
            </datalist>
          </div>
          <div>
            <label className="text-xs text-sage-600">Start</label>
            <input
              type="datetime-local"
              required
              value={newStart}
              onChange={(e) => setNewStart(e.target.value)}
              className="mt-1 w-full rounded border border-sage-200 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-sage-600">End</label>
            <input
              type="datetime-local"
              required
              value={newEnd}
              onChange={(e) => setNewEnd(e.target.value)}
              className="mt-1 w-full rounded border border-sage-200 px-3 py-2 text-sm"
            />
          </div>
        </div>
        <div>
          <label className="text-xs text-sage-600">Handoff notes (optional)</label>
          <textarea
            placeholder="Who's covering, what happens to inquiries, auto-send paused etc."
            value={newHandoff}
            onChange={(e) => setNewHandoff(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded border border-sage-200 px-3 py-2 text-sm resize-none"
          />
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex items-center gap-1.5 rounded bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white text-sm font-medium px-3 py-1.5"
        >
          <Plus className="w-4 h-4" />
          {submitting ? 'Saving…' : 'Log absence'}
        </button>
      </form>

      <AbsenceSection title="Upcoming + active" rows={upcoming} onDelete={handleDelete} emptyMessage="No upcoming absences logged." />
      <AbsenceSection title="Past" rows={past.slice(0, 20)} onDelete={handleDelete} emptyMessage="No past absences." />
      {past.length > 20 && (
        <p className="text-xs text-sage-500">Showing 20 most recent past absences (of {past.length}).</p>
      )}
    </div>
  )
}

interface AbsenceSectionProps {
  title: string
  rows: Absence[]
  onDelete: (id: string) => void
  emptyMessage: string
}

function AbsenceSection({ title, rows, onDelete, emptyMessage }: AbsenceSectionProps) {
  return (
    <section className="space-y-2">
      <h2 className="font-medium text-sage-900">{title} ({rows.length})</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-sage-500 italic">{emptyMessage}</p>
      ) : (
        <ul className="rounded-lg border border-sage-200 bg-white divide-y divide-sage-100">
          {rows.map((a) => (
            <li key={a.id} className="px-4 py-3 flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-sage-900">{a.reason}</span>
                  {a.consultant_name ? (
                    <span className="inline-flex items-center gap-1 text-xs text-sage-600">
                      <User className="w-3 h-3" />
                      {a.consultant_name}
                    </span>
                  ) : (
                    <span className="text-xs text-sage-600">Whole venue</span>
                  )}
                </div>
                <p className="text-xs text-sage-500 mt-0.5">{formatRange(a.start_at, a.end_at)}</p>
                {a.handoff_notes && (
                  <p className="text-xs text-sage-500 mt-1 italic">{a.handoff_notes}</p>
                )}
              </div>
              <button onClick={() => onDelete(a.id)} className="text-sage-400 hover:text-red-600 p-1" title="Remove">
                <Trash2 className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
