'use client'

import { useState, useCallback, useMemo } from 'react'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { createClient } from '@/lib/supabase/client'
import { useSupabaseList } from '@/lib/hooks/use-supabase-list'
import { Hammer, Plus, Trash2, AlertTriangle, MapPin } from 'lucide-react'

// ---------------------------------------------------------------------------
// Property operational state admin (T2-B Phase 2 / LIMB-16.2.2)
//
// Anomaly detection reads venue_operational_state windows to surface "the
// venue was in renovation / closure / capacity change / vendor change /
// policy change / force-majeure" hypotheses BEFORE chasing funnel-shape
// causes. Without this surface, anomaly drops during a renovation period
// always blame the funnel.
// ---------------------------------------------------------------------------

interface OperationalState {
  id: string
  venue_id: string
  state_type: string
  start_at: string
  end_at: string | null
  title: string
  description: string | null
  affected_space: string | null
  created_at: string
}

const STATE_TYPE_OPTIONS: Array<{ value: string; label: string; description: string }> = [
  { value: 'renovation', label: 'Renovation / construction', description: 'Building work that affects tour availability or photo shoots' },
  { value: 'closure', label: 'Seasonal / scheduled closure', description: 'Off-season, holiday weeks, planned downtime' },
  { value: 'capacity_change', label: 'Capacity change', description: 'New space opens, existing space taken offline' },
  { value: 'vendor_change', label: 'Vendor change', description: 'Caterer / staffing partner / preferred vendor list' },
  { value: 'policy_change', label: 'Policy change', description: 'Pricing tier, weekday booking opens, capacity rule' },
  { value: 'force_majeure', label: 'Force majeure', description: 'Weather damage, fire, flood, power outage, other emergency' },
  { value: 'other', label: 'Other', description: 'Anything else worth tracking' },
]

function labelFor(stateType: string): string {
  return STATE_TYPE_OPTIONS.find((o) => o.value === stateType)?.label ?? stateType
}

