'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Sparkles,
  Plus,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Cultural moments review queue (T2-C / Playbook INS-19.5.8)
//
// Cultural moments are time-bounded events that materially shift wedding-
// related discretionary behaviour — celebrity weddings, viral aesthetic
// shifts (cottagecore / dark academia), generational milestones, breaking
// industry news. The system can DETECT them via search-trend spikes + news
// embedding distance, but a coordinator must CONFIRM before they enter
// the External Context as a named event with influence weight. Auto-
// classification is too noisy + a wrong moment poisons every downstream
// correlation.
//
// Three lifecycle states:
//   - proposed   → coordinator reviews, sets influence_weight, confirms
//   - confirmed  → enters External Context, correlation engine reads it
//   - dismissed  → audit trail of "not a real moment"
// ---------------------------------------------------------------------------

interface Moment {
  id: string
  status: 'proposed' | 'confirmed' | 'dismissed' | 'archived'
  title: string
  description: string | null
  start_at: string
  end_at: string | null
  category: string | null
  evidence: Record<string, unknown>
  influence_weight: number | null
  geo_scope: string | null
  proposed_by: 'system' | 'ai' | 'coordinator'
  reviewed_at: string | null
  created_at: string
}

const CATEGORY_OPTIONS = [
  { value: 'celebrity_wedding', label: 'Celebrity wedding' },
  { value: 'aesthetic_shift', label: 'Aesthetic shift' },
  { value: 'generational_milestone', label: 'Generational milestone' },
  { value: 'industry_news', label: 'Industry news' },
  { value: 'macro_event', label: 'Macro event' },
  { value: 'platform_event', label: 'Platform event' },
  { value: 'other', label: 'Other' },
]

