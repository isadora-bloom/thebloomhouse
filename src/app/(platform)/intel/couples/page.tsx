'use client'

/**
 * Phase E entry point: couples list.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §1 + §3. The operator's
 * doorway into the new identity schema. Reads ONLY from the couples
 * table (the new unit) plus a touchpoint count join. Legacy weddings
 * is untouched; the read-path migration in Phase D will switch other
 * pages over.
 *
 * What's here
 * -----------
 *  - Lifecycle filter (channel_scoped / booked / resolved / ghost)
 *  - Primary contact name + email
 *  - Last-touchpoint timestamp + count badge
 *  - Click-through to /intel/couples/[id] for the journey ribbon
 *
 * What's deliberately NOT here
 * ----------------------------
 *  - The legacy "weddings" view with booking_value, source, etc.
 *    That's the existing /intel/clients page; we leave it alone until
 *    Phase D. Couples and weddings coexist; the source_wedding_id
 *    column on couples is the bridge.
 */

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import {
  Users,
  Search,
  ArrowRight,
  Mail,
  Phone,
  Activity,
  AlertCircle,
} from 'lucide-react'

type LifecycleState = 'channel_scoped' | 'booked' | 'resolved' | 'ghost' | 'agent'

interface CoupleRow {
  id: string
  venue_id: string
  primary_contact_name: string | null
  primary_contact_email: string | null
  primary_contact_phone: string | null
  partner_contact_name: string | null
  lifecycle_state: LifecycleState | null
  wedding_date: string | null
  source_wedding_id: string | null
  updated_at: string
  created_at: string
  touchpoints_count?: number
  last_touchpoint_at?: string | null
}

const LIFECYCLE_FILTERS: Array<{ key: LifecycleState | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'channel_scoped', label: 'Channel-scoped' },
  { key: 'booked', label: 'Booked' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'ghost', label: 'Ghost' },
  { key: 'agent', label: 'Agent' },
]

function lifecycleBadgeColor(state: LifecycleState | null): string {
  switch (state) {
    case 'booked':
      return 'bg-emerald-100 text-emerald-800 border-emerald-200'
    case 'resolved':
      return 'bg-sky-100 text-sky-800 border-sky-200'
    case 'channel_scoped':
      return 'bg-amber-50 text-amber-700 border-amber-200'
    case 'ghost':
      return 'bg-stone-100 text-stone-500 border-stone-200'
    case 'agent':
      return 'bg-violet-100 text-violet-800 border-violet-200'
    default:
      return 'bg-stone-100 text-stone-500 border-stone-200'
  }
}

