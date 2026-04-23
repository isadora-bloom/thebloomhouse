'use client'

/**
 * Couple Portal → Availability (read-only)
 *
 * Phase 2 Task 22. Couples see a month calendar of their venue's date
 * status — available, held, booked, blocked. Strict read-only: couples
 * cannot change status. Strict no-leak: the calendar shows AVAILABILITY
 * not OCCUPANTS. A booked date renders as "booked" — never the other
 * couple's name or wedding date.
 *
 * Multi-wedding: max_events respected. A date with booked_count=1 and
 * max_events=2 shows "1 slot taken" with the day still markable as
 * available.
 *
 * White-label: header pulls business_name from venue_config via
 * CoupleShell context. No hardcoded venue identifiers.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon } from 'lucide-react'

type AvailabilityStatus = 'available' | 'booked' | 'hold' | 'tour_only' | 'blocked'

interface AvailabilityRow {
  date: string
  status: AvailabilityStatus
  max_events: number
  booked_count: number
}

// Couple-facing labels differ from the coordinator view — softer language
// and no operational terms. "tour_only" and "hold" both render as "date
// being held" to the couple; the distinction is coordinator-only.
const COUPLE_LABEL: Record<AvailabilityStatus, string> = {
  available: 'Available',
  booked: 'Booked',
  hold: 'On hold',
  tour_only: 'Held for a tour',
  blocked: 'Unavailable',
}

const COUPLE_COLOUR: Record<AvailabilityStatus, string> = {
  available: 'bg-white hover:bg-[var(--couple-primary)]/5',
  booked: 'bg-rose-50 text-rose-900',
  hold: 'bg-amber-50 text-amber-900',
  tour_only: 'bg-sky-50 text-sky-900',
  blocked: 'bg-gray-100 text-gray-500',
}

function toISO(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1)
}

function formatMonth(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

function buildGrid(month: Date): Date[] {
  const first = startOfMonth(month)
  const start = new Date(first)
  start.setDate(first.getDate() - first.getDay())
  const cells: Date[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    cells.push(d)
  }
  return cells
}

export default function CoupleAvailabilityPage() {
  const { venueId, venueName } = useCoupleContext()
  const [month, setMonth] = useState<Date>(() => startOfMonth(new Date()))
  const [rows, setRows] = useState<Record<string, AvailabilityRow>>({})
  const [defaultMax, setDefaultMax] = useState(1)
  const [loading, setLoading] = useState(true)

  const grid = useMemo(() => buildGrid(month), [month])
  const rangeStart = grid[0]
  const rangeEnd = grid[grid.length - 1]

  const load = useCallback(async () => {
    if (!venueId) return
    setLoading(true)
    const supabase = createClient()
    const [{ data: availRows }, { data: cfg }] = await Promise.all([
      supabase
        .from('venue_availability')
        .select('date, status, max_events, booked_count')
        .eq('venue_id', venueId)
        .gte('date', toISO(rangeStart))
        .lte('date', toISO(rangeEnd)),
      supabase
        .from('venue_config')
        .select('max_events_per_day')
        .eq('venue_id', venueId)
        .maybeSingle(),
    ])
    const byDate: Record<string, AvailabilityRow> = {}
    for (const r of (availRows ?? []) as AvailabilityRow[]) {
      byDate[r.date] = r
    }
    setRows(byDate)
    const m = (cfg as { max_events_per_day: number | null } | null)?.max_events_per_day
    setDefaultMax(m && m > 0 ? m : 1)
    setLoading(false)
  }, [venueId, rangeStart, rangeEnd])

  useEffect(() => {
    load()
  }, [load])

  const todayISO = toISO(new Date())

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      <div>
        <h1
          className="text-2xl font-semibold flex items-center gap-2"
          style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
        >
          <CalendarIcon className="w-6 h-6" />
          {venueName ? `${venueName} availability` : 'Availability'}
        </h1>
        <p className="text-sm text-gray-600 mt-1">
          A read-only view of what's still open. Chat with your coordinator to
          confirm a date or talk through alternatives.
        </p>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setMonth((m) => addMonths(m, -1))}
            className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50"
            aria-label="Previous month"
          >
            <ChevronLeft className="w-4 h-4 text-gray-700" />
          </button>
          <div className="font-medium text-gray-900 min-w-[140px] text-center" style={{ fontFamily: 'var(--couple-font-heading)' }}>
            {formatMonth(month)}
          </div>
          <button
            type="button"
            onClick={() => setMonth((m) => addMonths(m, 1))}
            className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50"
            aria-label="Next month"
          >
            <ChevronRight className="w-4 h-4 text-gray-700" />
          </button>
        </div>
        <button
          type="button"
          onClick={() => setMonth(startOfMonth(new Date()))}
          className="px-3 py-2 text-xs font-medium rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50"
        >
          Today
        </button>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm">
        <div className="grid grid-cols-7 bg-gray-50 border-b border-gray-200">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
            <div key={d} className="px-2 py-2 text-xs font-medium text-gray-600 text-center">
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {grid.map((d) => {
            const iso = toISO(d)
            const inMonth = d.getMonth() === month.getMonth()
            const row = rows[iso]
            const maxEvents = row?.max_events ?? defaultMax
            const bookedCount = row?.booked_count ?? 0
            const status: AvailabilityStatus =
              row?.status ?? 'available'

            // A date is "effectively available" if status='available' AND
            // booked_count < max_events. A multi-wedding day with 1 of 2
            // slots taken still shows as available to couples.
            const effective: AvailabilityStatus =
              status === 'available' && bookedCount >= maxEvents ? 'booked' : status

            const isToday = iso === todayISO
            const slotsLeft = Math.max(0, maxEvents - bookedCount)
            const showSlots = maxEvents > 1 && (effective === 'available' || effective === 'booked')

            return (
              <div
                key={iso}
                className={`relative border-b border-r border-gray-100 min-h-[72px] p-2 ${
                  inMonth ? COUPLE_COLOUR[effective] : 'bg-gray-50/30 text-gray-300'
                } ${isToday ? 'font-semibold' : ''}`}
              >
                <div className="text-xs">{d.getDate()}</div>
                {inMonth && effective !== 'available' && (
                  <div className="mt-0.5 text-[10px] uppercase tracking-wide opacity-75">
                    {COUPLE_LABEL[effective]}
                  </div>
                )}
                {inMonth && showSlots && effective === 'available' && bookedCount > 0 && (
                  <div className="mt-0.5 text-[10px] text-gray-600">
                    {slotsLeft} of {maxEvents} slots left
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {loading && <p className="text-xs text-gray-500 italic">Loading…</p>}

      <p className="text-xs text-gray-500">
        This view is a snapshot. For the latest hold or if a date you want
        shows as unavailable, please reach out — timings shift week to week.
      </p>
    </div>
  )
}
