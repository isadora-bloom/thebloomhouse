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
import { createClient } from '@/lib/supabase/client'
import {
  CheckCircle2, XCircle, AlertTriangle, Sparkles, Search,
  Activity, ArrowRight, RotateCcw,
} from 'lucide-react'
import { useVenueId } from '@/lib/hooks/use-venue-id'

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
    const sb = createClient()
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
        // Pattern A (mig 336) + TIER 2e (mig 338): live view dedupes
        // duplicates AND we filter to UNRESOLVED conflicts only.
        // Audited 110-conflict queue collapses once destination /
        // low-info auto-resolve rules fire on write OR via backfill.
        sb
          .from('attribution_events_live')
          .select('*')
          .eq('venue_id', venueId)
          .not('conflict_with_legacy_source', 'is', null)
          .is('conflict_resolution_state', null)
          .order('decided_at', { ascending: false }),
        sb
          .from('attribution_events_live')
          .select('*')
          .eq('venue_id', venueId)
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
        // TIER 0b (reasoning-binding fix, 2026-05-14): the Round 2
        // audit caught Eleanor Pittinger's card showing Bonnie Alger's
        // name. Cause was THIS query returning all people per wedding
        // (partners, family, planners) unordered, and the map keeping
        // only the first row. The reasoning was correctly bound to
        // the event but the WRONG person was displayed.
        // Fix: pull role + last_initial too, then prefer partner1 ->
        // primary -> partner2 in that order, falling back to first
        // partner-ish row.
        weddingIds.size > 0
          ? sb
              .from('people')
              .select('wedding_id, first_name, last_name, role')
              .in('wedding_id', Array.from(weddingIds))
              .in('role', ['partner1', 'primary', 'partner2'])
          : Promise.resolve({ data: [] }),
      ])

      const candMap = new Map<string, CandidateRow>(
        ((candRes.data ?? []) as CandidateRow[]).map((c) => [c.id, c]),
      )
      // Role-aware partner pick. partner1 wins; primary is the legacy
      // single-partner role; partner2 fills only if neither exists.
      const peopleByWedding = new Map<
        string,
        { first_name: string | null; last_name: string | null; role: string }
      >()
      const peopleRows = (peopleRes.data ?? []) as Array<{
        wedding_id: string
        first_name: string | null
        last_name: string | null
        role: string
      }>
      const roleRank = (role: string): number =>
        role === 'partner1' ? 0 : role === 'primary' ? 1 : role === 'partner2' ? 2 : 3
      for (const p of peopleRows) {
        const existing = peopleByWedding.get(p.wedding_id)
        if (!existing || roleRank(p.role) < roleRank(existing.role)) {
          peopleByWedding.set(p.wedding_id, {
            first_name: p.first_name,
            last_name: p.last_name,
            role: p.role,
          })
        }
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
    const sb = createClient()
    await sb.from('candidate_identities').update({ review_status: 'reviewed' }).eq('id', id)
    setNeedsReview((prev) => prev.filter((c) => c.id !== id))
  }

  async function linkCandidateToWedding(candidateId: string, weddingId: string) {
    // Manual link from the review queue. Writes attribution_events for
    // every signal attached to the candidate, marks candidate resolved,
    // and recomputes first-touch on the wedding.
    const sb = createClient()
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
      ? 'Keep the original source? This undoes the auto-attribution and recomputes first-touch.'
      : 'Undo this auto-attribution? Stays in the audit trail; first-touch is recomputed.'
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
          // TIER 2c (surface clustering, 2026-05-14): group candidates
          // that share normalized first_name + last_initial (+ state
          // when set). Operators reviewed dozens of near-duplicate
          // cards before because each platform/cluster minted its own
          // candidate. Group view shows them as one stack with each
          // candidate listed inside, so reviewer can pattern-match
          // ("oh these 3 are all the same person") and act once.
          <div className="space-y-4">
            {groupCandidatesByFingerprint(needsReview).map((group) =>
              group.candidates.length === 1 ? (
                <NeedsReviewCard
                  key={group.candidates[0].id}
                  candidate={group.candidates[0]}
                  venueId={venueId}
                  onDismiss={() => dismissCandidate(group.candidates[0].id)}
                  onLink={(weddingId) => linkCandidateToWedding(group.candidates[0].id, weddingId)}
                />
              ) : (
                <ClusteredCandidates
                  key={group.key}
                  group={group}
                  venueId={venueId}
                  onDismiss={dismissCandidate}
                  onLink={linkCandidateToWedding}
                />
              ),
            )}
          </div>
        )
      ) : tab === 'conflicts' ? (
        conflicts.length === 0 ? (
          <EmptyState icon={CheckCircle2} text="No source conflicts. Auto-attribution agrees with the original source on every lead." />
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
    const sb = createClient()
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
            Original source: <strong>{w?.source ?? 'unset'}</strong>
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
              <RotateCcw className="w-3 h-3" /> Keep original
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
  // Connective tissue II / fix #4 (2026-04-30): expand to show the
  // AI's reasoning when present. tier_2_ai writes a sentence
  // explaining why the AI chose this match; tier_2_coordinator
  // includes the coordinator's note. Without this, the queue
  // renders "tier 2 ai · 78%" with no auditability — coordinator
  // has to click into each lead to see the reasoning.
  const hasReasoning = Boolean(event.reasoning && event.reasoning.trim())
  const isAiTier = event.tier === 'tier_2_ai' || event.tier === 'tier_2_wide_ai'
  return (
    <div className="bg-surface border border-border rounded-lg px-3 py-2 text-xs">
      <div className="flex items-center gap-3">
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
      {hasReasoning && (
        <p className={`mt-1 italic text-[11px] ${isAiTier ? 'text-sage-600' : 'text-sage-500'}`}>
          {isAiTier ? 'AI: ' : 'Coordinator: '}"{event.reasoning}"
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// TIER 2c — fingerprint clustering for the review queue
// ---------------------------------------------------------------------------

interface CandidateGroup {
  key: string
  /** Display label, e.g. "Zachary G. (VA)". */
  label: string
  candidates: CandidateRow[]
}

/**
 * Group candidates that share the same identity fingerprint —
 * normalized first_name + last_initial + state. Anchor: Round 2
 * audit TIER 2c (2026-05-14). Operators reviewed N independent
 * cards for the same person across platforms; this collapses them
 * into one decision per group.
 *
 * Ordering preserved within groups (most-recent-last_seen first).
 * Groups themselves ordered by the most-recent last_seen across
 * any member candidate.
 */
function groupCandidatesByFingerprint(rows: CandidateRow[]): CandidateGroup[] {
  const buckets = new Map<string, CandidateGroup>()
  for (const c of rows) {
    const fp = fingerprintKey(c)
    let g = buckets.get(fp)
    if (!g) {
      g = {
        key: fp,
        label: candidateLabel(c),
        candidates: [],
      }
      buckets.set(fp, g)
    }
    g.candidates.push(c)
  }
  const out = [...buckets.values()]
  // Sort candidates within each group by last_seen desc.
  for (const g of out) {
    g.candidates.sort((a, b) => (b.last_seen ?? '').localeCompare(a.last_seen ?? ''))
  }
  // Sort groups by max last_seen across members, desc.
  out.sort((a, b) => {
    const aMax = a.candidates.reduce((acc, c) => (c.last_seen && c.last_seen > acc ? c.last_seen : acc), '')
    const bMax = b.candidates.reduce((acc, c) => (c.last_seen && c.last_seen > acc ? c.last_seen : acc), '')
    return bMax.localeCompare(aMax)
  })
  return out
}

function fingerprintKey(c: CandidateRow): string {
  const first = (c.first_name ?? '').toLowerCase().trim()
  const initial = (c.last_initial ?? '').toLowerCase().trim()
  const state = (c.state ?? '').toLowerCase().trim()
  // No first_name = singleton (use id so it doesn't collide with
  // other no-name candidates).
  if (!first) return `__nofp_${c.id}`
  return `${first}|${initial}|${state}`
}

function candidateLabel(c: CandidateRow): string {
  const name = c.first_name ?? '?'
  const initial = c.last_initial ? `${c.last_initial.toUpperCase()}.` : ''
  const state = c.state ? ` (${c.state.toUpperCase()})` : ''
  return `${name} ${initial}${state}`.trim()
}

function ClusteredCandidates({
  group,
  venueId,
  onDismiss,
  onLink,
}: {
  group: CandidateGroup
  venueId: string
  onDismiss: (id: string) => void
  onLink: (candidateId: string, weddingId: string) => void
}) {
  const platforms = Array.from(new Set(group.candidates.map((c) => c.source_platform)))
  const totalSignals = group.candidates.reduce((acc, c) => acc + (c.signal_count ?? 0), 0)
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50/40 p-3 shadow-sm">
      <div className="flex items-center justify-between gap-2 mb-2 px-1">
        <p className="text-sm font-semibold text-sage-900">
          {group.candidates.length} candidates · {group.label}
        </p>
        <p className="text-xs text-sage-600">
          {platforms.map(platformLabel).join(' + ')} · {totalSignals} total signals
        </p>
      </div>
      <p className="px-1 mb-3 text-xs text-sage-600">
        Same first name + last initial{group.candidates[0].state ? ` + state` : ''}. Likely the same
        person across platforms. Review each; linking one to a wedding does not link the others.
      </p>
      <div className="space-y-3">
        {group.candidates.map((c) => (
          <NeedsReviewCard
            key={c.id}
            candidate={c}
            venueId={venueId}
            onDismiss={() => onDismiss(c.id)}
            onLink={(weddingId) => onLink(c.id, weddingId)}
          />
        ))}
      </div>
    </div>
  )
}
