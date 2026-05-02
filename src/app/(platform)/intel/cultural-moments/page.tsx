'use client'

import { useState, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useSupabaseList } from '@/lib/hooks/use-supabase-list'
import { useVenueId } from '@/lib/hooks/use-venue-id'
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
// Migration 167 (2026-05-02): cultural_moments is GLOBAL but each venue
// confirms/dismisses INDEPENDENTLY in venue_cultural_moment_state. The
// queue surfaces:
//   - "Awaiting your decision" — proposed globally (or other venues
//     decided but you haven't yet)
//   - "Confirmed by your venue" — your venue's correlation engine reads it
//   - "Dismissed by your venue" — your venue ignores it
// The cultural_moments.status column is the GLOBAL rollup ("any venue
// confirmed once") and shows up as a small pill, not the source of truth.
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
  // Per-venue state — null when this venue hasn't decided.
  venue_state: 'confirmed' | 'dismissed' | 'snoozed' | null
  venue_decided_at: string | null
  venue_note: string | null
}

interface VenueStateRow {
  cultural_moment_id: string
  state: 'confirmed' | 'dismissed' | 'snoozed'
  decided_at: string
  note: string | null
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
  const venueId = useVenueId()
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

  // 2026-05-01 (review pass 4 follow-up): use the shared list hook.
  // 2026-05-02 (migration 167): also pull this venue's state rows so each
  // moment knows whether THIS venue confirmed/dismissed/snoozed.
  const fetcher = useCallback(async (): Promise<Moment[]> => {
    const [{ data: momentRows, error: momentErr }, { data: stateRows, error: stateErr }] =
      await Promise.all([
        supabase
          .from('cultural_moments')
          .select('id, status, title, description, start_at, end_at, category, evidence, influence_weight, geo_scope, proposed_by, reviewed_at, created_at')
          .neq('status', 'archived')
          .order('created_at', { ascending: false })
          .limit(200),
        supabase
          .from('venue_cultural_moment_state')
          .select('cultural_moment_id, state, decided_at, note')
          .eq('venue_id', venueId),
      ])
    if (momentErr) throw momentErr
    if (stateErr) throw stateErr
    const stateById = new Map<string, VenueStateRow>()
    for (const row of (stateRows ?? []) as VenueStateRow[]) {
      stateById.set(row.cultural_moment_id, row)
    }
    return ((momentRows ?? []) as Omit<Moment, 'venue_state' | 'venue_decided_at' | 'venue_note'>[]).map((r) => {
      const s = stateById.get(r.id)
      return {
        ...r,
        venue_state: s?.state ?? null,
        venue_decided_at: s?.decided_at ?? null,
        venue_note: s?.note ?? null,
      }
    })
  }, [supabase, venueId])

  const {
    rows: moments,
    loading,
    error: loadError,
    reload: fetchMoments,
  } = useSupabaseList<Moment>(fetcher, [])
  const displayError = error ?? loadError

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

  // Migration 167: per-venue confirm. Upserts the per-venue decision
  // and ALSO bumps the global cultural_moments.status to 'confirmed' so
  // the admin-summary view shows "at least one venue elevated this."
  // influence_weight remains a single global field (last-write-wins);
  // a future migration can split it per-venue if real conflicts emerge.
  async function handleConfirm(id: string, weight: number) {
    if (weight < -100 || weight > 100) {
      setError('Influence weight out of range (-100 to 100)')
      return
    }
    try {
      const decidedAt = new Date().toISOString()
      const { error: stateErr } = await supabase
        .from('venue_cultural_moment_state')
        .upsert(
          {
            venue_id: venueId,
            cultural_moment_id: id,
            state: 'confirmed',
            decided_at: decidedAt,
          },
          { onConflict: 'venue_id,cultural_moment_id' },
        )
      if (stateErr) throw stateErr
      const { error: globalErr } = await supabase
        .from('cultural_moments')
        .update({
          status: 'confirmed',
          influence_weight: weight,
          reviewed_at: decidedAt,
        })
        .eq('id', id)
      if (globalErr) throw globalErr
      await fetchMoments()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Confirm failed')
    }
  }

