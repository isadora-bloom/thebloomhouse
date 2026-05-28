'use client'

/**
 * Coordinator-side widget for per-section staff sign-off.
 *
 * 2026-05-26. Surfaces the staff_signed_off column from
 * section_finalisations (mig 009) which had no UI before this round.
 * Lets coordinators confirm "yes, I've reviewed this section" alongside
 * the couple's own sign-off. The couple-side sidebar shows a small
 * "coordinator confirmed" indicator on rows where both parties signed.
 *
 * Drop into any coordinator surface that has a weddingId.
 */

import { useEffect, useState } from 'react'
import { Loader2, Check, Square, ClipboardCheck, User2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface FinalisationRow {
  id: string
  section_name: string
  couple_signed_off: boolean
  couple_signed_off_at: string | null
  staff_signed_off: boolean
  staff_signed_off_at: string | null
}

// Reuses the same list shape as the priorities picker. Kept in sync
// by hand for now — when a section is added/removed, update both.
const SECTION_CATALOG: { slug: string; label: string; group: string }[] = [
  // General
  { slug: 'wedding_details', label: 'Wedding Details', group: 'General' },
  { slug: 'budget', label: 'Budget', group: 'General' },
  { slug: 'booking', label: 'Booking', group: 'General' },
  { slug: 'timeline', label: 'Timeline', group: 'General' },
  { slug: 'ceremony', label: 'Ceremony', group: 'General' },
  { slug: 'ceremony_chairs', label: 'Ceremony Chairs', group: 'General' },
  { slug: 'rehearsal', label: 'Rehearsal Dinner', group: 'General' },
  // Vendors
  { slug: 'vendors', label: 'Vendors', group: 'Vendors' },
  { slug: 'contracts', label: 'Contracts', group: 'Vendors' },
  { slug: 'bar', label: 'Bar', group: 'Vendors' },
  { slug: 'beauty', label: 'Beauty', group: 'Vendors' },
  { slug: 'decor', label: 'Decor', group: 'Vendors' },
  { slug: 'photos', label: 'Photos', group: 'Vendors' },
  { slug: 'transportation', label: 'Transportation', group: 'Vendors' },
  { slug: 'staffing', label: 'Staffing', group: 'Vendors' },
  // Guests
  { slug: 'guests', label: 'Guest List', group: 'Guests' },
  { slug: 'rsvp_settings', label: 'RSVP Settings', group: 'Guests' },
  { slug: 'wedding_party', label: 'Wedding Party', group: 'Guests' },
  { slug: 'allergies', label: 'Allergies', group: 'Guests' },
  { slug: 'guest_care', label: 'Guest Care', group: 'Guests' },
  { slug: 'rooms', label: 'Rooms', group: 'Guests' },
  { slug: 'seating', label: 'Seating', group: 'Guests' },
  { slug: 'table_map', label: 'Floor Plan', group: 'Guests' },
  { slug: 'tables', label: 'Table Sizes', group: 'Guests' },
  // Resources
  { slug: 'worksheets', label: 'Worksheets', group: 'Resources' },
  { slug: 'venue_inventory', label: 'Venue Inclusions', group: 'Resources' },
  { slug: 'website', label: 'Wedding Website', group: 'Resources' },
]

const GROUPED = SECTION_CATALOG.reduce<Record<string, typeof SECTION_CATALOG>>((acc, s) => {
  acc[s.group] = acc[s.group] || []
  acc[s.group].push(s)
  return acc
}, {})

function formatDate(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function WeddingFinalisationsWidget({ weddingId }: { weddingId: string }) {
  const [rows, setRows] = useState<Record<string, FinalisationRow>>({})
  const [loading, setLoading] = useState(true)
  const [savingSlug, setSavingSlug] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // ----- fetch -----
  useEffect(() => {
    if (!weddingId) return
    let cancelled = false
    fetch(`/api/portal/weddings/${weddingId}/finalisations`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return
        const byName: Record<string, FinalisationRow> = {}
        for (const row of (data?.finalisations ?? []) as FinalisationRow[]) {
          byName[row.section_name] = row
        }
        setRows(byName)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        console.warn('[WeddingFinalisationsWidget] load failed:', err)
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [weddingId])

  // ----- toggle -----
  async function toggleStaff(slug: string, nextValue: boolean) {
    setSavingSlug(slug)
    setError(null)
    try {
      const res = await fetch(`/api/portal/weddings/${weddingId}/finalisations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section_name: slug, staff_signed_off: nextValue }),
      })
      if (!res.ok) {
        const txt = await res.text()
        throw new Error(txt || `HTTP ${res.status}`)
      }
      const data = await res.json()
      if (data.finalisation) {
        setRows((prev) => ({ ...prev, [slug]: data.finalisation as FinalisationRow }))
      }
    } catch (err) {
      console.error('[WeddingFinalisationsWidget] toggle failed:', err)
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSavingSlug(null)
    }
  }

  // ----- counters for header -----
  const totals = (() => {
    let staff = 0
    let couple = 0
    let both = 0
    for (const sec of SECTION_CATALOG) {
      const row = rows[sec.slug]
      if (row?.staff_signed_off) staff++
      if (row?.couple_signed_off) couple++
      if (row?.staff_signed_off && row?.couple_signed_off) both++
    }
    return { staff, couple, both, total: SECTION_CATALOG.length }
  })()

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-1.5">
            <ClipboardCheck className="w-3.5 h-3.5 text-emerald-600" />
            Section sign-off
          </h3>
          <p className="text-xs text-gray-500">
            Confirm sections as you review them. Couples see a "coordinator
            confirmed" mark next to their own check.
          </p>
        </div>
        {!loading && (
          <div className="flex items-center gap-3 text-[11px] text-gray-500">
            <span><User2 className="w-3 h-3 inline mr-0.5" /> Couple {totals.couple}/{totals.total}</span>
            <span><ClipboardCheck className="w-3 h-3 inline mr-0.5" /> Staff {totals.staff}/{totals.total}</span>
            <span className="text-emerald-700 font-medium">Both {totals.both}</span>
          </div>
        )}
      </div>

      {error && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-xs text-gray-400 flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="space-y-3">
          {Object.entries(GROUPED).map(([group, sections]) => (
            <div key={group}>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1.5">
                {group}
              </p>
              <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                {sections.map((sec) => {
                  const row = rows[sec.slug]
                  const coupleDone = row?.couple_signed_off === true
                  const staffDone = row?.staff_signed_off === true
                  const isSaving = savingSlug === sec.slug
                  return (
                    <li
                      key={sec.slug}
                      className={cn(
                        'flex items-center gap-2 px-2 py-1.5 rounded-md border text-xs transition-colors',
                        staffDone && coupleDone
                          ? 'border-emerald-200 bg-emerald-50/60'
                          : staffDone || coupleDone
                            ? 'border-amber-200 bg-amber-50/40'
                            : 'border-gray-100'
                      )}
                    >
                      <button
                        onClick={() => toggleStaff(sec.slug, !staffDone)}
                        disabled={isSaving}
                        className={cn(
                          'shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors',
                          staffDone
                            ? 'bg-emerald-500 border-emerald-500 text-white'
                            : 'border-gray-300 hover:border-emerald-400'
                        )}
                        title={staffDone ? 'Click to un-confirm' : 'Click to confirm'}
                      >
                        {isSaving ? (
                          <Loader2 className="w-2.5 h-2.5 animate-spin" />
                        ) : staffDone ? (
                          <Check className="w-2.5 h-2.5" />
                        ) : (
                          <Square className="w-2.5 h-2.5 opacity-0" />
                        )}
                      </button>
                      <span className="flex-1 truncate text-gray-700">{sec.label}</span>
                      {coupleDone && (
                        <span
                          className="inline-flex items-center gap-0.5 text-[10px] text-gray-500"
                          title={`Couple marked complete ${formatDate(row?.couple_signed_off_at ?? null)}`}
                        >
                          <User2 className="w-2.5 h-2.5" />
                          {formatDate(row?.couple_signed_off_at ?? null)}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