function formatRange(startIso: string, endIso: string | null): string {
  const s = new Date(startIso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  if (!endIso) return `${s} – ongoing`
  const e = new Date(endIso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  return `${s} – ${e}`
}

export default function CulturalMomentsPage() {
  const supabase = createClient()
  const [moments, setMoments] = useState<Moment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showProposeForm, setShowProposeForm] = useState(false)

  const [newTitle, setNewTitle] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newCategory, setNewCategory] = useState('aesthetic_shift')
  const [newStartAt, setNewStartAt] = useState('')
  const [newEndAt, setNewEndAt] = useState('')
  const [newGeoScope, setNewGeoScope] = useState('us')
  const [newOngoing, setNewOngoing] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const fetchMoments = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error: fetchErr } = await supabase
        .from('cultural_moments')
        .select('id, status, title, description, start_at, end_at, category, evidence, influence_weight, geo_scope, proposed_by, reviewed_at, created_at')
        .neq('status', 'archived')
        .order('created_at', { ascending: false })
        .limit(200)
      if (fetchErr) throw fetchErr
      setMoments((data ?? []) as Moment[])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [supabase])

  useEffect(() => { fetchMoments() }, [fetchMoments])

  async function handlePropose(e: React.FormEvent) {
    e.preventDefault()
    if (!newTitle.trim() || !newStartAt || submitting) return

    // 2026-05-01 (review pass 4): client-side validation. The DB has a
    // CHECK that would reject end_at <= start_at but the error message
    // surfaced via Supabase is opaque ("new row for relation
    // \"cultural_moments\" violates check constraint…") — confusing for
    // a coordinator. Validate here so the inline error reads cleanly.
    const startMs = new Date(newStartAt).getTime()
    if (!Number.isFinite(startMs)) {
      setError('Start date is invalid.')
      return
    }
    if (!newOngoing && newEndAt) {
      const endMs = new Date(newEndAt).getTime()
      if (!Number.isFinite(endMs)) {
        setError('End date is invalid.')
        return
      }
      if (endMs <= startMs) {
        setError('End date must be after start date (or mark the moment ongoing).')
        return
      }
    }
    setError(null)

    setSubmitting(true)
    try {
      const { error: insertErr } = await supabase.from('cultural_moments').insert({
        title: newTitle.trim(),
        description: newDescription.trim() || null,
        category: newCategory,
        start_at: new Date(newStartAt).toISOString(),
        end_at: newOngoing ? null : (newEndAt ? new Date(newEndAt).toISOString() : null),
        geo_scope: newGeoScope.trim() || null,
        proposed_by: 'coordinator',
        status: 'proposed',
      })
      if (insertErr) throw insertErr
      setNewTitle('')
      setNewDescription('')
      setNewCategory('aesthetic_shift')
      setNewStartAt('')
      setNewEndAt('')
      setNewOngoing(false)
      setShowProposeForm(false)
      await fetchMoments()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to propose')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleConfirm(id: string, weight: number) {
    if (weight < -100 || weight > 100) {
      setError('Influence weight out of range (-100 to 100)')
      return
    }
    try {
      const { error: updErr } = await supabase
        .from('cultural_moments')
        .update({
          status: 'confirmed',
          influence_weight: weight,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', id)
      if (updErr) throw updErr
      await fetchMoments()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Confirm failed')
    }
  }

  async function handleDismiss(id: string) {
    try {
      const { error: updErr } = await supabase
        .from('cultural_moments')
        .update({ status: 'dismissed', reviewed_at: new Date().toISOString() })
        .eq('id', id)
      if (updErr) throw updErr
      await fetchMoments()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Dismiss failed')
    }
  }

  const proposed = useMemo(() => moments.filter((m) => m.status === 'proposed'), [moments])
  const confirmed = useMemo(() => moments.filter((m) => m.status === 'confirmed'), [moments])
  const dismissed = useMemo(() => moments.filter((m) => m.status === 'dismissed'), [moments])

  if (loading) return <div className="p-8"><p className="text-sage-500 text-sm">Loading…</p></div>

  return (
    <div className="p-8 max-w-5xl space-y-6">
      <header className="space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-sage-700" />
            <h1 className="font-heading text-2xl font-semibold text-sage-900">Cultural moments</h1>
          </div>
          <button
            onClick={() => setShowProposeForm(!showProposeForm)}
            className="inline-flex items-center gap-1 rounded bg-sage-100 hover:bg-sage-200 text-sage-800 text-sm px-3 py-1.5"
          >
            <Plus className="w-4 h-4" />
            {showProposeForm ? 'Cancel' : 'Propose moment'}
          </button>
        </div>
        <p className="text-sm text-sage-600 max-w-2xl">
          Cultural moments are time-bounded events that materially shift
          wedding-related discretionary behaviour — celebrity weddings,
          aesthetic shifts (cottagecore, dark academia), generational
          milestones, breaking industry news. AI proposes; coordinator
          confirms with an influence weight before they enter the
          correlation engine&apos;s External Context.
        </p>
      </header>

      {error && (
        <div className="flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {showProposeForm && (
        <form onSubmit={handlePropose} className="rounded-lg border border-sage-200 bg-white p-4 space-y-3">
          <h2 className="font-medium text-sage-900">Propose a moment</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-sage-600">Title</label>
              <input
                type="text"
                required
                placeholder="Royal Wedding 2026 / Cottagecore peak / etc."
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                className="mt-1 w-full rounded border border-sage-200 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-sage-600">Category</label>
              <select
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                className="mt-1 w-full rounded border border-sage-200 px-3 py-2 text-sm"
              >
                {CATEGORY_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-sage-600">Start date</label>
              <input
                type="date"
                required
                value={newStartAt}
                onChange={(e) => setNewStartAt(e.target.value)}
                className="mt-1 w-full rounded border border-sage-200 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-sage-600">End date {newOngoing && <span className="text-sage-400">(ongoing)</span>}</label>
              <input
                type="date"
                disabled={newOngoing}
                value={newEndAt}
                onChange={(e) => setNewEndAt(e.target.value)}
                className="mt-1 w-full rounded border border-sage-200 px-3 py-2 text-sm disabled:bg-sage-50 disabled:text-sage-400"
              />
              <label className="mt-1 flex items-center gap-1 text-xs text-sage-600">
                <input type="checkbox" checked={newOngoing} onChange={(e) => setNewOngoing(e.target.checked)} />
                Ongoing (no known end yet)
              </label>
            </div>
            <div>
              <label className="text-xs text-sage-600">Geo scope</label>
              <input
                type="text"
                placeholder="us / us_va / us_va_culpeper"
                value={newGeoScope}
                onChange={(e) => setNewGeoScope(e.target.value)}
                className="mt-1 w-full rounded border border-sage-200 px-3 py-2 text-sm font-mono"
              />
            </div>
          </div>
          <div>
            <label className="text-xs text-sage-600">Description (why this is a moment)</label>
            <textarea
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded border border-sage-200 px-3 py-2 text-sm resize-none"
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-1 rounded bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white text-sm font-medium px-3 py-1.5"
          >
            {submitting ? 'Proposing…' : 'Propose'}
          </button>
        </form>
      )}

      <Section
        title="Proposed (review queue)"
        icon={<Clock className="w-4 h-4 text-amber-600" />}
        rows={proposed}
        onConfirm={handleConfirm}
        onDismiss={handleDismiss}
        showActions
        emptyMessage="No moments awaiting review."
      />
      <Section
        title="Confirmed (in correlation engine)"
        icon={<CheckCircle2 className="w-4 h-4 text-emerald-600" />}
        rows={confirmed}
        onConfirm={handleConfirm}
        onDismiss={handleDismiss}
        showWeight
        emptyMessage="No confirmed moments yet."
      />
      <Section
        title="Dismissed"
        icon={<XCircle className="w-4 h-4 text-sage-400" />}
        rows={dismissed.slice(0, 20)}
        onConfirm={handleConfirm}
        onDismiss={handleDismiss}
        emptyMessage="No dismissed moments."
      />
    </div>
  )
}

interface SectionProps {
  title: string
  icon: React.ReactNode
  rows: Moment[]
  onConfirm: (id: string, weight: number) => void
  onDismiss: (id: string) => void
  showActions?: boolean
  showWeight?: boolean
  emptyMessage: string
}

function Section({ title, icon, rows, onConfirm, onDismiss, showActions, showWeight, emptyMessage }: SectionProps) {
  return (
    <section className="space-y-2">
      <h2 className="font-medium text-sage-900 flex items-center gap-2">
        {icon}
        {title} ({rows.length})
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-sage-500 italic">{emptyMessage}</p>
      ) : (
        <ul className="rounded-lg border border-sage-200 bg-white divide-y divide-sage-100">
          {rows.map((m) => (
            <li key={m.id} className="px-4 py-3">
              <MomentRow row={m} showActions={showActions} showWeight={showWeight} onConfirm={onConfirm} onDismiss={onDismiss} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

interface MomentRowProps {
  row: Moment
  showActions?: boolean
  showWeight?: boolean
  onConfirm: (id: string, weight: number) => void
  onDismiss: (id: string) => void
}

function MomentRow({ row, showActions, showWeight, onConfirm, onDismiss }: MomentRowProps) {
  const [weight, setWeight] = useState<string>(String(row.influence_weight ?? 0))
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-sage-900">{row.title}</span>
          {row.category && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-sage-50 text-[10px] font-medium text-sage-600 uppercase">
              {row.category.replace(/_/g, ' ')}
            </span>
          )}
          <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-sage-50 text-[10px] font-medium text-sage-500">
            proposed by {row.proposed_by}
          </span>
          {row.geo_scope && (
            <span className="font-mono text-[10px] text-sage-500">{row.geo_scope}</span>
          )}
          {showWeight && row.influence_weight !== null && (
            <span className={`font-mono text-xs ${row.influence_weight > 0 ? 'text-emerald-700' : row.influence_weight < 0 ? 'text-red-700' : 'text-sage-500'}`}>
              {row.influence_weight > 0 ? '+' : ''}{row.influence_weight}
            </span>
          )}
        </div>
        <p className="text-xs text-sage-500 mt-0.5">{formatRange(row.start_at, row.end_at)}</p>
        {row.description && <p className="text-sm text-sage-700 mt-1">{row.description}</p>}
      </div>
      {showActions && (
        <div className="flex items-center gap-1">
          <input
            type="number"
            min="-100"
            max="100"
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            className="w-16 rounded border border-sage-200 px-1.5 py-1 text-xs font-mono text-right"
            title="Influence weight (-100 to 100)"
          />
          <button
            onClick={() => onConfirm(row.id, Number(weight))}
            className="inline-flex items-center gap-1 rounded bg-sage-700 hover:bg-sage-800 text-white text-xs px-2 py-1"
          >
            <CheckCircle2 className="w-3 h-3" />
            Confirm
          </button>
          <button
            onClick={() => onDismiss(row.id)}
            className="inline-flex items-center gap-1 rounded border border-sage-200 hover:bg-sage-50 text-sage-700 text-xs px-2 py-1"
          >
            <XCircle className="w-3 h-3" />
            Dismiss
          </button>
        </div>
      )}
    </div>
  )
}