  // Migration 167: per-venue dismiss. Does NOT mutate the global
  // cultural_moments.status — other venues may still want to use the
  // moment. (Global archival when ALL venues dismiss is a separate
  // admin path; out of scope.)
  async function handleDismiss(id: string) {
    try {
      const { error: stateErr } = await supabase
        .from('venue_cultural_moment_state')
        .upsert(
          {
            venue_id: venueId,
            cultural_moment_id: id,
            state: 'dismissed',
            decided_at: new Date().toISOString(),
          },
          { onConflict: 'venue_id,cultural_moment_id' },
        )
      if (stateErr) throw stateErr
      await fetchMoments()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Dismiss failed')
    }
  }

  // Bucket by per-venue decision, falling back to global lifecycle for
  // the "awaiting your decision" pile. Migration 167.
  //   - awaiting       → no venue_state row + global status != dismissed
  //                      (covers "proposed globally", "another venue
  //                      confirmed but you haven't decided", etc.)
  //   - venueConfirmed → this venue's correlation engine reads it
  //   - venueDismissed → this venue ignores it
  const awaiting = useMemo(
    () => moments.filter((m) => m.venue_state === null && m.status !== 'dismissed'),
    [moments],
  )
  const venueConfirmed = useMemo(
    () => moments.filter((m) => m.venue_state === 'confirmed'),
    [moments],
  )
  const venueDismissed = useMemo(
    () => moments.filter((m) => m.venue_state === 'dismissed'),
    [moments],
  )

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

      {displayError && (
        <div className="flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4 mt-0.5" />
          <span>{displayError}</span>
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
        title="Awaiting your decision"
        icon={<Clock className="w-4 h-4 text-amber-600" />}
        rows={awaiting}
        onConfirm={handleConfirm}
        onDismiss={handleDismiss}
        showActions
        emptyMessage="No moments awaiting your decision."
      />
      <Section
        title="Confirmed by your venue (in correlation engine)"
        icon={<CheckCircle2 className="w-4 h-4 text-emerald-600" />}
        rows={venueConfirmed}
        onConfirm={handleConfirm}
        onDismiss={handleDismiss}
        showWeight
        showActions
        emptyMessage="Your venue has not confirmed any moments yet."
      />
      <Section
        title="Dismissed by your venue"
        icon={<XCircle className="w-4 h-4 text-sage-400" />}
        rows={venueDismissed.slice(0, 20)}
        onConfirm={handleConfirm}
        onDismiss={handleDismiss}
        showActions
        emptyMessage="Your venue has not dismissed any moments."
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
  // Migration 167: a moment is "globally proposed" when no venue has
  // confirmed yet (cultural_moments.status === 'proposed'). Once any
  // venue confirms, the global status flips to 'confirmed' even though
  // YOUR venue may not have decided yet — that's the "other venues
  // confirmed but you haven't" case.
  const otherVenueConfirmed = row.status === 'confirmed' && row.venue_state === null
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
          {/* Migration 167: explicit per-venue vs global pill so the
              coordinator immediately sees whose decision this is. */}
          {row.venue_state === 'confirmed' && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-emerald-50 text-[10px] font-medium text-emerald-700 uppercase">
              your venue confirmed
            </span>
          )}
          {row.venue_state === 'dismissed' && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-rose-50 text-[10px] font-medium text-rose-700 uppercase">
              your venue dismissed
            </span>
          )}
          {row.venue_state === 'snoozed' && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-amber-50 text-[10px] font-medium text-amber-700 uppercase">
              snoozed
            </span>
          )}
          {row.venue_state === null && row.status === 'proposed' && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-sky-50 text-[10px] font-medium text-sky-700 uppercase">
              globally proposed
            </span>
          )}
          {otherVenueConfirmed && (
            <span
              className="inline-flex items-center px-1.5 py-0.5 rounded bg-violet-50 text-[10px] font-medium text-violet-700 uppercase"
              title="Another venue has confirmed this moment. Decide for yours."
            >
              other venues confirmed — decide for yours
            </span>
          )}
          {showWeight && row.influence_weight !== null && (
            <span className={`font-mono text-xs ${row.influence_weight > 0 ? 'text-emerald-700' : row.influence_weight < 0 ? 'text-red-700' : 'text-sage-500'}`}>
              {row.influence_weight > 0 ? '+' : ''}{row.influence_weight}
            </span>
          )}
        </div>
        <p className="text-xs text-sage-500 mt-0.5">{formatRange(row.start_at, row.end_at)}</p>
        {row.description && <p className="text-sm text-sage-700 mt-1">{row.description}</p>}
        {row.venue_note && (
          <p className="text-xs text-sage-500 mt-1 italic">Note: {row.venue_note}</p>
        )}
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
