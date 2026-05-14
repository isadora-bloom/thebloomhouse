'use client'

/**
 * Identity reconciliation Tier-2 adjudication UI (Stream KK / migration 177).
 *
 * Day-3 onboarding-project sub-step that closes the multi-source
 * convergence loop. After HoneyBook + Calendly + calculator imports
 * land for a venue, this page:
 *
 *   1. Runs reconcileVenue in dryRun=true to compute the cluster set.
 *   2. Shows summary: "Found 47 clusters across 187 weddings;
 *      auto-mergeable: 31; needs review: 16."
 *   3. Coordinator clicks "Run auto-merges" → POST action='run' →
 *      auto-mergeable clusters get consolidated.
 *   4. Tier-2 cluster cards appear below: "These 3 records share email
 *      cydni@email.com but have conflicting wedding dates. Pick winner
 *      / keep separate / review later."
 *   5. Each card decision posts action='merge' or action='defer'.
 *
 * Step is marked complete when surfacedForReview = 0 (all reviewed) OR
 * coordinator clicks "Defer remaining" (UI-side; server sees no
 * difference since we don't persist defer state).
 */

import { useEffect, useState, useCallback } from 'react'
import {
  Loader2, AlertTriangle, CheckCircle2, Users, Mail, Calendar,
  RefreshCw, ArrowRight, X,
} from 'lucide-react'
import { formatSourceLabel } from '@/lib/utils/format-source-label'

interface ReconciliationCluster {
  status: 'auto_merged' | 'surfaced_for_review' | 'singleton_skipped'
  email: string
  weddingIds: string[]
  winnerId: string | null
  loserIds: string[]
  conflicts: string[]
  backfillPlan: Array<{ field: string; from_loser: string; value: unknown }>
}

interface ReconciliationResult {
  venueId: string
  clustersFound: number
  autoMerged: number
  surfacedForReview: number
  fieldsBackfilled: Record<string, number>
  activeBefore: number
  activeAfter: number
  clusters: ReconciliationCluster[]
  errors: string[]
  dryRun: boolean
}

interface WeddingSummary {
  id: string
  inquiry_date: string | null
  wedding_date: string | null
  source: string | null
  lead_source: string | null
  crm_source: string | null
  estimated_guests: number | null
  guest_count_estimate: number | null
  partner1_name: string
  partner1_email: string | null
  partner1_phone: string | null
}

const CONFLICT_LABELS: Record<string, string> = {
  name_conflict: 'Names disagree',
  partner_name_conflict: "Partner's name disagrees",
  wedding_date_conflict: 'Wedding dates >90d apart',
  phone_conflict: 'Phone numbers disagree',
}

