'use client'

/**
 * Portal → Availability
 *
 * Shared date-status calendar for venue sales and coordination staff.
 *
 * Why it exists: a venue with more than one seller cannot rely on "I put
 * it in Google Calendar" — a hold on Oct 15 set by one salesperson has to
 * be visible to every other salesperson before they confirm the same date
 * to another couple. This is the single source of truth Sage also queries
 * in inquiry-brain.ts before promising availability to a lead.
 *
 * Data model: supabase/migrations/073_venue_availability.sql
 *   - Row absent = 'available' with venue_config.max_events_per_day slots.
 *   - Row present = coordinator or trigger touched this date. booked_count
 *     is cached by the weddings trigger.
 *   - Coordinator intent (hold/tour_only/blocked) wins over the trigger.
 *     Only available↔booked is auto-flipped when booked_count hits
 *     max_events.
 *
 * White-label: every user-visible string reads from venue_config. Oakwood
 * Estate sees Oakwood's name in the header, Oakwood's max_events default
 * in the edit modal.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import {
  ChevronLeft, ChevronRight, Calendar as CalendarIcon,
  Save, X, Trash2, Info,
} from 'lucide-react'
import { useVenueId } from '@/lib/hooks/use-venue-id'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AvailabilityStatus = 'available' | 'booked' | 'hold' | 'tour_only' | 'blocked'

interface AvailabilityRow {
  date: string            // YYYY-MM-DD
  status: AvailabilityStatus
  max_events: number
  booked_count: number
  notes: string | null
  updated_at: string | null
}

interface WeddingRow {
  id: string
  wedding_date: string
  status: string
  // Display label — couple's surname if we have it, else 'Booked'. The
  // Availability calendar is not the place to render full couple names
  // with PII visible to every staff member; surnames-only mirrors how
  // most ops calendars show bookings.
  display_label: string | null
}

interface EditorState {
  open: boolean
  date: string | null
  status: AvailabilityStatus
  maxEvents: number
  notes: string
  existingRow: boolean
  saving: boolean
  error: string | null
}

// ---------------------------------------------------------------------------
// Status presentation (venue-agnostic)
// ---------------------------------------------------------------------------

interface StatusPresentation {
  label: string
  cellBg: string       // Tailwind class for the cell background
  cellText: string     // Tailwind class for the cell text
  pillBg: string       // Tailwind class for the legend/pill
  pillText: string
  description: string  // Hover help text for coordinators
}

const STATUS_PRESENTATION: Record<AvailabilityStatus, StatusPresentation> = {
  available: {
    label: 'Available',
    cellBg: 'bg-white hover:bg-sage-50',
    cellText: 'text-sage-900',
    pillBg: 'bg-white border border-sage-200',
    pillText: 'text-sage-700',
    description: 'Actively selling this date.',
  },
  booked: {
    label: 'Booked',
    cellBg: 'bg-rose-50 hover:bg-rose-100',
    cellText: 'text-rose-900',
    pillBg: 'bg-rose-50 border border-rose-200',
    pillText: 'text-rose-700',
    description: 'Contracted — do not sell to another couple.',
  },
  hold: {
    label: 'Hold',
    cellBg: 'bg-amber-50 hover:bg-amber-100',
    cellText: 'text-amber-900',
    pillBg: 'bg-amber-50 border border-amber-200',
    pillText: 'text-amber-800',
    description: 'Tentative — a couple is about to sign. Sage will not confirm to others.',
  },
  tour_only: {
    label: 'Tour only',
    cellBg: 'bg-sky-50 hover:bg-sky-100',
    cellText: 'text-sky-900',
    pillBg: 'bg-sky-50 border border-sky-200',
    pillText: 'text-sky-700',
    description: 'Site visit scheduled. Date can still be sold for a wedding.',
  },
  blocked: {
    label: 'Blocked',
    cellBg: 'bg-sage-100 hover:bg-sage-200',
    cellText: 'text-sage-500',
    pillBg: 'bg-sage-100 border border-sage-300',
    pillText: 'text-sage-600',
    description: 'Closed for any reason (maintenance, personal, holiday).',
  },
}

const STATUS_ORDER: AvailabilityStatus[] = [
  'available', 'hold', 'tour_only', 'booked', 'blocked',
]

// ---------------------------------------------------------------------------
// Date helpers — local-tz, no library dependency.
// ---------------------------------------------------------------------------

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

function formatLongDate(iso: string): string {
  // iso is YYYY-MM-DD; construct a local Date by splitting (avoids the
  // UTC-midnight timezone slip that `new Date(iso)` causes).
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  })
}

/**
 * Returns the 42-cell grid (6 weeks × 7 days) starting from the Sunday on
 * or before the 1st of `month`. Standard calendar layout — outside-month
 * cells at the edges render muted.
 */
