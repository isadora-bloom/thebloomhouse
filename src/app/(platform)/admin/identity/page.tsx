'use client'

/**
 * Identity merge audit (Reem-bug fix, 2026-05-08).
 *
 * Read-only coordinator surface listing every recent person + wedding
 * merge that the canonical identity resolver performed. Each row
 * surfaces the loser id, the canonical it was merged into, the source
 * label, and when. Coordinator can spot-check the resolver's behaviour
 * + click through to the canonical wedding.
 *
 * Data sources:
 *   - public.people WHERE merged_into_id IS NOT NULL
 *   - public.weddings WHERE merged_into_id IS NOT NULL
 *   - public.merge_reattachment_log (migration 202) for per-merge counts
 */

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { GitMerge, ArrowRight, AlertCircle, Users, Calendar, Network } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'

interface PersonMergeRow {
  id: string
  merged_into_id: string
  email: string | null
  first_name: string | null
  last_name: string | null
  updated_at: string | null
  created_at: string
}

interface WeddingMergeRow {
  id: string
  merged_into_id: string
  wedding_date: string | null
  notes: string | null
  source_provenance: string | null
  updated_at: string | null
  created_at: string
}

interface ReattachmentLogRow {
  id: string
  loser_wedding_id: string
  winner_wedding_id: string
  attribution_events_moved: number
  touchpoints_moved: number
  candidates_moved: number
  fired_at: string
}

export default function IdentityAdminPage() {
  const venueId = useVenueId()
  const supabase = useMemo(() => createClient(), [])

  const [peopleMerges, setPeopleMerges] = useState<PersonMergeRow[]>([])
  const [weddingMerges, setWeddingMerges] = useState<WeddingMergeRow[]>([])
  const [reattachLog, setReattachLog] = useState<ReattachmentLogRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!venueId) return
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const [peopleRes, weddingsRes, logRes] = await Promise.all([
          supabase
            .from('people')
            .select('id, merged_into_id, email, first_name, last_name, updated_at, created_at')
            .eq('venue_id', venueId)
            .not('merged_into_id', 'is', null)
            .order('created_at', { ascending: false })
            .limit(100),
          supabase
            .from('weddings')
            .select('id, merged_into_id, wedding_date, notes, source_provenance, updated_at, created_at')
            .eq('venue_id', venueId)
            .not('merged_into_id', 'is', null)
            .order('created_at', { ascending: false })
            .limit(100),
          supabase
            .from('merge_reattachment_log')
            .select('id, loser_wedding_id, winner_wedding_id, attribution_events_moved, touchpoints_moved, candidates_moved, fired_at')
            .order('fired_at', { ascending: false })
            .limit(100),
        ])
        if (cancelled) return
        if (peopleRes.error) throw peopleRes.error
        if (weddingsRes.error) throw weddingsRes.error
        // log error is non-fatal — table may be empty / RLS may scope us out.
        setPeopleMerges((peopleRes.data ?? []) as PersonMergeRow[])
        setWeddingMerges((weddingsRes.data ?? []) as WeddingMergeRow[])
        setReattachLog((logRes.data ?? []) as ReattachmentLogRow[])
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load identity audit')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [venueId, supabase])

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-8">
      <header className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-2xl font-serif text-sage-900 flex items-center gap-3">
            <GitMerge className="w-6 h-6 text-sage-700" />
            Identity merge audit
          </h1>
          <p className="text-sage-600 mt-2 text-sm max-w-2xl">
            Every person + wedding the canonical identity resolver collapsed
            into another. Tombstone rows preserve the forensic record per
            Constitution. Coordinator can spot-check what got merged + chase
            the pointer to the canonical row.
          </p>
        </div>
        {/* Wave 2D — full coordinator UI for handle convergence proposals.
            Links to /admin/identity/handle-merges (mig 259 + accept/reject/defer
            endpoints). */}
        <Link
          href="/admin/identity/handle-merges"
          className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-sage-300 bg-warm-white text-sm text-sage-700 hover:bg-sage-50 whitespace-nowrap"
          title="Cross-platform handle convergence proposals — accept, reject, or defer"
        >
          <Network className="w-4 h-4" />
          Handle merge proposals
        </Link>
      </header>

      {error && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-rose-600 mt-0.5" />
          <div className="text-sm text-rose-800">{error}</div>
        </div>
      )}

      {loading && (
        <div className="text-sage-600 text-sm">Loading audit data...</div>
      )}

      {!loading && (
        <>
          <section>
            <h2 className="text-lg font-serif text-sage-900 mb-3 flex items-center gap-2">
              <Users className="w-4 h-4" />
              Person merges
              <span className="text-sm text-sage-500">({peopleMerges.length})</span>
            </h2>
            {peopleMerges.length === 0 ? (
              <div className="text-sm text-sage-500 italic">No person merges on record.</div>
            ) : (
              <ul className="divide-y divide-border bg-surface rounded-lg border border-border">
                {peopleMerges.map((row) => (
                  <li key={row.id} className="p-4 flex items-center gap-4 text-sm">
                    <div className="flex-1 min-w-0">
                      <div className="text-sage-900 truncate">
                        {row.first_name || row.last_name
                          ? `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim()
                          : row.email ?? row.id.slice(0, 8)}
                      </div>
                      {row.email && (
                        <div className="text-sage-500 text-xs truncate">{row.email}</div>
                      )}
                    </div>
                    <ArrowRight className="w-4 h-4 text-sage-400" />
                    <div className="text-sage-700 text-xs font-mono">
                      {row.merged_into_id.slice(0, 8)}...
                    </div>
                    <div className="text-sage-500 text-xs whitespace-nowrap">
                      {row.updated_at
                        ? new Date(row.updated_at).toLocaleDateString()
                        : new Date(row.created_at).toLocaleDateString()}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2 className="text-lg font-serif text-sage-900 mb-3 flex items-center gap-2">
              <Calendar className="w-4 h-4" />
              Wedding merges
              <span className="text-sm text-sage-500">({weddingMerges.length})</span>
            </h2>
            {weddingMerges.length === 0 ? (
              <div className="text-sm text-sage-500 italic">No wedding merges on record.</div>
            ) : (
              <ul className="divide-y divide-border bg-surface rounded-lg border border-border">
                {weddingMerges.map((row) => {
                  const log = reattachLog.find((l) => l.loser_wedding_id === row.id)
                  return (
                    <li key={row.id} className="p-4 flex items-center gap-4 text-sm">
                      <div className="flex-1 min-w-0">
                        <div className="text-sage-900 truncate font-mono text-xs">
                          {row.id.slice(0, 8)}...
                        </div>
                        <div className="text-sage-500 text-xs">
                          {row.wedding_date
                            ? `Wedding date ${row.wedding_date}`
                            : 'No date set'}
                          {row.source_provenance && (
                            <span> · source: {row.source_provenance}</span>
                          )}
                        </div>
                      </div>
                      <ArrowRight className="w-4 h-4 text-sage-400" />
                      <Link
                        href={`/intel/clients/${row.merged_into_id}`}
                        className="text-sage-700 text-xs font-mono hover:underline"
                      >
                        {row.merged_into_id.slice(0, 8)}...
                      </Link>
                      {log && (
                        <div className="text-xs text-sage-500 whitespace-nowrap">
                          moved {log.attribution_events_moved + log.touchpoints_moved + log.candidates_moved} attrib rows
                        </div>
                      )}
                      <div className="text-sage-500 text-xs whitespace-nowrap">
                        {log
                          ? new Date(log.fired_at).toLocaleDateString()
                          : new Date(row.created_at).toLocaleDateString()}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  )
}
