'use client'

/**
 * Candidate review queue (Phase B / PB.6 + PB.10).
 *
 * Three sections:
 *   1. Needs review — candidates the resolver couldn't auto-link.
 *      Either landed in the 14-30d cluster zone or sat at Tier 2
 *      with multiple wedding matches (AI deferred). Coordinator
 *      manually links or dismisses.
 *   2. Conflicts — attribution_events where the legacy
 *      weddings.source disagrees with the computed first-touch.
 *      Coordinator picks which is right.
 *   3. Recent attributions — last 50 auto-decided attributions
 *      across the venue, for audit + trust-building.
 */

import { useEffect, useState } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import {
  CheckCircle2, XCircle, AlertTriangle, Sparkles, Search,
  Activity, ArrowRight, RotateCcw,
} from 'lucide-react'
import { useVenueId } from '@/lib/hooks/use-venue-id'

function getSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}

interface CandidateRow {
  id: string
  source_platform: string
  first_name: string | null
  last_initial: string | null
  last_name: string | null
  state: string | null
  signal_count: number
  funnel_depth: number
  action_counts: Record<string, number> | null
  first_seen: string | null
  last_seen: string | null
  review_status: string
  cluster_group_key: string | null
}

interface AttributionRow {
  id: string
  candidate_identity_id: string
  wedding_id: string
  source_platform: string
  confidence: number
  tier: string
  decided_by: string
  decided_at: string
  reasoning: string | null
  is_first_touch: boolean
  conflict_with_legacy_source: string | null
}

interface WeddingRow {
  id: string
  source: string | null
  status: string | null
  inquiry_date: string | null
  first_name: string | null
  last_name: string | null
}

type Tab = 'needs_review' | 'conflicts' | 'recent'

function platformLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function fmtDate(d: string | null): string {
  if (!d) return '—'
  // UTC formatting — all coordinators see the same calendar day for
  // day-precision vendor signals regardless of local timezone.
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

export default function CandidatesReviewPage() {
  const venueId = useVenueId()
  const [tab, setTab] = useState<Tab>('needs_review')
  const [needsReview, setNeedsReview] = useState<CandidateRow[]>([])
  const [conflicts, setConflicts] = useState<Array<AttributionRow & { wedding: WeddingRow | null; candidate: CandidateRow | null }>>([])
  const [recent, setRecent] = useState<Array<AttributionRow & { wedding: WeddingRow | null; candidate: CandidateRow | null }>>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!venueId) return
    let cancelled = false
    const sb = getSupabase()
    ;(async () => {
      setLoading(true)
      const [reviewRes, conflictRes, recentRes] = await Promise.all([
        sb
          .from('candidate_identities')
          .select('*')
          .eq('venue_id', venueId)
          .eq('review_status', 'needs_review')
          .is('deleted_at', null)
          .is('resolved_wedding_id', null)
          .order('last_seen', { ascending: false }),
        sb
          .from('attribution_events')
          .select('*')
          .eq('venue_id', venueId)
          .not('conflict_with_legacy_source', 'is', null)
          .is('reverted_at', null)
          .order('decided_at', { ascending: false }),
        sb
          .from('attribution_events')
          .select('*')
          .eq('venue_id', venueId)
          .is('reverted_at', null)
          .order('decided_at', { ascending: false })
          .limit(50),
      ])
      if (cancelled) return

      const review = (reviewRes.data ?? []) as CandidateRow[]
      const conf = (conflictRes.data ?? []) as AttributionRow[]
      const rec = (recentRes.data ?? []) as AttributionRow[]

      const candIds = new Set<string>([...conf.map((r) => r.candidate_identity_id), ...rec.map((r) => r.candidate_identity_id)])
      const weddingIds = new Set<string>([...conf.map((r) => r.wedding_id), ...rec.map((r) => r.wedding_id)])

      const [candRes, wedRes, peopleRes] = await Promise.all([
        candIds.size > 0
          ? sb.from('candidate_identities').select('*').in('id', Array.from(candIds))
          : Promise.resolve({ data: [] }),
        weddingIds.size > 0
          ? sb.from('weddings').select('id, source, status, inquiry_date').in('id', Array.from(weddingIds))
          : Promise.resolve({ data: [] }),
        weddingIds.size > 0
          ? sb.from('people').select('wedding_id, first_name, last_name').in('wedding_id', Array.from(weddingIds))
          : Promise.resolve({ data: [] }),
      ])

      const candMap = new Map<string, CandidateRow>(
        ((candRes.data ?? []) as CandidateRow[]).map((c) => [c.id, c]),
      )
      const peopleByWedding = new Map<string, { first_name: string | null; last_name: string | null }>()
      for (const p of (peopleRes.data ?? []) as Array<{ wedding_id: string; first_name: string | null; last_name: string | null }>) {
        if (!peopleByWedding.has(p.wedding_id)) peopleByWedding.set(p.wedding_id, { first_name: p.first_name, last_name: p.last_name })
      }
      const wedMap = new Map<string, WeddingRow>()
      for (const w of (wedRes.data ?? []) as Omit<WeddingRow, 'first_name' | 'last_name'>[]) {
        const p = peopleByWedding.get(w.id)
        wedMap.set(w.id, { ...w, first_name: p?.first_name ?? null, last_name: p?.last_name ?? null })
      }

      const enrich = (r: AttributionRow) => ({
        ...r,
        wedding: wedMap.get(r.wedding_id) ?? null,
        candidate: candMap.get(r.candidate_identity_id) ?? null,
      })

      setNeedsReview(review)
      setConflicts(conf.map(enrich))
      setRecent(rec.map(enrich))
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [venueId])

  async function dismissCandidate(id: string) {
    if (!confirm('Dismiss this candidate? Marks reviewed; signals stay attached.')) return
    const sb = getSupabase()
    await sb.from('candidate_identities').update({ review_status: 'reviewed' }).eq('id', id)
    setNeedsReview((prev) => prev.filter((c) => c.id !== id))
  }

  async function linkCandidateToWedding(candidateId: string, weddingId: string) {
    // Manual link from the review queue. Writes attribution_events for
    // every signal attached to the candidate, marks candidate resolved,
    // and recomputes first-touch on the wedding.
    const sb = getSupabase()
    const res = await fetch('/api/intel/candidates/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidate_identity_id: candidateId, wedding_id: weddingId }),
    })
    if (!res.ok) {
      alert('Link failed.')
      return
    }
    setNeedsReview((prev) => prev.filter((c) => c.id !== candidateId))
    void sb // suppress unused warning
  }

  async function revertAttribution(eventId: string, asAcceptLegacy = false) {
    const msg = asAcceptLegacy
      ? 'Keep legacy source? Reverts the attribution row; first-touch is recomputed.'
      : 'Revert this attribution? Stays in audit trail; first-touch is recomputed.'
    if (!confirm(msg)) return
    const res = await fetch('/api/intel/attribution', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: asAcceptLegacy ? 'accept_legacy' : 'revert',
        attribution_event_id: eventId,
      }),
    })
    if (!res.ok) {
      alert('Revert failed.')
      return
    }
    setConflicts((prev) => prev.filter((e) => e.id !== eventId))
    setRecent((prev) => prev.filter((e) => e.id !== eventId))
  }

  async function acceptComputed(eventId: string) {
    if (!confirm('Overwrite leads.source with the computed platform? Clears this conflict.')) return
    const res = await fetch('/api/intel/attribution', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'accept_computed', attribution_event_id: eventId }),
    })
    if (!res.ok) {
      alert('Update failed.')
      return
    }
    setConflicts((prev) => prev.filter((e) => e.id !== eventId))
  }

  if (!venueId) return null

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold text-sage-900 mb-1">Candidate review</h1>
        <p className="text-sm text-sage-500">
          Platform-signal candidates that need a human decision, attribution conflicts, and recent auto-matches.
        </p>
      </div>

      <div className="flex gap-1 border-b border-sage-100">
        <TabBtn active={tab === 'needs_review'} onClick={() => setTab('needs_review')} count={needsReview.length}>
          Needs review
        </TabBtn>
        <TabBtn active={tab === 'conflicts'} onClick={() => setTab('conflicts')} count={conflicts.length}>
          Conflicts
        </TabBtn>
        <TabBtn active={tab === 'recent'} onClick={() => setTab('recent')} count={recent.length}>
          Recent matches
        </TabBtn>
      </div>

      {loading ? (
        <p className="text-sm text-sage-500">Loading…</p>
      ) : tab === 'needs_review' ? (
        needsReview.length === 0 ? (
          <EmptyState icon={CheckCircle2} text="Inbox zero. No candidates waiting on you." />
        ) : (
          <div className="space-y-3">
            {needsReview.map((c) => (
              <NeedsReviewCard
                key={c.id}
                candidate={c}
                venueId={venueId}
                onDismiss={() => dismissCandidate(c.id)}
                onLink={(weddingId) => linkCandidateToWedding(c.id, weddingId)}
              />
            ))}
          </div>
        )
      ) : tab === 'conflicts' ? (
        conflicts.length === 0 ? (
          <EmptyState icon={CheckCircle2} text="No source conflicts. Auto-attribution agrees with legacy source on every lead." />
        ) : (
          <div className="space-y-3">
            {conflicts.map((e) => (
              <ConflictCard
                key={e.id}
                event={e}
                onAcceptComputed={() => acceptComputed(e.id)}
                onAcceptLegacy={() => revertAttribution(e.id, true)}
              />
            ))}
          </div>
        )
      ) : (
        recent.length === 0 ? (
          <EmptyState icon={Activity} text="No attributions yet. Re-run an import to see them appear." />
        ) : (
          <div className="space-y-2">
            {recent.map((e) => (
              <RecentCard key={e.id} event={e} onRevert={() => revertAttribution(e.id)} />
            ))}
          </div>
        )
      )}
    </div>
  )
}