function buildCalendarGrid(month: Date): Date[] {
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

// ---------------------------------------------------------------------------
// Supabase client (browser)
// ---------------------------------------------------------------------------

function getSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AvailabilityPage() {
  const venueId = useVenueId()
  const [month, setMonth] = useState<Date>(() => startOfMonth(new Date()))
  const [venueName, setVenueName] = useState<string>('')
  const [defaultMaxEvents, setDefaultMaxEvents] = useState<number>(1)
  const [rows, setRows] = useState<Record<string, AvailabilityRow>>({})
  const [weddings, setWeddings] = useState<Record<string, WeddingRow[]>>({})
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editor, setEditor] = useState<EditorState>({
    open: false,
    date: null,
    status: 'available',
    maxEvents: 1,
    notes: '',
    existingRow: false,
    saving: false,
    error: null,
  })

  const grid = useMemo(() => buildCalendarGrid(month), [month])
  const rangeStart = grid[0]
  const rangeEnd = grid[grid.length - 1]

  // -------------------------------------------------------------------------
  // Load venue header + default max_events
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!venueId) return
    const supabase = getSupabase()
    ;(async () => {
      const [{ data: venue }, { data: cfg }] = await Promise.all([
        supabase.from('venues').select('name').eq('id', venueId).maybeSingle(),
        supabase.from('venue_config')
          .select('business_name, max_events_per_day')
          .eq('venue_id', venueId).maybeSingle(),
      ])
      setVenueName(cfg?.business_name || venue?.name || 'Your venue')
      const m = (cfg as { max_events_per_day: number | null } | null)?.max_events_per_day
      setDefaultMaxEvents(m && m > 0 ? m : 1)
    })()
  }, [venueId])

  // -------------------------------------------------------------------------
  // Load availability rows + weddings for visible range
  // -------------------------------------------------------------------------
  const loadRange = useCallback(async () => {
    if (!venueId) return
    setLoading(true)
    const supabase = getSupabase()
    const fromISO = toISO(rangeStart)
    const toISOstr = toISO(rangeEnd)

    const [{ data: availRows }, { data: weddingRows }] = await Promise.all([
      supabase.from('venue_availability')
        .select('date, status, max_events, booked_count, notes, updated_at')
        .eq('venue_id', venueId)
        .gte('date', fromISO)
        .lte('date', toISOstr),
      supabase.from('weddings')
        .select('id, wedding_date, status, people:people(role, first_name, last_name)')
        .eq('venue_id', venueId)
        .in('status', ['booked', 'completed', 'hold'])
        .gte('wedding_date', fromISO)
        .lte('wedding_date', toISOstr)
        .not('wedding_date', 'is', null),
    ])

    // Normalise availability rows by date.
    const byDate: Record<string, AvailabilityRow> = {}
    for (const r of (availRows ?? []) as AvailabilityRow[]) {
      byDate[r.date] = r
    }
    setRows(byDate)

    // Build per-date wedding label map. Surname of partner1 is enough for
    // the calendar view — full details live on /portal/weddings/[id].
    const wByDate: Record<string, WeddingRow[]> = {}
    for (const w of (weddingRows ?? []) as Array<{
      id: string
      wedding_date: string
      status: string
      people: Array<{ role: string; first_name: string | null; last_name: string | null }> | null
    }>) {
      const date = w.wedding_date
      // Surname of partner1 is the calendar label. Keep PII minimal — full
      // details live on /portal/weddings/[id].
      const p1 = (w.people ?? []).find((p) => p.role === 'partner1')
      const label = p1?.last_name || p1?.first_name || null
      const entry: WeddingRow = {
        id: w.id,
        wedding_date: date,
        status: w.status,
        display_label: label,
      }
      if (!wByDate[date]) wByDate[date] = []
      wByDate[date].push(entry)
    }
    setWeddings(wByDate)
    setLoading(false)
  }, [venueId, rangeStart, rangeEnd])

  useEffect(() => { loadRange() }, [loadRange])

  // -------------------------------------------------------------------------
  // Cell status resolution — row OR default
  // -------------------------------------------------------------------------
  const resolveCellStatus = useCallback((iso: string): {
    status: AvailabilityStatus
    maxEvents: number
    bookedCount: number
    hasRow: boolean
    notes: string | null
  } => {
    const row = rows[iso]
    if (row) {
      return {
        status: row.status,
        maxEvents: row.max_events,
        bookedCount: row.booked_count,
        hasRow: true,
        notes: row.notes,
      }
    }
    return {
      status: 'available',
      maxEvents: defaultMaxEvents,
      bookedCount: 0,
      hasRow: false,
      notes: null,
    }
  }, [rows, defaultMaxEvents])

  // -------------------------------------------------------------------------
  // Cell click — single-select opens editor, shift-click extends range.
  // -------------------------------------------------------------------------
  function onCellClick(iso: string, shiftKey: boolean) {
    if (shiftKey) {
      const next = new Set(selected)
      if (next.has(iso)) next.delete(iso); else next.add(iso)
      setSelected(next)
      return
    }
    // Single click with no existing selection: open editor.
    // If there IS an active selection, single-click clears it and opens
    // editor on the clicked date (less surprising than extending).
    setSelected(new Set())
    openEditor(iso)
  }

  function openEditor(iso: string) {
    const cell = resolveCellStatus(iso)
    setEditor({
      open: true,
      date: iso,
      status: cell.status,
      maxEvents: cell.maxEvents,
      notes: cell.notes ?? '',
      existingRow: cell.hasRow,
      saving: false,
      error: null,
    })
  }

  function closeEditor() {
    setEditor((e) => ({ ...e, open: false, error: null }))
  }

  // -------------------------------------------------------------------------
  // Persistence — upsert for save, delete for reset.
  // -------------------------------------------------------------------------
  async function saveEditor() {
    if (!editor.date || !venueId) return
    setEditor((e) => ({ ...e, saving: true, error: null }))
    const supabase = getSupabase()
    const payload = {
      venue_id: venueId,
      date: editor.date,
      status: editor.status,
      max_events: editor.maxEvents,
      notes: editor.notes.trim() || null,
    }
    const { error } = await supabase
      .from('venue_availability')
      .upsert(payload, { onConflict: 'venue_id,date' })

    if (error) {
      setEditor((e) => ({ ...e, saving: false, error: error.message }))
      return
    }
    setEditor((e) => ({ ...e, saving: false, open: false, error: null }))
    await loadRange()
  }

  async function resetEditor() {
    if (!editor.date || !venueId) return
    setEditor((e) => ({ ...e, saving: true, error: null }))
    const supabase = getSupabase()
    const { error } = await supabase
      .from('venue_availability')
      .delete()
      .eq('venue_id', venueId)
      .eq('date', editor.date)

    if (error) {
      setEditor((e) => ({ ...e, saving: false, error: error.message }))
      return
    }
    setEditor((e) => ({ ...e, saving: false, open: false, error: null }))
    await loadRange()
  }

  // -------------------------------------------------------------------------
  // Bulk actions — set a status on every selected date.
  // -------------------------------------------------------------------------
  async function bulkSetStatus(next: AvailabilityStatus) {
    if (!venueId || selected.size === 0) return
    const supabase = getSupabase()
    const payload = Array.from(selected).map((date) => ({
      venue_id: venueId,
      date,
      status: next,
      max_events: rows[date]?.max_events ?? defaultMaxEvents,
      notes: rows[date]?.notes ?? null,
    }))
    const { error } = await supabase
      .from('venue_availability')
      .upsert(payload, { onConflict: 'venue_id,date' })

    if (error) {
      // Soft-fail — rows that did save are visible after reload.
      console.error('[availability] bulk upsert failed:', error.message)
    }
    setSelected(new Set())
    await loadRange()
  }

  async function bulkReset() {
    if (!venueId || selected.size === 0) return
    const supabase = getSupabase()
    const { error } = await supabase
      .from('venue_availability')
      .delete()
      .eq('venue_id', venueId)
      .in('date', Array.from(selected))

    if (error) {
      console.error('[availability] bulk delete failed:', error.message)
    }
    setSelected(new Set())
    await loadRange()
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  const todayISO = toISO(new Date())

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold text-sage-900 flex items-center gap-2">
            <CalendarIcon className="w-6 h-6 text-sage-600" />
            {venueName ? `${venueName} · Availability` : 'Availability'}
          </h1>
          <p className="text-sm text-sage-600 mt-1">
            Click a date to change its status. Shift-click to select a range for bulk changes.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setMonth((m) => addMonths(m, -1))}
            className="p-2 rounded-lg border border-sage-200 hover:bg-sage-50"
            aria-label="Previous month"
          >
            <ChevronLeft className="w-4 h-4 text-sage-700" />
          </button>
          <div className="font-heading text-base font-medium text-sage-900 min-w-[140px] text-center">
            {formatMonth(month)}
          </div>
          <button
            type="button"
            onClick={() => setMonth((m) => addMonths(m, 1))}
            className="p-2 rounded-lg border border-sage-200 hover:bg-sage-50"
            aria-label="Next month"
          >
            <ChevronRight className="w-4 h-4 text-sage-700" />
          </button>
          <button
            type="button"
            onClick={() => setMonth(startOfMonth(new Date()))}
            className="ml-2 px-3 py-2 text-xs font-medium rounded-lg border border-sage-200 text-sage-700 hover:bg-sage-50"
          >
            Today
          </button>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-2 text-xs">
        {STATUS_ORDER.map((s) => {
          const p = STATUS_PRESENTATION[s]
          return (
            <div
              key={s}
              className={`px-2.5 py-1 rounded-md flex items-center gap-1.5 ${p.pillBg}`}
              title={p.description}
            >
              <span className={`font-medium ${p.pillText}`}>{p.label}</span>
              <Info className={`w-3 h-3 ${p.pillText} opacity-60`} />
            </div>
          )
        })}
      </div>

      {/* Calendar grid */}
      <div className="bg-white border border-sage-200 rounded-xl overflow-hidden shadow-sm">
        {/* Day headers */}
        <div className="grid grid-cols-7 bg-sage-50 border-b border-sage-200">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
            <div
              key={d}
              className="px-2 py-2 text-xs font-medium text-sage-600 text-center"
            >
              {d}
            </div>
          ))}
        </div>

        {/* Date cells */}
        <div className="grid grid-cols-7">
          {grid.map((d) => {
            const iso = toISO(d)
            const inMonth = d.getMonth() === month.getMonth()
            const cell = resolveCellStatus(iso)
            const p = STATUS_PRESENTATION[cell.status]
            const isSelected = selected.has(iso)
            const isToday = iso === todayISO
            const dayWeddings = weddings[iso] ?? []
            const countLabel = cell.bookedCount > 0 || cell.maxEvents > 1
              ? `${cell.bookedCount}/${cell.maxEvents}`
              : null

            return (
              <button
                key={iso}
                type="button"
                onClick={(e) => onCellClick(iso, e.shiftKey)}
                className={`
                  relative border-b border-r border-sage-100 text-left
                  min-h-[88px] p-2 transition-colors
                  ${inMonth ? p.cellBg : 'bg-sage-50/30 hover:bg-sage-50'}
                  ${inMonth ? p.cellText : 'text-sage-300'}
                  ${isSelected ? 'ring-2 ring-inset ring-sage-500' : ''}
                  ${isToday ? 'font-semibold' : ''}
                `}
              >
                <div className="flex items-start justify-between">
                  <span className={`text-sm ${isToday ? 'underline underline-offset-2' : ''}`}>
                    {d.getDate()}
                  </span>
                  {countLabel && (
                    <span className="text-[10px] font-mono opacity-70">
                      {countLabel}
                    </span>
                  )}
                </div>
                {/* Status label when a coordinator row exists and status
                    isn't the default 'available'. */}
                {cell.hasRow && cell.status !== 'available' && (
                  <div className="mt-1 text-[10px] uppercase tracking-wide opacity-75">
                    {p.label}
                  </div>
                )}
                {/* Wedding couple labels (surnames) */}
                {dayWeddings.slice(0, 2).map((w) => (
                  <div
                    key={w.id}
                    className="mt-0.5 text-[11px] truncate"
                    title={w.display_label ?? 'Booked wedding'}
                  >
                    • {w.display_label ?? 'Booked'}
                  </div>
                ))}
                {dayWeddings.length > 2 && (
                  <div className="text-[10px] opacity-70">
                    +{dayWeddings.length - 2} more
                  </div>
                )}
                {cell.notes && (
                  <div className="absolute top-1 right-1">
                    <Info className="w-3 h-3 opacity-60" />
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {loading && (
        <p className="text-xs text-sage-500 italic">Loading availability…</p>
      )}

      {/* Bulk action bar — appears when ≥2 dates selected */}
      {selected.size > 0 && (
        <div
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 bg-sage-900 text-white rounded-xl shadow-2xl px-4 py-3 flex items-center gap-3"
          role="toolbar"
          aria-label="Bulk availability actions"
        >
          <span className="text-sm font-medium">
            {selected.size} date{selected.size === 1 ? '' : 's'} selected
          </span>
          <div className="flex items-center gap-1">
            <BulkButton onClick={() => bulkSetStatus('blocked')}>Block</BulkButton>
            <BulkButton onClick={() => bulkSetStatus('hold')}>Hold</BulkButton>
            <BulkButton onClick={() => bulkSetStatus('available')}>Open</BulkButton>
            <BulkButton onClick={bulkReset} danger>
              <Trash2 className="w-3 h-3" /> Reset
            </BulkButton>
            <BulkButton onClick={() => setSelected(new Set())}>Cancel</BulkButton>
          </div>
        </div>
      )}

      {/* Edit modal */}
      {editor.open && editor.date && (
        <div
          className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={closeEditor}
        >
          <div
            className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div>
                <h2 className="font-heading text-lg font-semibold text-sage-900">
                  {formatLongDate(editor.date)}
                </h2>
                <p className="text-xs text-sage-500 mt-0.5">
                  {editor.existingRow
                    ? 'Editing this date\'s override.'
                    : 'Creating a date-specific override.'}
                </p>
              </div>
              <button
                type="button"
                onClick={closeEditor}
                className="p-1 rounded hover:bg-sage-100 text-sage-500"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div>
              <label className="block text-xs font-medium text-sage-700 mb-1">
                Status
              </label>
              <div className="grid grid-cols-1 gap-1.5">
                {STATUS_ORDER.map((s) => {
                  const p = STATUS_PRESENTATION[s]
                  const active = editor.status === s
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setEditor((e) => ({ ...e, status: s }))}
                      className={`
                        flex items-center gap-2 px-3 py-2 rounded-lg border text-left transition-colors
                        ${active
                          ? `${p.pillBg} ${p.pillText} ring-2 ring-sage-400`
                          : 'border-sage-200 hover:bg-sage-50 text-sage-700'
                        }
                      `}
                    >
                      <span className="font-medium text-sm">{p.label}</span>
                      <span className="text-xs opacity-75">{p.description}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-sage-700 mb-1">
                Max events on this date
              </label>
              <input
                type="number"
                min={1}
                max={10}
                value={editor.maxEvents}
                onChange={(e) => setEditor((ed) => ({
                  ...ed,
                  maxEvents: Math.max(1, Math.min(10, parseInt(e.target.value || '1', 10))),
                }))}
                className="w-24 px-3 py-2 border border-sage-200 rounded-lg text-sm text-sage-900 focus:outline-none focus:ring-2 focus:ring-sage-300"
              />
              <p className="text-xs text-sage-500 mt-1">
                {editor.maxEvents > 1
                  ? `Up to ${editor.maxEvents} weddings on this date.`
                  : 'One wedding on this date.'}
                {' '}Venue default is {defaultMaxEvents}.
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-sage-700 mb-1">
                Notes (coordinator-only)
              </label>
              <textarea
                rows={3}
                value={editor.notes}
                onChange={(e) => setEditor((ed) => ({ ...ed, notes: e.target.value }))}
                placeholder="Why is this date held / blocked?"
                className="w-full px-3 py-2 border border-sage-200 rounded-lg text-sm text-sage-900 focus:outline-none focus:ring-2 focus:ring-sage-300 resize-none"
              />
            </div>

            {editor.error && (
              <div className="px-3 py-2 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-700">
                {editor.error}
              </div>
            )}

            <div className="flex items-center justify-between pt-2">
              {editor.existingRow ? (
                <button
                  type="button"
                  onClick={resetEditor}
                  disabled={editor.saving}
                  className="text-xs text-rose-600 hover:text-rose-700 flex items-center gap-1"
                >
                  <Trash2 className="w-3 h-3" /> Reset to default
                </button>
              ) : <span />}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={closeEditor}
                  disabled={editor.saving}
                  className="px-4 py-2 text-sm text-sage-700 hover:bg-sage-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveEditor}
                  disabled={editor.saving}
                  className="px-4 py-2 text-sm bg-sage-600 hover:bg-sage-700 text-white rounded-lg flex items-center gap-1.5 disabled:opacity-60"
                >
                  <Save className="w-3.5 h-3.5" />
                  {editor.saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bulk action bar button
// ---------------------------------------------------------------------------

function BulkButton({
  onClick,
  children,
  danger,
}: {
  onClick: () => void
  children: React.ReactNode
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        px-3 py-1.5 text-xs font-medium rounded-md flex items-center gap-1 transition-colors
        ${danger
          ? 'bg-rose-900/60 hover:bg-rose-900 text-rose-100'
          : 'bg-sage-700 hover:bg-sage-600 text-sage-50'
        }
      `}
    >
      {children}
    </button>
  )
}