export default function CouplesListPage() {
  const router = useRouter()
  const venueId = useVenueId()
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<CoupleRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<LifecycleState | 'all'>('all')
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!venueId) return
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      const { data, error: err } = await supabase
        .from('couples')
        .select(
          'id, venue_id, primary_contact_name, primary_contact_email, primary_contact_phone, partner_contact_name, lifecycle_state, wedding_date, source_wedding_id, updated_at, created_at',
        )
        .eq('venue_id', venueId)
        .order('updated_at', { ascending: false })
        .limit(500)
      if (cancelled) return
      if (err) {
        setError(err.message)
        setRows([])
        setLoading(false)
        return
      }
      const couples = (data ?? []) as CoupleRow[]
      // Fetch touchpoint counts in one batched query.
      const ids = couples.map((c) => c.id)
      const { data: tp } = await supabase
        .from('touchpoints')
        .select('couple_id, occurred_at')
        .in('couple_id', ids)
        .order('occurred_at', { ascending: false })
        .limit(5000)
      const counts = new Map<string, { count: number; latest: string }>()
      for (const t of (tp ?? []) as Array<{ couple_id: string | null; occurred_at: string }>) {
        if (!t.couple_id) continue
        const c = counts.get(t.couple_id)
        if (!c) counts.set(t.couple_id, { count: 1, latest: t.occurred_at })
        else c.count += 1
      }
      for (const c of couples) {
        const stat = counts.get(c.id)
        c.touchpoints_count = stat?.count ?? 0
        c.last_touchpoint_at = stat?.latest ?? null
      }
      setRows(couples)
      setLoading(false)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [venueId, supabase])

  const filtered = useMemo(() => {
    let out = rows
    if (filter !== 'all') out = out.filter((r) => r.lifecycle_state === filter)
    if (query.trim()) {
      const q = query.toLowerCase()
      out = out.filter(
        (r) =>
          (r.primary_contact_name ?? '').toLowerCase().includes(q) ||
          (r.partner_contact_name ?? '').toLowerCase().includes(q) ||
          (r.primary_contact_email ?? '').toLowerCase().includes(q) ||
          (r.primary_contact_phone ?? '').toLowerCase().includes(q),
      )
    }
    return out
  }, [rows, filter, query])

  const counts = useMemo(() => {
    const acc: Record<LifecycleState | 'all', number> = {
      all: rows.length,
      channel_scoped: 0,
      booked: 0,
      resolved: 0,
      ghost: 0,
      agent: 0,
    }
    for (const r of rows) {
      if (r.lifecycle_state) acc[r.lifecycle_state] += 1
    }
    return acc
  }, [rows])

  return (
    <div className="mx-auto max-w-7xl p-8">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-stone-500" />
            <h1 className="font-serif text-3xl text-stone-900">Couples</h1>
          </div>
          <p className="mt-2 max-w-2xl text-sm text-stone-600">
            The new identity-first view. Each row is a single couple,
            assembled from every channel that's ever seen them. Click a row
            to see the journey ribbon, with cross-channel touchpoints,
            fragments, and pending candidate matches.
          </p>
        </div>
        <a
          href="/intel/identity-review"
          className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm hover:bg-stone-50"
        >
          Review pending matches
        </a>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {LIFECYCLE_FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-full border px-3 py-1 text-xs ${
              filter === f.key
                ? 'border-stone-900 bg-stone-900 text-white'
                : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-50'
            }`}
          >
            {f.label}{' '}
            <span className={filter === f.key ? 'opacity-70' : 'text-stone-400'}>
              {counts[f.key as LifecycleState | 'all']}
            </span>
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2 rounded-md border border-stone-300 bg-white px-3 py-1">
          <Search className="h-4 w-4 text-stone-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, email, phone"
            className="bg-transparent text-sm outline-none placeholder:text-stone-400"
          />
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          <AlertCircle className="mt-0.5 h-4 w-4" /> {error}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-stone-200 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-600">
            <tr>
              <th className="px-4 py-3">Couple</th>
              <th className="px-4 py-3">Contact</th>
              <th className="px-4 py-3">Lifecycle</th>
              <th className="px-4 py-3">Wedding date</th>
              <th className="px-4 py-3 text-right">Touchpoints</th>
              <th className="px-4 py-3">Last activity</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-sm text-stone-500">
                  Loading...
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-sm text-stone-500">
                  No couples yet. Connect a channel or wait for the Tracer to
                  finish reconstructing identity from history.
                </td>
              </tr>
            )}
            {!loading &&
              filtered.map((r) => {
                const name =
                  r.primary_contact_name ?? r.primary_contact_email ?? '(unnamed)'
                const partner = r.partner_contact_name
                return (
                  <tr
                    key={r.id}
                    onClick={() => router.push(`/intel/couples/${r.id}`)}
                    className="cursor-pointer border-t border-stone-100 hover:bg-stone-50"
                  >
                    <td className="px-4 py-3 font-medium text-stone-900">
                      {name}
                      {partner && (
                        <span className="text-stone-500"> &amp; {partner}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-stone-600">
                      {r.primary_contact_email && (
                        <div className="flex items-center gap-1">
                          <Mail className="h-3 w-3" /> {r.primary_contact_email}
                        </div>
                      )}
                      {r.primary_contact_phone && (
                        <div className="flex items-center gap-1">
                          <Phone className="h-3 w-3" /> {r.primary_contact_phone}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${lifecycleBadgeColor(
                          r.lifecycle_state,
                        )}`}
                      >
                        {r.lifecycle_state ?? 'unknown'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-stone-600">
                      {r.wedding_date
                        ? new Date(r.wedding_date).toLocaleDateString()
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-700">
                        <Activity className="h-3 w-3" />
                        {r.touchpoints_count ?? 0}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-stone-500">
                      {r.last_touchpoint_at
                        ? new Date(r.last_touchpoint_at).toLocaleString()
                        : new Date(r.updated_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-stone-400">
                      <ArrowRight className="h-4 w-4" />
                    </td>
                  </tr>
                )
              })}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-stone-500">
        Showing the latest 500 couples by activity. The Phase B Tracer
        rebuilds this graph nightly; the Phase C Forwards Linker keeps it
        current per signal. Pending matches (medium / low tier) live in
        the review queue above.
      </p>
    </div>
  )
}
