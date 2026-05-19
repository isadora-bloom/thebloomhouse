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
  Flame,
} from 'lucide-react'
import {
  deriveStatusPill,
  statusPillColor,
  type StatusPill,
} from '@/lib/services/identity/status-pill'
import {
  computeHeatScore,
  heatBucket,
  heatColor,
  heatLabel,
} from '@/lib/services/identity/heat-score'
import { ReconstructionStatusBanner } from '@/components/identity/ReconstructionStatusBanner'

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
  last_progression_at: string | null
  updated_at: string
  created_at: string
  touchpoints_count?: number
  last_touchpoint_at?: string | null
  status_pill?: StatusPill
  heat_score?: number
}

// Susan-facing filters per §3. Map a friendly pill name to the
// derivation. Booked/Past/Agent map straight from lifecycle_state;
// Active/Cooling/Lost depend on last_progression_at.
const PILL_FILTERS: Array<{ key: StatusPill | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'Active', label: 'Active' },
  { key: 'Cooling', label: 'Cooling' },
  { key: 'Lost', label: 'Lost' },
  { key: 'Booked', label: 'Booked' },
  { key: 'Past', label: 'Past' },
  { key: 'Agent', label: 'Agent' },
]

export default function CouplesListPage() {
  const router = useRouter()
  const venueId = useVenueId()
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<CoupleRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<StatusPill | 'all'>('all')
  const [query, setQuery] = useState('')
  // Channel-scoped couples (anonymous Knot saves, partial-identity
  // signals) are real but low-signal and vastly outnumber the couples
  // an operator actually works. Hidden by default; the toggle brings
  // them in.
  const [showChannelScoped, setShowChannelScoped] = useState(false)

  useEffect(() => {
    if (!venueId) return
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      let q = supabase
        .from('couples')
        .select(
          'id, venue_id, primary_contact_name, primary_contact_email, primary_contact_phone, partner_contact_name, lifecycle_state, wedding_date, source_wedding_id, last_progression_at, updated_at, created_at',
        )
        .eq('venue_id', venueId)
      if (!showChannelScoped) {
        // Default view = the couples the operator works (booked,
        // resolved inquiries, ghosts, agents). Channel-scoped sit
        // behind the toggle so they don't bury real bookings.
        q = q.neq('lifecycle_state', 'channel_scoped')
      }
      // Order by real activity (last inbound progression), not row
      // write-time — so a couple touring this weekend surfaces, and a
      // batch of couples minted in one Tracer run does not.
      const { data, error: err } = await q
        .order('last_progression_at', { ascending: false, nullsFirst: false })
        .limit(500)
      if (cancelled) return
      if (err) {
        setError(err.message)
        setRows([])
        setLoading(false)
        return
      }
      const couples = (data ?? []) as CoupleRow[]
      // Fetch touchpoint counts + signal tiers for the heat score.
      const ids = couples.map((c) => c.id)
      const { data: tp } = await supabase
        .from('touchpoints')
        .select('couple_id, occurred_at, signal_tier')
        .in('couple_id', ids)
        .order('occurred_at', { ascending: false })
        .limit(8000)
      const perCouple = new Map<
        string,
        { count: number; latest: string; tps: Array<{ signal_tier: string; occurred_at: string }> }
      >()
      for (const t of (tp ?? []) as Array<{
        couple_id: string | null
        occurred_at: string
        signal_tier: string
      }>) {
        if (!t.couple_id) continue
        const c = perCouple.get(t.couple_id)
        if (!c) {
          perCouple.set(t.couple_id, {
            count: 1,
            latest: t.occurred_at,
            tps: [{ signal_tier: t.signal_tier, occurred_at: t.occurred_at }],
          })
        } else {
          c.count += 1
          c.tps.push({ signal_tier: t.signal_tier, occurred_at: t.occurred_at })
        }
      }
      for (const c of couples) {
        const stat = perCouple.get(c.id)
        c.touchpoints_count = stat?.count ?? 0
        c.last_touchpoint_at = stat?.latest ?? null
        c.heat_score = stat ? computeHeatScore(stat.tps) : 0
        c.status_pill = deriveStatusPill({
          lifecycle_state: c.lifecycle_state,
          last_progression_at: c.last_progression_at,
          created_at: c.created_at,
        })
      }
      setRows(couples)
      setLoading(false)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [venueId, supabase, showChannelScoped])

  const filtered = useMemo(() => {
    let out = rows
    if (filter !== 'all') out = out.filter((r) => r.status_pill === filter)
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
    const acc: Record<StatusPill | 'all', number> = {
      all: rows.length,
      Active: 0,
      Cooling: 0,
      Lost: 0,
      Past: 0,
      Booked: 0,
      Agent: 0,
      New: 0,
    }
    for (const r of rows) {
      if (r.status_pill) acc[r.status_pill] += 1
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

      <ReconstructionStatusBanner />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {PILL_FILTERS.map((f) => (
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
              {counts[f.key as StatusPill | 'all']}
            </span>
          </button>
        ))}
        <label className="ml-auto flex items-center gap-2 text-xs text-stone-600">
          <input
            type="checkbox"
            checked={showChannelScoped}
            onChange={(e) => setShowChannelScoped(e.target.checked)}
            className="h-3.5 w-3.5 accent-stone-900"
          />
          Show channel-only signals
        </label>
        <div className="flex items-center gap-2 rounded-md border border-stone-300 bg-white px-3 py-1">
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
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Heat</th>
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
                <td colSpan={8} className="px-4 py-12 text-center text-sm text-stone-500">
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
                const pill = r.status_pill ?? 'New'
                const heat = r.heat_score ?? 0
                const bucket = heatBucket(heat)
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
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${statusPillColor(
                          pill,
                        )}`}
                      >
                        {pill}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${heatColor(bucket)}`}
                        title={`heat score ${Math.round(heat)}`}
                      >
                        <Flame className="h-3 w-3" /> {heatLabel(bucket)}
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
        Showing the 500 most recently active couples. Channel-only
        signals (anonymous Knot saves and other partial-identity
        records) are hidden by default — use the toggle to include them.
        The Phase B Tracer rebuilds this graph nightly; the Phase C
        Forwards Linker keeps it current per signal. Pending matches
        live in the review queue above.
      </p>
    </div>
  )
}