function TabBtn({ active, onClick, count, children }: { active: boolean; onClick: () => void; count: number; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
        active ? 'border-sage-600 text-sage-900' : 'border-transparent text-sage-500 hover:text-sage-700'
      }`}
    >
      {children}
      {count > 0 && <span className="ml-2 px-1.5 py-0.5 text-xs rounded-full bg-sage-100 text-sage-700">{count}</span>}
    </button>
  )
}

function EmptyState({ icon: Icon, text }: { icon: typeof CheckCircle2; text: string }) {
  return (
    <div className="bg-surface border border-border rounded-xl p-10 text-center">
      <Icon className="w-10 h-10 text-sage-300 mx-auto mb-3" />
      <p className="text-sm text-sage-600">{text}</p>
    </div>
  )
}

function NeedsReviewCard({
  candidate,
  venueId,
  onDismiss,
  onLink,
}: {
  candidate: CandidateRow
  venueId: string
  onDismiss: () => void
  onLink: (weddingId: string) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerCandidates, setPickerCandidates] = useState<Array<{ wedding_id: string; first_name: string | null; last_name: string | null; inquiry_date: string | null; status: string | null }>>([])

  async function openPicker() {
    setPickerOpen(true)
    if (pickerCandidates.length > 0) return
    setPickerLoading(true)
    const sb = getSupabase()
    // Suggest weddings whose people share the candidate's first name.
    const { data: people } = await sb
      .from('people')
      .select('wedding_id, first_name, last_name')
      .eq('venue_id', venueId)
      .ilike('first_name', candidate.first_name ?? '')
      .not('wedding_id', 'is', null)
    const wedIds = Array.from(new Set(((people ?? []) as Array<{ wedding_id: string }>).map((p) => p.wedding_id))).slice(0, 100)
    if (wedIds.length === 0) {
      setPickerCandidates([])
      setPickerLoading(false)
      return
    }
    const { data: weddings } = await sb
      .from('weddings')
      .select('id, inquiry_date, status')
      .in('id', wedIds)
      .order('inquiry_date', { ascending: false, nullsFirst: false })
    const peopleMap = new Map<string, { first_name: string | null; last_name: string | null }>()
    for (const p of (people ?? []) as Array<{ wedding_id: string; first_name: string | null; last_name: string | null }>) {
      if (!peopleMap.has(p.wedding_id)) peopleMap.set(p.wedding_id, { first_name: p.first_name, last_name: p.last_name })
    }
    const enriched = ((weddings ?? []) as Array<{ id: string; inquiry_date: string | null; status: string | null }>).map((w) => {
      const p = peopleMap.get(w.id)
      return {
        wedding_id: w.id,
        first_name: p?.first_name ?? null,
        last_name: p?.last_name ?? null,
        inquiry_date: w.inquiry_date,
        status: w.status,
      }
    })
    setPickerCandidates(enriched)
    setPickerLoading(false)
  }

  return (
    <div className="bg-surface border border-amber-200 rounded-xl p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Sparkles className="w-4 h-4 text-amber-600" />
            <p className="text-sm font-semibold text-sage-900">
              {platformLabel(candidate.source_platform)} · {candidate.first_name} {candidate.last_initial}.
              {candidate.state && <span className="text-xs font-normal text-sage-500 ml-1">({candidate.state.toUpperCase()})</span>}
            </p>
          </div>
          <p className="text-xs text-sage-600">
            {candidate.signal_count} signals · funnel depth {candidate.funnel_depth} ·
            {' '}{fmtDate(candidate.first_seen)} → {fmtDate(candidate.last_seen)}
          </p>
          {candidate.action_counts && Object.keys(candidate.action_counts).length > 0 && (
            <p className="text-[11px] text-sage-500 mt-1">
              {Object.entries(candidate.action_counts)
                .map(([k, v]) => `${v} ${k}`)
                .join(' · ')}
            </p>
          )}
          <p className="text-xs text-amber-700 mt-2">
            {candidate.cluster_group_key
              ? 'Multiple potential matches (ambiguous) or in 14-30d cluster zone.'
              : 'Multiple potential matches (ambiguous).'}
          </p>
        </div>
        <div className="flex flex-col gap-2 shrink-0">
          <button
            onClick={openPicker}
            className="text-xs px-3 py-1.5 bg-sage-600 text-white rounded-lg hover:bg-sage-700"
          >
            Link to lead…
          </button>
          <button
            onClick={onDismiss}
            className="text-xs px-3 py-1.5 border border-sage-200 rounded-lg hover:bg-sage-50 text-sage-700"
          >
            Dismiss
          </button>
        </div>
      </div>

      {pickerOpen && (
        <div className="mt-3 pt-3 border-t border-amber-100">
          <p className="text-xs text-sage-500 mb-2">
            Leads with first name "{candidate.first_name}":
          </p>
          {pickerLoading ? (
            <p className="text-xs text-sage-500">Loading…</p>
          ) : pickerCandidates.length === 0 ? (
            <p className="text-xs text-sage-500">No matching leads. Mark dismissed if this is noise.</p>
          ) : (
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {pickerCandidates.map((p) => (
                <button
                  key={p.wedding_id}
                  onClick={() => onLink(p.wedding_id)}
                  className="w-full text-left text-xs px-2 py-1.5 border border-sage-100 rounded hover:bg-sage-50 flex items-center justify-between gap-2"
                >
                  <span className="font-medium text-sage-900 truncate">
                    {p.first_name} {p.last_name}
                  </span>
                  <span className="text-sage-500 shrink-0">
                    {p.status} · {fmtDate(p.inquiry_date)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ConflictCard({ event, onAcceptComputed, onAcceptLegacy }: {
  event: AttributionRow & { wedding: WeddingRow | null; candidate: CandidateRow | null }
  onAcceptComputed: () => void
  onAcceptLegacy: () => void
}) {
  const w = event.wedding
  const c = event.candidate
  return (
    <div className="bg-surface border border-amber-200 rounded-xl p-4 shadow-sm">
      <div className="flex items-start gap-2 mb-2">
        <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-sage-900">
            Source conflict on{' '}
            {w?.first_name && w?.last_name ? `${w.first_name} ${w.last_name}` : 'wedding'}
          </p>
          <p className="text-xs text-amber-700 mt-1">
            Legacy <code className="text-[10px]">leads.source</code>: <strong>{w?.source ?? 'unset'}</strong>
            {' '}·{' '}
            Computed first-touch: <strong>{platformLabel(event.source_platform)}</strong> ({event.confidence}%)
          </p>
          <p className="text-xs text-sage-500 mt-1">
            {event.conflict_with_legacy_source}
          </p>
          {c && (
            <p className="text-xs text-sage-500 mt-1">
              From {c.signal_count} signal{c.signal_count === 1 ? '' : 's'} on {platformLabel(c.source_platform)} (funnel depth {c.funnel_depth}).
            </p>
          )}
          <div className="flex gap-2 mt-3 flex-wrap">
            <a
              href={`/intel/clients/${event.wedding_id}`}
              className="text-xs px-3 py-1.5 border border-sage-200 rounded-lg hover:bg-sage-50 text-sage-700 inline-flex items-center gap-1"
            >
              Open lead <ArrowRight className="w-3 h-3" />
            </a>
            <button
              onClick={onAcceptComputed}
              className="text-xs px-3 py-1.5 bg-sage-600 text-white rounded-lg hover:bg-sage-700"
            >
              Use computed source
            </button>
            <button
              onClick={onAcceptLegacy}
              className="text-xs px-3 py-1.5 border border-sage-200 rounded-lg hover:bg-sage-50 text-sage-700 inline-flex items-center gap-1"
            >
              <RotateCcw className="w-3 h-3" /> Keep legacy
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function RecentCard({ event, onRevert }: {
  event: AttributionRow & { wedding: WeddingRow | null; candidate: CandidateRow | null }
  onRevert: () => void
}) {
  const w = event.wedding
  return (
    <div className="bg-surface border border-border rounded-lg px-3 py-2 flex items-center gap-3 text-xs">
      {event.is_first_touch && <span className="text-emerald-600 font-semibold shrink-0">FIRST</span>}
      <span className="text-sage-500 shrink-0">{fmtDate(event.decided_at)}</span>
      <span className="text-sage-700 font-medium">{platformLabel(event.source_platform)}</span>
      <ArrowRight className="w-3 h-3 text-sage-400 shrink-0" />
      <span className="text-sage-700 truncate">
        {w?.first_name && w?.last_name ? `${w.first_name} ${w.last_name}` : 'wedding'}
      </span>
      <span className="text-sage-500 ml-auto shrink-0">
        {event.tier.replace(/_/g, ' ')} · {event.confidence}%
      </span>
      <a
        href={`/intel/clients/${event.wedding_id}`}
        className="text-sage-500 hover:text-sage-700 shrink-0"
        title="Open lead"
      >
        <Search className="w-3.5 h-3.5" />
      </a>
      <button
        onClick={onRevert}
        className="text-sage-500 hover:text-rose-600 shrink-0"
        title="Revert"
      >
        <XCircle className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}