function formatRange(startIso: string, endIso: string | null): string {
  const s = new Date(startIso)
  const sStr = s.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  if (!endIso) return `${sStr} – ongoing`
  const eStr = new Date(endIso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  return `${sStr} – ${eStr}`
}

export default function PropertyStateConfigPage() {
  const venueId = useVenueId()
  const supabase = createClient()
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const [newType, setNewType] = useState<string>('renovation')
  const [newTitle, setNewTitle] = useState('')
  const [newStart, setNewStart] = useState('')
  const [newEnd, setNewEnd] = useState('')
  const [newOngoing, setNewOngoing] = useState(false)
  const [newDescription, setNewDescription] = useState('')
  const [newAffected, setNewAffected] = useState('')

  // 2026-05-01 (review pass 4 follow-up): use the shared list hook.
  const fetcher = useCallback(async (): Promise<OperationalState[]> => {
    if (!venueId) return []
    const { data, error: fetchErr } = await supabase
      .from('venue_operational_state')
      .select('id, venue_id, state_type, start_at, end_at, title, description, affected_space, created_at')
      .eq('venue_id', venueId)
      .is('deleted_at', null)
      .order('start_at', { ascending: false })
    if (fetchErr) throw fetchErr
    return (data ?? []) as OperationalState[]
  }, [venueId, supabase])

  const {
    rows,
    loading,
    error: loadError,
    reload: fetchRows,
  } = useSupabaseList<OperationalState>(fetcher, [venueId])
  const displayError = error ?? loadError

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!venueId || !newTitle.trim() || !newStart || submitting) return
    if (!newOngoing && !newEnd) {
      setError('End is required (or mark ongoing)')
      return
    }
    if (!newOngoing && new Date(newEnd) <= new Date(newStart)) {
      setError('End must be after start')
      return
    }
    setSubmitting(true)
    try {
      const { error: insertErr } = await supabase.from('venue_operational_state').insert({
        venue_id: venueId,
        state_type: newType,
        start_at: new Date(newStart).toISOString(),
        end_at: newOngoing ? null : new Date(newEnd).toISOString(),
        title: newTitle.trim(),
        description: newDescription.trim() || null,
        affected_space: newAffected.trim() || null,
      })
      if (insertErr) throw insertErr
      setNewType('renovation')
      setNewTitle('')
      setNewStart('')
      setNewEnd('')
      setNewOngoing(false)
      setNewDescription('')
      setNewAffected('')
      await fetchRows()
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
        .from('venue_operational_state')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id)
      if (delErr) throw delErr
      await fetchRows()
    } catch (err) {
      console.error('Failed to delete state:', err)
      setError('Failed to delete')
    }
  }

  async function endOngoing(id: string) {
    if (!venueId) return
    try {
      const { error: updErr } = await supabase
        .from('venue_operational_state')
        .update({ end_at: new Date().toISOString() })
        .eq('id', id)
      if (updErr) throw updErr
      await fetchRows()
    } catch (err) {
      console.error('Failed to close state:', err)
      setError('Failed to close window')
    }
  }

  const { active, recent } = useMemo(() => {
    const now = Date.now()
    const active: OperationalState[] = []
    const recent: OperationalState[] = []
    for (const r of rows) {
      const startMs = new Date(r.start_at).getTime()
      const endMs = r.end_at ? new Date(r.end_at).getTime() : Number.POSITIVE_INFINITY
      if (startMs <= now && endMs >= now) active.push(r)
      else recent.push(r)
    }
    return { active, recent }
  }, [rows])

  if (loading) return <div className="p-8"><p className="text-sage-500 text-sm">Loading…</p></div>

  const selectedTypeDesc = STATE_TYPE_OPTIONS.find((o) => o.value === newType)?.description ?? ''

  return (
    <div className="p-8 max-w-4xl space-y-6">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <Hammer className="w-5 h-5 text-sage-700" />
          <h1 className="font-heading text-2xl font-semibold text-sage-900">Property operational state</h1>
        </div>
        <p className="text-sm text-sage-600 max-w-2xl">
          Log property-level state windows that affect bookings and couple
          behaviour — renovations, closures, vendor changes, policy changes,
          force-majeure events. Anomaly detection reads these so the
          hypothesis chain knows about real-world causes before chasing
          funnel explanations.
        </p>
      </header>

      {displayError && (
        <div className="flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4 mt-0.5" />
          <span>{displayError}</span>
        </div>
      )}

      <form onSubmit={handleAdd} className="rounded-lg border border-sage-200 bg-white p-4 space-y-3">
        <h2 className="font-medium text-sage-900">Log a state window</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-sage-600">Type</label>
            <select
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
              className="mt-1 w-full rounded border border-sage-200 px-3 py-2 text-sm"
            >
              {STATE_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            {selectedTypeDesc && <p className="text-xs text-sage-500 mt-1">{selectedTypeDesc}</p>}
          </div>
          <div>
            <label className="text-xs text-sage-600">Title</label>
            <input
              type="text"
              required
              placeholder="Barn renovation phase 2 / Memorial Day closure / etc."
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              className="mt-1 w-full rounded border border-sage-200 px-3 py-2 text-sm"
            />
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
            <label className="text-xs text-sage-600">End {newOngoing && <span className="text-sage-400">(ongoing)</span>}</label>
            <input
              type="datetime-local"
              disabled={newOngoing}
              value={newEnd}
              onChange={(e) => setNewEnd(e.target.value)}
              className="mt-1 w-full rounded border border-sage-200 px-3 py-2 text-sm disabled:bg-sage-50 disabled:text-sage-400"
            />
            <label className="mt-1 flex items-center gap-1 text-xs text-sage-600">
              <input type="checkbox" checked={newOngoing} onChange={(e) => setNewOngoing(e.target.checked)} />
              Ongoing (no known end yet)
            </label>
          </div>
          <div>
            <label className="text-xs text-sage-600">Affected space (optional)</label>
            <input
              type="text"
              placeholder="Whole venue / Barn / Garden / Reception hall"
              value={newAffected}
              onChange={(e) => setNewAffected(e.target.value)}
              className="mt-1 w-full rounded border border-sage-200 px-3 py-2 text-sm"
            />
          </div>
        </div>
        <div>
          <label className="text-xs text-sage-600">Description</label>
          <textarea
            placeholder="What's happening, why it matters for tour bookings"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
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
          {submitting ? 'Saving…' : 'Log state window'}
        </button>
      </form>

      <Section title="Active right now" rows={active} onDelete={handleDelete} onEndOngoing={endOngoing} emptyMessage="No active state windows." showEnd />
      <Section title="Recent + upcoming" rows={recent.slice(0, 20)} onDelete={handleDelete} onEndOngoing={endOngoing} emptyMessage="No past or upcoming state windows." />
      {recent.length > 20 && (
        <p className="text-xs text-sage-500">Showing 20 most recent rows (of {recent.length}).</p>
      )}
    </div>
  )
}

interface SectionProps {
  title: string
  rows: OperationalState[]
  onDelete: (id: string) => void
  onEndOngoing: (id: string) => void
  emptyMessage: string
  showEnd?: boolean
}

function Section({ title, rows, onDelete, onEndOngoing, emptyMessage, showEnd }: SectionProps) {
  return (
    <section className="space-y-2">
      <h2 className="font-medium text-sage-900">{title} ({rows.length})</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-sage-500 italic">{emptyMessage}</p>
      ) : (
        <ul className="rounded-lg border border-sage-200 bg-white divide-y divide-sage-100">
          {rows.map((r) => (
            <li key={r.id} className="px-4 py-3 flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-sage-900">{r.title}</span>
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-sage-50 text-[10px] font-medium text-sage-600 uppercase">{labelFor(r.state_type)}</span>
                  {r.affected_space && (
                    <span className="inline-flex items-center gap-1 text-xs text-sage-500">
                      <MapPin className="w-3 h-3" />
                      {r.affected_space}
                    </span>
                  )}
                </div>
                <p className="text-xs text-sage-500 mt-0.5">{formatRange(r.start_at, r.end_at)}</p>
                {r.description && <p className="text-xs text-sage-500 mt-1 italic">{r.description}</p>}
              </div>
              <div className="flex items-center gap-1">
                {showEnd && r.end_at === null && (
                  <button
                    onClick={() => onEndOngoing(r.id)}
                    className="text-xs text-sage-500 hover:text-sage-700 px-2 py-1 rounded border border-sage-200"
                    title="Mark this window as ended now"
                  >
                    End now
                  </button>
                )}
                <button onClick={() => onDelete(r.id)} className="text-sage-400 hover:text-red-600 p-1" title="Remove">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
