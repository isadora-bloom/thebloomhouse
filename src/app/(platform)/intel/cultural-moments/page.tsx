'use client'

import { useState, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useSupabaseList } from '@/lib/hooks/use-supabase-list'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { useVenueScope } from '@/lib/contexts/venue-scope-context'
import {
  Sparkles,
  Plus,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Info,
  Archive,
  Wand2,
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
  // 2026-05-09: 'ai_llm' added (mig 250) for the judgement-tier Sonnet
  // proposer. Statistical proposer keeps 'ai'.
  proposed_by: 'system' | 'ai' | 'ai_llm' | 'coordinator'
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

// ---------------------------------------------------------------------------
// Stream HHH Bug 15: queue grouping by category.
//
// The propose-and-confirm queue mixed celebrity-trends with macro-
// events with platform-events with industry-news in one flat list.
// "Knot platform redesign" filed as a Cultural Moment with a
// PLATFORM EVENT badge looked miscategorised because it was sitting
// next to "Royal-adjacent celebrity wedding spike". Group them by
// the existing category field — coordinator can reason about each
// type separately without inventing new categories.
// ---------------------------------------------------------------------------

type CategoryGroup = 'cultural' | 'platform' | 'macro' | 'industry' | 'other'

interface CategoryGroupDef {
  id: CategoryGroup
  label: string
  description: string
  /** Maps from cultural_moments.category values (migration 139 CHECK). */
  categories: string[]
}

const CATEGORY_GROUPS: CategoryGroupDef[] = [
  {
    id: 'cultural',
    label: 'Cultural trends',
    description: 'Celebrity weddings, aesthetic shifts, generational milestones — the drivers of taste and timing.',
    categories: ['celebrity_wedding', 'aesthetic_shift', 'generational_milestone'],
  },
  {
    id: 'platform',
    label: 'Platform events',
    description: 'Knot redesigns, WeddingWire algorithm changes, Pinterest UI shifts — anything that moves the listing/discovery layer.',
    categories: ['platform_event'],
  },
  {
    id: 'macro',
    label: 'Macro events',
    description: 'Election cycles, market drawdowns, mortgage shifts, weather events — the discretionary-spending environment.',
    categories: ['macro_event'],
  },
  {
    id: 'industry',
    label: 'Industry news',
    description: 'Bridal-industry developments and announcements that shift coordinator-relevant context.',
    categories: ['industry_news'],
  },
  {
    id: 'other',
    label: 'Other / uncategorised',
    description: 'Moments without a category yet — categorise on confirm.',
    categories: ['other'],
  },
]

function groupForCategory(category: string | null): CategoryGroup {
  for (const grp of CATEGORY_GROUPS) {
    if (category && grp.categories.includes(category)) return grp.id
  }
  return 'other'
}

function formatRange(startIso: string, endIso: string | null): string {
  const s = new Date(startIso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  if (!endIso) return `${s} – ongoing`
  const e = new Date(endIso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  return `${s} – ${e}`
}

export default function CulturalMomentsPage() {
  const supabase = createClient()
  const venueId = useVenueId()
  // TRENDS-DIAGNOSIS Fix 2 (2026-05-09). isDemo from VenueScopeProvider
  // gates the legacy demo-seed cultural moments (`evidence.source='demo
  // seed'`). Pre-fix those 6 historical rows surfaced for every venue
  // including production tenants — the seed data was inserted globally
  // without venue scoping. We filter them at read time so non-demo
  // venues never see them, while demo venues continue to use them
  // (their `venue_cultural_moment_state` rows were backfilled by
  // migration 167).
  const { isDemo } = useVenueScope()
  const [error, setError] = useState<string | null>(null)
  const [showProposeForm, setShowProposeForm] = useState(false)
  // Stream HHH Bug 15: active category-group tab for the propose-and-
  // confirm queue. Defaults to 'cultural' (the largest bucket); the
  // tab strip below shows the count per group.
  const [activeGroup, setActiveGroup] = useState<CategoryGroup>('cultural')

  const [newTitle, setNewTitle] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newCategory, setNewCategory] = useState('aesthetic_shift')
  const [newStartAt, setNewStartAt] = useState('')
  const [newEndAt, setNewEndAt] = useState('')
  const [newGeoScope, setNewGeoScope] = useState('us')
  const [newOngoing, setNewOngoing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // TRENDS-DIAGNOSIS Fix 3 (2026-05-09). Manual-trigger button state
  // for the LLM proposer. The cron fires daily at 09:30 UTC; the button
  // POSTs to /api/intel/cultural-moments/llm-propose so a coordinator
  // can refresh the queue NOW without waiting.
  const [llmRunning, setLlmRunning] = useState(false)
  const [llmResult, setLlmResult] = useState<string | null>(null)

  // 2026-05-01 (review pass 4 follow-up): use the shared list hook.
  // 2026-05-02 (migration 167): also pull this venue's state rows so each
  // moment knows whether THIS venue confirmed/dismissed/snoozed.
  // 2026-05-09 (TRENDS-DIAGNOSIS Fix 1 follow-up): the demo-seed filter
  // moved DOWN to the database query. Pre-fix the client-side memo
  // filter passed `evidence.source` through an `as Record<...> | null`
  // cast that silently fell to `undefined?.source` when supabase-js
  // serialised jsonb as something other than a plain object on the
  // first paint, and the 6 fictional 2025 moments leaked into the
  // queue for production tenants. Filtering at the PostgREST level
  // with `evidence->>source` removes the entire class of client-side
  // race conditions: the row never reaches the bucket logic to begin
  // with. Demo callers (`isDemo === true`) skip the filter so the
  // Hawthorne demo continues to surface the 6 seeded moments.
  const fetcher = useCallback(async (): Promise<Moment[]> => {
    let momentsQuery = supabase
      .from('cultural_moments')
      .select('id, status, title, description, start_at, end_at, category, evidence, influence_weight, geo_scope, proposed_by, reviewed_at, created_at')
      .neq('status', 'archived')
      .order('created_at', { ascending: false })
      .limit(200)
    // Server-side scope of the demo-seed jsonb tag for non-demo
    // callers. The `evidence->>source` operator returns the inner
    // text value of the `source` key (or NULL when the key is
    // absent), and `.not(..., 'eq', 'demo seed')` keeps the row
    // when the value is null too — which is what we want, since
    // real moments either have no evidence.source or set it to
    // something like 'serpapi_trends' / 'sonnet_proposal'.
    if (!isDemo) {
      momentsQuery = momentsQuery.not('evidence->>source', 'eq', 'demo seed')
    }
    const [{ data: momentRows, error: momentErr }, { data: stateRows, error: stateErr }] =
      await Promise.all([
        momentsQuery,
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
  }, [supabase, venueId, isDemo])

  // Refetch when isDemo flips so a demo→real handoff (e.g. bloom_demo
  // cookie cleared mid-session) re-runs the server-side scoping query
  // instead of leaving the previous fetch's rows in memory.
  const {
    rows: moments,
    loading,
    error: loadError,
    reload: fetchMoments,
  } = useSupabaseList<Moment>(fetcher, [venueId, isDemo])
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
      setError('Impact score must be between -100 and +100.')
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
  //                      AND end_at >= now()
  //   - past           → no venue_state row + end_at < now() (history)
  //   - venueConfirmed → this venue's correlation engine reads it
  //   - venueDismissed → this venue ignores it
  //
  // TRENDS-DIAGNOSIS Fix 1 (2026-05-09). Pre-fix the awaiting bucket
  // included rows whose end_at was already in the past. The cron sub-
  // step archive_expired_moments now flips those to status='archived'
  // daily, but we filter at read time too as a safety net so a fresh
  // page load before the next cron run still shows a clean queue.
  // Past moments render in the "Past moments (archive)" section
  // collapsed by default — they're history, not actionable, but
  // available for audit.
  //
  // TRENDS-DIAGNOSIS Fix 2 (2026-05-09). Demo-seed rows (evidence.source
  // === 'demo seed') only render for demo callers. Production tenants
  // never see the legacy fictional moments.
  const nowMs = useMemo(() => Date.now(), [])
  const visibleMoments = useMemo(() => {
    return moments.filter((m) => {
      const src = (m.evidence as Record<string, unknown> | null)?.source
      if (src === 'demo seed' && !isDemo) return false
      return true
    })
  }, [moments, isDemo])

  function isExpired(m: Moment): boolean {
    if (!m.end_at) return false
    const endMs = new Date(m.end_at).getTime()
    return Number.isFinite(endMs) && endMs < nowMs
  }

  const awaiting = useMemo(
    () =>
      visibleMoments.filter(
        (m) =>
          m.venue_state === null &&
          m.status !== 'dismissed' &&
          !isExpired(m),
      ),
    [visibleMoments, nowMs],
  )
  const past = useMemo(
    () =>
      visibleMoments.filter(
        (m) => m.venue_state === null && m.status !== 'dismissed' && isExpired(m),
      ),
    [visibleMoments, nowMs],
  )
  const venueConfirmed = useMemo(
    () => visibleMoments.filter((m) => m.venue_state === 'confirmed'),
    [visibleMoments],
  )
  const venueDismissed = useMemo(
    () => visibleMoments.filter((m) => m.venue_state === 'dismissed'),
    [visibleMoments],
  )

  // Stream HHH Bug 15: per-group counts for the awaiting tab strip.
  const awaitingByGroup = useMemo(() => {
    const map = new Map<CategoryGroup, Moment[]>()
    for (const grp of CATEGORY_GROUPS) map.set(grp.id, [])
    for (const m of awaiting) {
      const g = groupForCategory(m.category)
      map.get(g)!.push(m)
    }
    return map
  }, [awaiting])

  // TRENDS-DIAGNOSIS Fix 3 (2026-05-09). Manual run of the LLM
  // proposer. POSTs to /api/intel/cultural-moments/llm-propose with
  // default scope=venue (caller's venue only). Refreshes the queue
  // on success so newly proposed moments surface immediately.
  async function handleRunLlmProposer() {
    if (llmRunning) return
    setLlmRunning(true)
    setLlmResult(null)
    setError(null)
    try {
      const res = await fetch('/api/intel/cultural-moments/llm-propose', {
        method: 'POST',
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `LLM proposer failed (${res.status})`)
      }
      const body = (await res.json()) as {
        momentsProposed: number
        momentsDeduped: number
        sampleTitles: string[]
        errors: number
      }
      const parts: string[] = []
      if (body.momentsProposed > 0) {
        parts.push(`${body.momentsProposed} new ${body.momentsProposed === 1 ? 'moment' : 'moments'} proposed`)
      } else {
        parts.push('No new moments proposed')
      }
      if (body.momentsDeduped > 0) parts.push(`${body.momentsDeduped} deduped`)
      if (body.errors > 0) parts.push(`${body.errors} ${body.errors === 1 ? 'error' : 'errors'}`)
      const summary = parts.join(', ') + '. Refreshing queue.'
      setLlmResult(summary)
      await fetchMoments()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'LLM proposer failed')
    } finally {
      setLlmRunning(false)
    }
  }

  const activeGroupRows = awaitingByGroup.get(activeGroup) ?? []
  const activeGroupDef = CATEGORY_GROUPS.find((g) => g.id === activeGroup) ?? CATEGORY_GROUPS[0]!

  if (loading) return <div className="p-8"><p className="text-sage-500 text-sm">Loading…</p></div>

  return (
    <div className="p-8 max-w-5xl space-y-6">
      <header className="space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-sage-700" />
            <h1 className="font-heading text-2xl font-semibold text-sage-900">Cultural moments</h1>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* TRENDS-DIAGNOSIS Fix 3 (2026-05-09). Manual trigger for
                the LLM proposer. The cron fires daily at 09:30 UTC; this
                button POSTs to /api/intel/cultural-moments/llm-propose
                so a coordinator can refresh the queue NOW. Sonnet call,
                cost-ceiling gated per-venue inside the service. */}
            <button
              onClick={handleRunLlmProposer}
              disabled={llmRunning}
              className="inline-flex items-center gap-1 rounded bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white text-sm px-3 py-1.5"
              title="Run the AI proposer now. The cron normally fires once daily at 09:30 UTC."
            >
              <Wand2 className="w-4 h-4" />
              {llmRunning ? 'Running…' : 'Run LLM proposer now'}
            </button>
            <button
              onClick={() => setShowProposeForm(!showProposeForm)}
              className="inline-flex items-center gap-1 rounded bg-sage-100 hover:bg-sage-200 text-sage-800 text-sm px-3 py-1.5"
            >
              <Plus className="w-4 h-4" />
              {showProposeForm ? 'Cancel' : 'Propose moment'}
            </button>
          </div>
        </div>
        <p className="text-sm text-sage-600 max-w-2xl">
          Trends and cultural moments that affect wedding inquiries.
          Confirm the ones you see showing up in your bookings (a
          celebrity wedding, a viral aesthetic, a major news cycle), and
          the platform learns to weight your decisions when forecasting
          future demand. Dismiss anything that doesn&apos;t move your
          calendar.
        </p>
      </header>

      {displayError && (
        <div className="flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4 mt-0.5" />
          <span>{displayError}</span>
        </div>
      )}

      {/* TRENDS-DIAGNOSIS Fix 3 (2026-05-09). Toast for LLM proposer
          result. Persists until the next run / manual dismiss so the
          coordinator can read it after the queue refresh. */}
      {llmResult && (
        <div className="flex items-start justify-between gap-2 rounded-md bg-sage-50 border border-sage-200 px-3 py-2 text-sm text-sage-800">
          <div className="flex items-start gap-2">
            <Wand2 className="w-4 h-4 mt-0.5 text-sage-600" />
            <span>{llmResult}</span>
          </div>
          <button
            onClick={() => setLlmResult(null)}
            className="text-sage-500 hover:text-sage-700 text-xs"
            aria-label="Dismiss"
          >
            <XCircle className="w-3.5 h-3.5" />
          </button>
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
              <label className="text-xs text-sage-600">Region</label>
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

      {/* Stream HHH Bug 14: visible legend for the Impact (-100 to +100)
          score so coordinators stop seeing it as an unlabeled magic
          number. Renders once at the top so every section that shows
          a score inherits the meaning. */}
      <div className="rounded-md bg-sage-50/60 border border-sage-100 px-3 py-2 text-xs text-sage-700 flex items-start gap-2">
        <Info className="w-3.5 h-3.5 mt-0.5 text-sage-500 shrink-0" />
        <p>
          <strong className="text-sage-800">Impact score (-100 to +100).</strong>{' '}
          Positive values mean the moment <em>lifts</em> wedding inquiries; negative
          values mean it <em>drags</em> them down. Range: -100 (strong negative) to
          +100 (strong positive). Set the score when you confirm a moment.
        </p>
      </div>

      {/* Stream HHH Bug 15: awaiting queue split into category-group
          tabs (Cultural / Platform / Macro / Industry / Other) so the
          coordinator can reason about each type separately instead of
          scrolling a flat list mixing celebrity weddings with Knot
          redesigns with mortgage shifts. */}
      <section className="space-y-2">
        <h2 className="font-medium text-sage-900 flex items-center gap-2">
          <Clock className="w-4 h-4 text-amber-600" />
          Awaiting your decision ({awaiting.length})
        </h2>
        {/* Tab strip */}
        <div className="flex items-center gap-1 flex-wrap border-b border-sage-100">
          {CATEGORY_GROUPS.map((g) => {
            const count = awaitingByGroup.get(g.id)?.length ?? 0
            const active = activeGroup === g.id
            return (
              <button
                key={g.id}
                onClick={() => setActiveGroup(g.id)}
                className={`px-3 py-1.5 text-sm border-b-2 transition-colors -mb-px ${
                  active
                    ? 'border-sage-700 text-sage-900 font-medium'
                    : 'border-transparent text-sage-500 hover:text-sage-700'
                }`}
              >
                {g.label}
                <span className={`ml-1.5 text-[11px] ${active ? 'text-sage-600' : 'text-sage-400'}`}>
                  ({count})
                </span>
              </button>
            )
          })}
        </div>
        <p className="text-xs text-sage-500 italic">{activeGroupDef.description}</p>
        {activeGroupRows.length === 0 ? (
          <p className="text-sm text-sage-500 italic">No moments in this group awaiting your decision.</p>
        ) : (
          <ul className="rounded-lg border border-sage-200 bg-white divide-y divide-sage-100">
            {activeGroupRows.map((m) => (
              <li key={m.id} className="px-4 py-3">
                <MomentRow row={m} showActions onConfirm={handleConfirm} onDismiss={handleDismiss} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <Section
        title="Confirmed by your venue (factored into forecasts)"
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
      {/* TRENDS-DIAGNOSIS Fix 1 (2026-05-09). Past moments (archive).
          Rows whose end_at < now() are filtered out of the awaiting
          bucket because they cannot affect future bookings. Surfacing
          them here keeps the audit trail intact: a coordinator can
          still see what was proposed but expired before they made a
          decision. The daily archive_expired sub-step in the cron
          flips status='archived' (and stamps archive_reason='expired'
          + an evidence audit trail), at which point they leave this
          list — but until the next cron tick fires, this is the
          read-time safety net. */}
      <PastMomentsSection rows={past.slice(0, 20)} />
    </div>
  )
}

interface PastMomentsSectionProps {
  rows: Moment[]
}

function PastMomentsSection({ rows }: PastMomentsSectionProps) {
  const [expanded, setExpanded] = useState(false)
  if (rows.length === 0) return null
  return (
    <section className="space-y-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-sm font-medium text-sage-600 hover:text-sage-900"
      >
        <Archive className="w-4 h-4" />
        <span>
          Past moments (archive){' '}
          <span className="text-sage-400 font-normal">({rows.length})</span>
        </span>
        <span className="text-xs text-sage-400">{expanded ? 'hide' : 'show'}</span>
      </button>
      {expanded && (
        <ul className="rounded-lg border border-sage-200 bg-sage-50/30 divide-y divide-sage-100">
          {rows.map((m) => (
            <li key={m.id} className="px-4 py-3 opacity-75">
              <PastMomentRow row={m} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function PastMomentRow({ row }: { row: Moment }) {
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-sage-700 line-through decoration-sage-300">
            {row.title}
          </span>
          {row.category && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-sage-50 text-[10px] font-medium text-sage-500 uppercase">
              {row.category.replace(/_/g, ' ')}
            </span>
          )}
          <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-sage-100 text-[10px] font-medium text-sage-600 uppercase">
            expired
          </span>
        </div>
        <p className="text-xs text-sage-500 mt-0.5">{formatRange(row.start_at, row.end_at)}</p>
      </div>
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
          <span
            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
              row.proposed_by === 'ai_llm'
                ? 'bg-violet-50 text-violet-700'
                : 'bg-sage-50 text-sage-500'
            }`}
            title={
              row.proposed_by === 'ai_llm'
                ? 'Proposed by the LLM proposer (judgement-tier Sonnet, names cultural events with evidence URLs).'
                : row.proposed_by === 'ai'
                  ? 'Proposed by the statistical detector (search-trend z-score spikes).'
                  : `Proposed by ${row.proposed_by}.`
            }
          >
            proposed by {row.proposed_by === 'ai_llm' ? 'AI (LLM)' : row.proposed_by}
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
          {/* Stream HHH Bug 14: explicit "Impact +35" rendering with
              sign + bracket so the score is never a floating bare
              number. Coordinator can read it without the legend. */}
          {showWeight && row.influence_weight !== null && (
            <span
              className={`inline-flex items-center px-1.5 py-0.5 rounded font-mono text-xs ${
                row.influence_weight > 0
                  ? 'bg-emerald-50 text-emerald-700'
                  : row.influence_weight < 0
                    ? 'bg-red-50 text-red-700'
                    : 'bg-sage-50 text-sage-500'
              }`}
              title={`Impact score: ${row.influence_weight > 0 ? '+' : ''}${row.influence_weight} on a -100 to +100 scale.`}
            >
              Impact {row.influence_weight > 0 ? '+' : ''}{row.influence_weight}
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
        <div className="flex items-end gap-1">
          {/* Stream HHH Bug 14: explicit field label + range on the
              score input. The input itself was previously labelled
              only via title-attribute; now the (-100 to +100) range
              is visible at all times. */}
          <label className="flex flex-col items-end text-[10px] text-sage-500">
            <span className="leading-none">Impact (-100 to +100)</span>
            <input
              type="number"
              min="-100"
              max="100"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              className="w-20 mt-0.5 rounded border border-sage-200 px-1.5 py-1 text-xs font-mono text-right"
              title="Impact score: positive values mean the moment lifts wedding inquiries; negative values mean it drags them down. Range: -100 (strong negative) to +100 (strong positive)."
            />
          </label>
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