export default function IdentityReconciliationPage() {
  const [result, setResult] = useState<ReconciliationResult | null>(null)
  const [weddingDetails, setWeddingDetails] = useState<Record<string, WeddingSummary>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  const fetchPreview = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/onboarding/identity-reconciliation?dry_run=1')
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const data = (await res.json()) as ReconciliationResult
      setResult(data)
      // Hydrate wedding summaries for every cluster member.
      const ids = new Set<string>()
      for (const c of data.clusters) for (const id of c.weddingIds) ids.add(id)
      if (ids.size > 0) {
        await fetchWeddingDetails([...ids])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to preview')
    } finally {
      setLoading(false)
    }
  }, [])

  async function fetchWeddingDetails(ids: string[]) {
    try {
      const params = new URLSearchParams({ ids: ids.join(',') })
      const res = await fetch(`/api/onboarding/identity-reconciliation/details?${params}`)
      if (!res.ok) return
      const data = (await res.json()) as { weddings: WeddingSummary[] }
      const map: Record<string, WeddingSummary> = {}
      for (const w of data.weddings ?? []) map[w.id] = w
      setWeddingDetails((prev) => ({ ...prev, ...map }))
    } catch { /* swallow — details are optional */ }
  }

  useEffect(() => { fetchPreview() }, [fetchPreview])

  async function handleAutoMerge() {
    if (busy) return
    if (!confirm('Run auto-merges? Tier-1 safe clusters will be consolidated; Tier-2 clusters stay for review.')) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/onboarding/identity-reconciliation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'run' }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      await fetchPreview()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Auto-merge failed')
    } finally { setBusy(false) }
  }

  async function handleClusterMerge(cluster: ReconciliationCluster, winnerId: string) {
    if (busy) return
    const losers = cluster.weddingIds.filter((id) => id !== winnerId)
    if (losers.length === 0) return
    if (!confirm(`Merge ${losers.length} record(s) into the chosen winner? Losers will be soft-deleted (forensic record preserved).`)) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/onboarding/identity-reconciliation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'merge', winnerId, loserIds: losers }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      // Optimistic dismiss + refetch so the cluster vanishes.
      setDismissed((prev) => new Set([...prev, cluster.email]))
      await fetchPreview()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Merge failed')
    } finally { setBusy(false) }
  }

  function handleKeepSeparate(cluster: ReconciliationCluster) {
    // "Keep all separate" is just a UI dismiss — server has no
    // persistent state for "this cluster was reviewed and rejected".
    // Future enhancement: persist a rejection so re-runs skip it.
    setDismissed((prev) => new Set([...prev, cluster.email]))
  }

  function handleDeferLater(cluster: ReconciliationCluster) {
    // Same UX as Keep separate from a state-write standpoint, but the
    // copy is different so coordinators reading the audit later see
    // intent. Sends action='defer' for symmetry.
    fetch('/api/onboarding/identity-reconciliation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'defer' }),
    }).catch(() => { /* swallow */ })
    setDismissed((prev) => new Set([...prev, cluster.email]))
  }

  if (loading) {
    return (
      <div className="p-8 max-w-4xl">
        <div className="flex items-center gap-2 text-sage-600">
          <Loader2 className="w-5 h-5 animate-spin" />
          Computing reconciliation preview…
        </div>
      </div>
    )
  }

  if (!result) {
    return (
      <div className="p-8 max-w-4xl">
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800 text-sm">
            <AlertTriangle className="inline w-4 h-4 mr-2" />
            {error}
          </div>
        )}
      </div>
    )
  }

  const surfacedClusters = result.clusters
    .filter((c) => c.status === 'surfaced_for_review' && !dismissed.has(c.email))

  return (
    <div className="p-8 max-w-4xl space-y-6">
      <header className="space-y-2">
        <h1 className="font-heading text-2xl font-semibold text-sage-900">
          Identity reconciliation
        </h1>
        <p className="text-sm text-sage-600 max-w-2xl">
          Find duplicate weddings created by multiple lead-source imports and consolidate them
          into one canonical record. Losers are soft-deleted (forensic record preserved); the
          winner gets fields backfilled from every loser. Per the Bloom Constitution.
        </p>
      </header>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800 text-sm">
          <AlertTriangle className="inline w-4 h-4 mr-2" />
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <SummaryCard label="Active weddings" value={String(result.activeAfter)} />
        <SummaryCard
          label="Clusters found"
          value={String(result.clustersFound)}
          accent={result.clustersFound > 0 ? 'sage' : 'muted'}
        />
        <SummaryCard
          label="Auto-mergeable"
          value={String(result.clusters.filter((c) => c.status === 'auto_merged').length)}
          accent="sage"
        />
        <SummaryCard
          label="Needs review"
          value={String(result.surfacedForReview)}
          accent={result.surfacedForReview > 0 ? 'amber' : 'muted'}
        />
      </div>

      <div className="rounded-lg border border-sage-200 bg-white p-4 flex items-center justify-between gap-3">
        <div className="text-sm text-sage-600">
          {result.dryRun
            ? 'Preview only — no rows have been touched yet.'
            : `Auto-merge complete. ${result.autoMerged} cluster(s) consolidated.`}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchPreview}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded border border-sage-300 hover:bg-sage-50 disabled:opacity-50 text-sm font-medium px-3 py-1.5"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
          {result.clusters.some((c) => c.status === 'auto_merged') && result.dryRun && (
            <button
              onClick={handleAutoMerge}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white text-sm font-medium px-3 py-1.5"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              Run auto-merges
            </button>
          )}
        </div>
      </div>

      {Object.keys(result.fieldsBackfilled).length > 0 && (
        <div className="rounded-lg border border-sage-200 bg-sage-50 p-4">
          <h3 className="text-sm font-medium text-sage-900 mb-2">Fields ready to be filled in</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
            {Object.entries(result.fieldsBackfilled).map(([field, n]) => (
              <div key={field} className="rounded bg-white px-2 py-1 border border-sage-200">
                <span className="text-sage-500">{field}</span>{' '}
                <span className="text-sage-900 font-medium">+{n}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {surfacedClusters.length === 0 ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-6 flex items-start gap-3">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 mt-0.5 flex-shrink-0" />
          <div>
            <h3 className="font-medium text-emerald-900">All clusters reviewed</h3>
            <p className="text-sm text-emerald-700 mt-1">
              No Tier-2 clusters need coordinator review.
              {result.clustersFound === 0 && ' No duplicates found across imports.'}
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <h2 className="font-heading text-lg font-semibold text-sage-900">
            Needs review ({surfacedClusters.length})
          </h2>
          {surfacedClusters.map((cluster) => (
            <ClusterCard
              key={cluster.email || cluster.weddingIds.join(',')}
              cluster={cluster}
              weddingDetails={weddingDetails}
              onMerge={handleClusterMerge}
              onKeepSeparate={handleKeepSeparate}
              onDefer={handleDeferLater}
              busy={busy}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function SummaryCard({ label, value, accent = 'muted' }: { label: string; value: string; accent?: 'sage' | 'amber' | 'muted' }) {
  const cls = accent === 'sage'
    ? 'border-sage-300 bg-sage-50'
    : accent === 'amber'
      ? 'border-amber-300 bg-amber-50'
      : 'border-sage-200 bg-white'
  return (
    <div className={`rounded-lg border ${cls} p-4`}>
      <div className="text-xs text-sage-500">{label}</div>
      <div className="text-2xl font-heading font-semibold text-sage-900 mt-1">{value}</div>
    </div>
  )
}

interface ClusterCardProps {
  cluster: ReconciliationCluster
  weddingDetails: Record<string, WeddingSummary>
  onMerge: (cluster: ReconciliationCluster, winnerId: string) => void
  onKeepSeparate: (cluster: ReconciliationCluster) => void
  onDefer: (cluster: ReconciliationCluster) => void
  busy: boolean
}

function ClusterCard({ cluster, weddingDetails, onMerge, onKeepSeparate, onDefer, busy }: ClusterCardProps) {
  const [pickedWinner, setPickedWinner] = useState<string>(cluster.winnerId ?? cluster.weddingIds[0])
  const conflicts = cluster.conflicts.map((c) => CONFLICT_LABELS[c] ?? c).join(', ')

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Mail className="w-4 h-4 text-sage-500" />
            <span className="font-medium text-sage-900">{cluster.email || '(no email)'}</span>
            <span className="text-xs text-sage-500">· {cluster.weddingIds.length} records</span>
          </div>
          <p className="text-sm text-amber-800 mt-1">
            <AlertTriangle className="inline w-4 h-4 mr-1" />
            {conflicts || 'Coordinator review requested.'}
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {cluster.weddingIds.map((id) => {
          const w = weddingDetails[id]
          const isWinner = pickedWinner === id
          return (
            <button
              key={id}
              onClick={() => setPickedWinner(id)}
              disabled={busy}
              className={`w-full text-left rounded-lg border p-3 transition ${
                isWinner
                  ? 'border-sage-500 bg-white ring-1 ring-sage-500'
                  : 'border-sage-200 bg-white hover:border-sage-300'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0 text-sm">
                  <div className="flex items-center gap-2">
                    <Users className="w-4 h-4 text-sage-500 flex-shrink-0" />
                    <span className="font-medium text-sage-900 truncate">
                      {w?.partner1_name || '(unknown)'}
                    </span>
                    {w?.crm_source && (
                      <span className="rounded-full bg-sage-100 text-sage-700 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                        {w.crm_source}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-sage-600">
                    {w?.wedding_date && (
                      <div className="flex items-center gap-1">
                        <Calendar className="w-3 h-3" /> {w.wedding_date}
                      </div>
                    )}
                    {w?.partner1_email && (
                      <div className="truncate">{w.partner1_email}</div>
                    )}
                    {w?.partner1_phone && (
                      <div className="truncate">{w.partner1_phone}</div>
                    )}
                    {w?.lead_source && (
                      // T5-Rixey-DDD: lead_source MUST render through
                      // formatSourceLabel (Title-Case + 'Untracked /
                      // Pre-Bloom' for null/empty/unknown).
                      <div className="truncate">source: {formatSourceLabel(w.lead_source)}</div>
                    )}
                    {(w?.estimated_guests || w?.guest_count_estimate) && (
                      <div>guests: {w?.estimated_guests ?? w?.guest_count_estimate}</div>
                    )}
                  </div>
                </div>
                <div className={`text-xs font-medium px-2 py-1 rounded ${
                  isWinner ? 'bg-sage-700 text-white' : 'bg-sage-50 text-sage-500'
                }`}>
                  {isWinner ? 'WINNER' : 'pick'}
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          onClick={() => onDefer(cluster)}
          disabled={busy}
          className="text-sm text-sage-600 hover:text-sage-900 px-3 py-1.5 rounded hover:bg-sage-100"
        >
          I'll review later
        </button>
        <button
          onClick={() => onKeepSeparate(cluster)}
          disabled={busy}
          className="inline-flex items-center gap-1 text-sm text-sage-700 hover:text-sage-900 border border-sage-300 hover:bg-sage-50 px-3 py-1.5 rounded"
        >
          <X className="w-3 h-3" /> Keep separate
        </button>
        <button
          onClick={() => onMerge(cluster, pickedWinner)}
          disabled={busy}
          className="inline-flex items-center gap-1 text-sm bg-sage-700 hover:bg-sage-800 text-white px-3 py-1.5 rounded disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowRight className="w-3 h-3" />}
          Merge into winner
        </button>
      </div>
    </div>
  )
}
