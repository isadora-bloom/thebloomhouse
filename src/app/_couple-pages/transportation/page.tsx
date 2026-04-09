'use client'

// Feature: configurable via venue_config.feature_flags
// Table: shuttle_schedule

import { useState, useEffect, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import {
  Bus,
  Plus,
  Trash2,
  MapPin,
  Clock,
  Users,
  Info,
  ArrowRight,
  Sparkles,
  AlertTriangle,
  Check,
  X,
  ChevronDown,
  ChevronUp,
  Settings2,
  Hash,
  Tag,
} from 'lucide-react'
import { TagChip, type TagChipData } from '@/components/couple/tag-chip'

// TODO: Get from auth session
const WEDDING_ID = 'ab000000-0000-0000-0000-000000000001'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRANSIT_MINUTES = 25
const DEFAULT_ARRIVAL_BUFFER_MINUTES = 30
const GAP_MINUTES = 30

const RUN_COUNT_OPTIONS = [1, 2, 3, 4]
const SHUTTLE_COUNT_OPTIONS = [1, 2, 3, 4]
const SEATS_PER_SHUTTLE_DEFAULT = 40

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ShuttleRun {
  id: string
  run_label: string
  pickup_location: string
  pickup_time: string | null
  dropoff_location: string
  dropoff_time: string | null
  seat_count: number | null
  notes: string | null
  sort_order: number
  shuttle_id: string | null
}

// ---------------------------------------------------------------------------
// Time helpers — parse "h:mm AM/PM" <-> minutes since midnight
// ---------------------------------------------------------------------------

function timeToMinutes(str: string): number {
  const match = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
  if (!match) return NaN
  let hours = parseInt(match[1], 10)
  const mins = parseInt(match[2], 10)
  const period = match[3].toUpperCase()
  if (period === 'AM' && hours === 12) hours = 0
  if (period === 'PM' && hours !== 12) hours += 12
  return hours * 60 + mins
}

function minutesToTime(m: number): string {
  if (m < 0) m += 1440
  m = m % 1440
  const h24 = Math.floor(m / 60)
  const mins = m % 60
  const period = h24 >= 12 ? 'PM' : 'AM'
  const h12 = h24 % 12 || 12
  return `${h12}:${String(mins).padStart(2, '0')} ${period}`
}

function timeToDb(str: string): string | null {
  const m = timeToMinutes(str)
  if (isNaN(m)) return null
  const h = Math.floor(m / 60)
  const min = m % 60
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

function dbToDisplay(db: string | null): string {
  if (!db) return ''
  const [h, m] = db.split(':').map(Number)
  const total = h * 60 + m
  return minutesToTime(total)
}

// Accepts "16:00", "16:00:00", "4:00 PM", "4 PM" and returns "h:mm AM/PM"
function normalizeTimeInput(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  // Already "h:mm AM/PM" form?
  if (/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(trimmed)) {
    return minutesToTime(timeToMinutes(trimmed))
  }
  // "HH:MM" or "HH:MM:SS" 24h form
  const m24 = trimmed.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/)
  if (m24) {
    const h = parseInt(m24[1], 10)
    const mins = parseInt(m24[2], 10)
    return minutesToTime(h * 60 + mins)
  }
  // "4 PM"
  const mShort = trimmed.match(/^(\d{1,2})\s*(AM|PM)$/i)
  if (mShort) {
    let h = parseInt(mShort[1], 10)
    const period = mShort[2].toUpperCase()
    if (period === 'AM' && h === 12) h = 0
    if (period === 'PM' && h !== 12) h += 12
    return minutesToTime(h * 60)
  }
  return trimmed
}

// ---------------------------------------------------------------------------
// Shuttle letter helper
// ---------------------------------------------------------------------------

function shuttleLetter(index: number): string {
  return String.fromCharCode(65 + index) // A, B, C, D...
}

// ---------------------------------------------------------------------------
// Generator state
// ---------------------------------------------------------------------------

interface GeneratorState {
  time: string
  numRuns: number
  location: string
}

const EMPTY_GEN: GeneratorState = { time: '', numRuns: 1, location: '' }

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface TaggedGuestRow {
  id: string
  first_name: string | null
  last_name: string | null
  needs_shuttle: boolean | null
}

export default function TransportationPage() {
  const [runs, setRuns] = useState<ShuttleRun[]>([])
  const [loading, setLoading] = useState(true)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  // Shuttle tag tracking
  const [shuttleTag, setShuttleTag] = useState<TagChipData | null>(null)
  const [shuttleTaggedGuests, setShuttleTaggedGuests] = useState<TaggedGuestRow[]>([])
  const [autoPopulateStatus, setAutoPopulateStatus] = useState<string | null>(null)

  // Fleet configuration
  const [shuttleCount, setShuttleCount] = useState(1)
  const [seatsPerShuttle, setSeatsPerShuttle] = useState(SEATS_PER_SHUTTLE_DEFAULT)
  const [arrivalBufferMinutes, setArrivalBufferMinutes] = useState(DEFAULT_ARRIVAL_BUFFER_MINUTES)
  const [showFleetConfig, setShowFleetConfig] = useState(false)

  // Pickup location suggestions
  const [pickupSuggestions, setPickupSuggestions] = useState<string[]>([])
  const [showPreSuggestions, setShowPreSuggestions] = useState(false)
  const [showPostSuggestions, setShowPostSuggestions] = useState(false)

  // Inline editing
  const [editField, setEditField] = useState<{ id: string; field: string } | null>(null)
  const [editValue, setEditValue] = useState('')
  const editRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null)

  // Location editing suggestions
  const [editLocationSuggestions, setEditLocationSuggestions] = useState<string[]>([])
  const [showEditSuggestions, setShowEditSuggestions] = useState(false)

  // Generators
  const [preGen, setPreGen] = useState<GeneratorState>(EMPTY_GEN)
  const [postGen, setPostGen] = useState<GeneratorState>(EMPTY_GEN)

  // Generator error surface (e.g. DB insert failures)
  const [genError, setGenError] = useState<string | null>(null)

  const supabase = createClient()

  // ---- Fetch ----
  const fetchRuns = useCallback(async () => {
    const [runsRes, configRes, timelineRes] = await Promise.all([
      supabase
        .from('shuttle_schedule')
        .select('*')
        .eq('wedding_id', WEDDING_ID)
        .order('sort_order', { ascending: true }),
      supabase
        .from('venue_config')
        .select('feature_flags')
        .eq('venue_id', VENUE_ID)
        .maybeSingle(),
      supabase
        .from('wedding_timeline')
        .select('ceremony_start, reception_end')
        .eq('wedding_id', WEDDING_ID)
        .maybeSingle(),
    ])

    if (runsRes.data) {
      setRuns(runsRes.data as ShuttleRun[])
    }

    let loadedSuggestions: string[] = []
    if (configRes.data) {
      const flags = (configRes.data.feature_flags ?? {}) as Record<string, unknown>
      const sc = (flags.shuttle_config ?? {}) as Record<string, unknown>
      const pickupLocations = sc.pickup_locations as Array<{ name?: string }> | undefined
      if (pickupLocations) {
        loadedSuggestions = pickupLocations.map((l) => l.name || '').filter(Boolean)
        setPickupSuggestions(loadedSuggestions)
      }
      if (sc.available_shuttles) {
        setShuttleCount(sc.available_shuttles as number)
      }
      if (sc.seats_per_shuttle) {
        setSeatsPerShuttle(sc.seats_per_shuttle as number)
      }
      if (typeof sc.arrival_buffer_minutes === 'number') {
        setArrivalBufferMinutes(sc.arrival_buffer_minutes as number)
      }
    }

    // Pre-populate generator inputs with sensible defaults so the user
    // can just click "Generate" without hunting for inputs.
    const ceremonyStart = (timelineRes.data?.ceremony_start as string) || ''
    const receptionEnd = (timelineRes.data?.reception_end as string) || ''
    const defaultCeremonyDisplay = ceremonyStart ? normalizeTimeInput(ceremonyStart) : '4:00 PM'
    const defaultEndDisplay = receptionEnd ? normalizeTimeInput(receptionEnd) : '11:00 PM'
    const defaultLocation = loadedSuggestions[0] || 'Hotel'

    setPreGen((prev) => ({
      time: prev.time || defaultCeremonyDisplay,
      numRuns: prev.numRuns,
      location: prev.location || defaultLocation,
    }))
    setPostGen((prev) => ({
      time: prev.time || defaultEndDisplay,
      numRuns: prev.numRuns,
      location: prev.location || defaultLocation,
    }))

    setLoading(false)
  }, [supabase])

  // Fetch the "Shuttle" system tag and its assigned guests.
  const fetchShuttleTagged = useCallback(async () => {
    // Find the shuttle tag for this wedding
    const { data: tagRows } = await supabase
      .from('guest_tags')
      .select('id, tag_name, color')
      .eq('wedding_id', WEDDING_ID)
      .ilike('tag_name', 'shuttle')
      .limit(1)

    const tag = tagRows && tagRows.length > 0 ? tagRows[0] : null
    if (!tag) {
      setShuttleTag(null)
      setShuttleTaggedGuests([])
      return
    }
    setShuttleTag({
      id: tag.id as string,
      name: tag.tag_name as string,
      color: (tag.color as string) || '#5D7A7A',
    })

    // Find guests assigned this tag
    const { data: assignments } = await supabase
      .from('guest_tag_assignments')
      .select('guest_id')
      .eq('tag_id', tag.id)

    const guestIds = (assignments || []).map((a) => (a as { guest_id: string }).guest_id)
    if (guestIds.length === 0) {
      setShuttleTaggedGuests([])
      return
    }
    const { data: guests } = await supabase
      .from('guest_list')
      .select('id, first_name, last_name, needs_shuttle')
      .in('id', guestIds)

    setShuttleTaggedGuests((guests as TaggedGuestRow[] | null) || [])
  }, [supabase])

  useEffect(() => {
    fetchRuns()
    fetchShuttleTagged()
  }, [fetchRuns, fetchShuttleTagged])

  // Auto-populate: set needs_shuttle = true on all guests tagged "Shuttle".
  async function autoPopulateShuttleList() {
    if (!shuttleTag || shuttleTaggedGuests.length === 0) return
    const idsToUpdate = shuttleTaggedGuests
      .filter((g) => !g.needs_shuttle)
      .map((g) => g.id)
    if (idsToUpdate.length === 0) {
      setAutoPopulateStatus('All tagged guests are already marked as needing a shuttle.')
      return
    }
    const { error } = await supabase
      .from('guest_list')
      .update({ needs_shuttle: true })
      .in('id', idsToUpdate)
    if (error) {
      setAutoPopulateStatus(`Failed: ${error.message}`)
    } else {
      setAutoPopulateStatus(
        `Marked ${idsToUpdate.length} guest${idsToUpdate.length === 1 ? '' : 's'} as needing a shuttle.`,
      )
      fetchShuttleTagged()
    }
  }

  // ---- Location filtering ----
  function filterSuggestions(input: string): string[] {
    if (!input.trim() || pickupSuggestions.length === 0) return []
    const q = input.toLowerCase()
    return pickupSuggestions.filter((s) => s.toLowerCase().includes(q))
  }

  // ---- Generate Pre-Ceremony Runs ----
  function generatePreCeremony() {
    if (!preGen.time || !preGen.location) return
    const normalized = normalizeTimeInput(preGen.time)
    const ceremonyMin = timeToMinutes(normalized)
    if (isNaN(ceremonyMin)) {
      setGenError(`Couldn't parse ceremony time "${preGen.time}". Try "4:00 PM".`)
      return
    }

    // Target guest arrival: ceremonyMin - arrivalBufferMinutes.
    // Pickup departs earlier by TRANSIT_MINUTES so they arrive on time.
    const targetArrival = ceremonyMin - arrivalBufferMinutes
    const lastPickup = targetArrival - TRANSIT_MINUTES
    const newRuns: Omit<ShuttleRun, 'id'>[] = []

    if (shuttleCount > 1) {
      // Multi-shuttle: stagger pickups
      const staggerMinutes = 15
      for (let runIdx = 0; runIdx < preGen.numRuns; runIdx++) {
        for (let busIdx = 0; busIdx < shuttleCount; busIdx++) {
          const pickupMin = lastPickup - (preGen.numRuns - 1 - runIdx) * GAP_MINUTES + busIdx * staggerMinutes
          const dropoffMin = pickupMin + TRANSIT_MINUTES
          const letter = shuttleLetter(busIdx)
          const label = `Shuttle ${letter} \u2014 Pre-Ceremony Run ${runIdx + 1}`

          newRuns.push({
            run_label: label,
            pickup_location: preGen.location,
            pickup_time: timeToDb(minutesToTime(pickupMin)),
            dropoff_location: 'Venue',
            dropoff_time: timeToDb(minutesToTime(dropoffMin)),
            seat_count: seatsPerShuttle,
            notes: null,
            sort_order: runs.length + newRuns.length,
            shuttle_id: letter,
          })
        }
      }
    } else {
      // Single shuttle
      for (let i = 0; i < preGen.numRuns; i++) {
        const pickupMin = lastPickup - (preGen.numRuns - 1 - i) * GAP_MINUTES
        const dropoffMin = pickupMin + TRANSIT_MINUTES
        const label = `Pre-Ceremony Run ${i + 1} of ${preGen.numRuns}`

        newRuns.push({
          run_label: label,
          pickup_location: preGen.location,
          pickup_time: timeToDb(minutesToTime(pickupMin)),
          dropoff_location: 'Venue',
          dropoff_time: timeToDb(minutesToTime(dropoffMin)),
          seat_count: seatsPerShuttle,
          notes: null,
          sort_order: runs.length + i,
          shuttle_id: null,
        })
      }
    }

    insertRuns(newRuns)
  }

  // ---- Generate End of Night Runs ----
  function generateEndOfNight() {
    if (!postGen.time || !postGen.location) return
    const normalized = normalizeTimeInput(postGen.time)
    const endMin = timeToMinutes(normalized)
    if (isNaN(endMin)) {
      setGenError(`Couldn't parse end time "${postGen.time}". Try "11:00 PM".`)
      return
    }

    const newRuns: Omit<ShuttleRun, 'id'>[] = []

    if (shuttleCount > 1) {
      const staggerMinutes = 15
      for (let runIdx = 0; runIdx < postGen.numRuns; runIdx++) {
        for (let busIdx = 0; busIdx < shuttleCount; busIdx++) {
          const departMin = endMin + runIdx * GAP_MINUTES + busIdx * staggerMinutes
          const arriveMin = departMin + TRANSIT_MINUTES
          const letter = shuttleLetter(busIdx)
          const label = `Shuttle ${letter} \u2014 End of Night Run ${runIdx + 1}`

          newRuns.push({
            run_label: label,
            pickup_location: 'Venue',
            pickup_time: timeToDb(minutesToTime(departMin)),
            dropoff_location: postGen.location,
            dropoff_time: timeToDb(minutesToTime(arriveMin)),
            seat_count: seatsPerShuttle,
            notes: null,
            sort_order: runs.length + newRuns.length,
            shuttle_id: letter,
          })
        }
      }
    } else {
      for (let i = 0; i < postGen.numRuns; i++) {
        const departMin = endMin + i * GAP_MINUTES
        const arriveMin = departMin + TRANSIT_MINUTES
        const label = `End of Night \u2014 Run ${i + 1} of ${postGen.numRuns}`

        newRuns.push({
          run_label: label,
          pickup_location: 'Venue',
          pickup_time: timeToDb(minutesToTime(departMin)),
          dropoff_location: postGen.location,
          dropoff_time: timeToDb(minutesToTime(arriveMin)),
          seat_count: seatsPerShuttle,
          notes: null,
          sort_order: runs.length + i,
          shuttle_id: null,
        })
      }
    }

    insertRuns(newRuns)
  }

  async function insertRuns(newRuns: Omit<ShuttleRun, 'id'>[]) {
    const rows = newRuns.map((r) => ({
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      run_label: r.run_label,
      pickup_location: r.pickup_location,
      pickup_time: r.pickup_time,
      dropoff_location: r.dropoff_location,
      dropoff_time: r.dropoff_time,
      seat_count: r.seat_count,
      notes: r.notes,
      sort_order: r.sort_order,
      shuttle_id: r.shuttle_id,
    }))

    setGenError(null)
    const { error } = await supabase.from('shuttle_schedule').insert(rows)
    if (error) {
      console.error('[shuttle_schedule insert failed]', error)
      setGenError(
        `Couldn't save the schedule (${error.message}). The shuttle_schedule ` +
          `table may be missing the new columns — run migration 029.`,
      )
      return
    }
    fetchRuns()
  }

  // ---- Inline edit ----
  function startEdit(run: ShuttleRun, field: string) {
    let val = ''
    switch (field) {
      case 'run_label': val = run.run_label; break
      case 'pickup_location': val = run.pickup_location; break
      case 'pickup_time': val = dbToDisplay(run.pickup_time); break
      case 'dropoff_location': val = run.dropoff_location; break
      case 'dropoff_time': val = dbToDisplay(run.dropoff_time); break
      case 'seat_count': val = run.seat_count?.toString() || ''; break
      case 'notes': val = run.notes || ''; break
    }
    setEditField({ id: run.id, field })
    setEditValue(val)

    // Show suggestions for location fields
    if (field === 'pickup_location' || field === 'dropoff_location') {
      const matches = filterSuggestions(val)
      setEditLocationSuggestions(matches)
      setShowEditSuggestions(matches.length > 0)
    }

    setTimeout(() => editRef.current?.focus(), 0)
  }

  async function commitEdit() {
    if (!editField) return
    const { id, field } = editField

    let dbVal: string | number | null = editValue.trim() || null
    if (field === 'pickup_time' || field === 'dropoff_time') {
      dbVal = timeToDb(editValue) || null
    } else if (field === 'seat_count') {
      dbVal = editValue ? parseInt(editValue) || null : null
    }

    await supabase
      .from('shuttle_schedule')
      .update({ [field]: dbVal })
      .eq('id', id)

    setEditField(null)
    setEditValue('')
    setShowEditSuggestions(false)
    fetchRuns()
  }

  function cancelEdit() {
    setEditField(null)
    setEditValue('')
    setShowEditSuggestions(false)
  }

  function handleEditKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commitEdit() }
    if (e.key === 'Escape') cancelEdit()
  }

  function handleEditLocationChange(value: string) {
    setEditValue(value)
    const matches = filterSuggestions(value)
    setEditLocationSuggestions(matches)
    setShowEditSuggestions(matches.length > 0)
  }

  function selectEditSuggestion(suggestion: string) {
    setEditValue(suggestion)
    setShowEditSuggestions(false)
  }

  // ---- Delete ----
  async function handleDelete(id: string) {
    await supabase.from('shuttle_schedule').delete().eq('id', id)
    setDeleteConfirm(null)
    fetchRuns()
  }

  // ---- Rendering helpers ----
  function isEditing(runId: string, field: string) {
    return editField?.id === runId && editField?.field === field
  }

  function renderEditable(
    run: ShuttleRun,
    field: string,
    displayValue: string,
    placeholder: string,
    className?: string,
  ) {
    if (isEditing(run.id, field)) {
      const isLocationField = field === 'pickup_location' || field === 'dropoff_location'
      return (
        <div className="relative">
          <input
            ref={editRef as React.RefObject<HTMLInputElement>}
            type="text"
            value={editValue}
            onChange={(e) => isLocationField ? handleEditLocationChange(e.target.value) : setEditValue(e.target.value)}
            onBlur={() => {
              // Delay to allow suggestion click
              setTimeout(() => {
                commitEdit()
              }, 150)
            }}
            onKeyDown={handleEditKeyDown}
            placeholder={placeholder}
            className={cn(
              'px-2 py-1 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:border-transparent bg-white',
              className,
            )}
            style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
          />
          {isLocationField && showEditSuggestions && editLocationSuggestions.length > 0 && (
            <div className="absolute z-10 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden max-h-40 overflow-y-auto">
              {editLocationSuggestions.map((s) => (
                <button
                  key={s}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    selectEditSuggestion(s)
                  }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      )
    }

    return (
      <span
        onClick={() => startEdit(run, field)}
        className={cn(
          'cursor-pointer hover:bg-gray-100 rounded px-1.5 py-0.5 -mx-1.5 transition-colors text-sm',
          !displayValue && 'text-gray-400 italic',
          className,
        )}
        title="Click to edit"
      >
        {displayValue || placeholder}
      </span>
    )
  }

  function renderEditableTextarea(
    run: ShuttleRun,
    field: string,
    displayValue: string,
    placeholder: string,
  ) {
    if (isEditing(run.id, field)) {
      return (
        <textarea
          ref={editRef as React.RefObject<HTMLTextAreaElement>}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => { if (e.key === 'Escape') cancelEdit() }}
          placeholder={placeholder}
          rows={2}
          className="w-full px-2 py-1 border border-gray-300 rounded-md text-xs focus:outline-none focus:ring-2 focus:border-transparent bg-white resize-none"
          style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
        />
      )
    }

    return (
      <span
        onClick={() => startEdit(run, field)}
        className={cn(
          'cursor-pointer hover:bg-gray-100 rounded px-1.5 py-0.5 -mx-1.5 transition-colors text-xs',
          !displayValue ? 'text-gray-400 italic' : 'text-gray-500 italic',
        )}
        title="Click to edit"
      >
        {displayValue || placeholder}
      </span>
    )
  }

  // ---- Pickup location input with autocomplete ----
  function renderLocationInput(
    value: string,
    onChange: (v: string) => void,
    showSuggestions: boolean,
    setShowSuggestions: (v: boolean) => void,
    placeholder: string,
  ) {
    const matches = filterSuggestions(value)
    return (
      <div className="relative">
        <input
          type="text"
          value={value}
          onChange={(e) => {
            onChange(e.target.value)
            setShowSuggestions(filterSuggestions(e.target.value).length > 0)
          }}
          onFocus={() => {
            const m = filterSuggestions(value)
            if (m.length > 0) setShowSuggestions(true)
          }}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
          placeholder={placeholder}
          className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
          style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
        />
        {showSuggestions && matches.length > 0 && (
          <div className="absolute z-10 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden max-h-40 overflow-y-auto">
            {matches.map((s) => (
              <button
                key={s}
                onMouseDown={(e) => {
                  e.preventDefault()
                  onChange(s)
                  setShowSuggestions(false)
                }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 transition-colors"
              >
                <MapPin className="w-3 h-3 inline mr-1.5 text-gray-400" />
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  // ---- Loading ----
  if (loading) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="h-8 w-48 bg-gray-200 rounded" />
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-24 bg-gray-100 rounded-xl" />
        ))}
      </div>
    )
  }

  // ---- Stats ----
  const totalSeats = runs.reduce((sum, r) => sum + (r.seat_count || 0), 0)
  const totalCapacity = shuttleCount * seatsPerShuttle
  const preRuns = runs.filter((r) => r.run_label.toLowerCase().includes('pre-ceremony'))
  const postRuns = runs.filter((r) => r.run_label.toLowerCase().includes('end of night'))
  const otherRuns = runs.filter(
    (r) =>
      !r.run_label.toLowerCase().includes('pre-ceremony') &&
      !r.run_label.toLowerCase().includes('end of night'),
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1
          className="text-3xl font-bold mb-1"
          style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
        >
          Shuttle Schedule
        </h1>
        <p className="text-gray-500 text-sm">
          Plan shuttle runs for your guests before the ceremony and at the end of the night.
        </p>
      </div>

      {/* Shuttle Tag Stat + Auto-populate */}
      {shuttleTag && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex items-start gap-3">
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
                style={{ backgroundColor: `color-mix(in srgb, ${shuttleTag.color} 15%, white)` }}
              >
                <Bus className="w-5 h-5" style={{ color: shuttleTag.color }} />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
                    {shuttleTaggedGuests.length}
                  </p>
                  <p className="text-sm text-gray-600">
                    guest{shuttleTaggedGuests.length === 1 ? '' : 's'} need shuttle
                  </p>
                </div>
                <div className="flex items-center gap-1.5 mt-1">
                  <Tag className="w-3 h-3 text-gray-400" />
                  <span className="text-xs text-gray-500">
                    Tagged with
                  </span>
                  <TagChip tag={shuttleTag} />
                </div>
                {shuttleTaggedGuests.length > 0 && (
                  <p className="text-[11px] text-gray-400 mt-1.5">
                    {shuttleTaggedGuests.filter((g) => g.needs_shuttle).length} already marked as needing a shuttle.
                  </p>
                )}
              </div>
            </div>
            <button
              onClick={autoPopulateShuttleList}
              disabled={shuttleTaggedGuests.length === 0}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              style={{ backgroundColor: 'var(--couple-primary)' }}
            >
              <Sparkles className="w-4 h-4" />
              Auto-populate shuttle list from tagged guests
            </button>
          </div>
          {autoPopulateStatus && (
            <div className="mt-3 flex items-center gap-2 p-2 bg-emerald-50 border border-emerald-100 rounded-lg text-xs text-emerald-700">
              <Check className="w-3.5 h-3.5 shrink-0" />
              <span>{autoPopulateStatus}</span>
              <button
                onClick={() => setAutoPopulateStatus(null)}
                className="ml-auto text-emerald-400 hover:text-emerald-600"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Fleet Configuration */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <button
          onClick={() => setShowFleetConfig(!showFleetConfig)}
          className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors"
        >
          <div className="flex items-center gap-2">
            <Settings2 className="w-4 h-4" style={{ color: 'var(--couple-primary)' }} />
            <h2
              className="text-sm font-semibold"
              style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
            >
              Shuttle Fleet
            </h2>
            <span className="text-xs font-medium text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
              {shuttleCount} shuttle{shuttleCount !== 1 ? 's' : ''} &middot; {seatsPerShuttle} seats each &middot; {totalCapacity} total capacity
            </span>
          </div>
          {showFleetConfig ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
        </button>

        {showFleetConfig && (
          <div className="px-5 pb-5 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">Number of Shuttles</label>
                <div className="flex gap-2">
                  {SHUTTLE_COUNT_OPTIONS.map((n) => (
                    <button
                      key={n}
                      onClick={() => setShuttleCount(n)}
                      className={cn(
                        'flex-1 py-2 rounded-lg text-sm font-medium border transition-colors',
                        shuttleCount === n
                          ? 'text-white border-transparent'
                          : 'text-gray-600 border-gray-200 hover:border-gray-300 bg-white',
                      )}
                      style={shuttleCount === n ? { backgroundColor: 'var(--couple-primary)' } : undefined}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">Seats per Shuttle</label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={seatsPerShuttle}
                  onChange={(e) => setSeatsPerShuttle(parseInt(e.target.value) || SEATS_PER_SHUTTLE_DEFAULT)}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">Total Capacity</label>
                <div
                  className="flex items-center justify-center py-2 rounded-lg border border-gray-100 text-lg font-bold tabular-nums"
                  style={{ color: 'var(--couple-primary)', backgroundColor: 'color-mix(in srgb, var(--couple-primary) 5%, white)' }}
                >
                  {totalCapacity}
                  <span className="text-xs font-normal text-gray-400 ml-1.5">seats</span>
                </div>
              </div>
            </div>

            {shuttleCount > 1 && (
              <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-700">
                <Info className="w-4 h-4 mt-0.5 shrink-0 text-blue-500" />
                <p>
                  With {shuttleCount} shuttles, the generator will stagger departure times by 15 minutes
                  and label each run with a shuttle identifier (A, B, C...).
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Advisory */}
      <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-100 rounded-xl text-sm text-amber-800">
        <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0 text-amber-500" />
        <p className="text-xs">
          <span className="font-medium">Timing tip:</span> Avoid early arrivals — aim for pickups about
          5 minutes before guests are actually needed. Sitting around waiting is worse than a slightly
          snug schedule.
        </p>
      </div>

      {/* Generator error */}
      {genError && (
        <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-100 rounded-xl text-sm text-red-700">
          <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0 text-red-500" />
          <div className="flex-1">
            <p className="font-medium">Couldn&apos;t generate schedule</p>
            <p className="text-xs mt-0.5">{genError}</p>
          </div>
          <button
            onClick={() => setGenError(null)}
            className="text-red-400 hover:text-red-600 shrink-0"
            aria-label="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Smart Run Generators — two panels side by side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Pre-Ceremony Generator */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4" style={{ color: 'var(--couple-primary)' }} />
            <h2
              className="text-sm font-semibold"
              style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
            >
              Pre-Ceremony Generator
            </h2>
          </div>
          <p className="text-xs text-gray-500">
            Calculates pickup times working backward from your ceremony. Guests arrive{' '}
            {arrivalBufferMinutes} min before ceremony, {TRANSIT_MINUTES}-min transit,{' '}
            {GAP_MINUTES}-min spacing between runs.
            {shuttleCount > 1 && ` ${shuttleCount} shuttles staggered by 15 min.`}
          </p>

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Ceremony Time</label>
              <input
                type="text"
                value={preGen.time}
                onChange={(e) => setPreGen({ ...preGen, time: e.target.value })}
                placeholder="e.g. 4:00 PM"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Number of Runs</label>
              <div className="flex gap-2">
                {RUN_COUNT_OPTIONS.map((n) => (
                  <button
                    key={n}
                    onClick={() => setPreGen({ ...preGen, numRuns: n })}
                    className={cn(
                      'flex-1 py-2 rounded-lg text-sm font-medium border transition-colors',
                      preGen.numRuns === n
                        ? 'text-white border-transparent'
                        : 'text-gray-600 border-gray-200 hover:border-gray-300 bg-white',
                    )}
                    style={
                      preGen.numRuns === n
                        ? { backgroundColor: 'var(--couple-primary)' }
                        : undefined
                    }
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Pickup Location</label>
              {renderLocationInput(
                preGen.location,
                (v) => setPreGen({ ...preGen, location: v }),
                showPreSuggestions,
                setShowPreSuggestions,
                'e.g. Hampton Inn — Culpeper',
              )}
            </div>
          </div>

          <button
            onClick={generatePreCeremony}
            disabled={!preGen.time || !preGen.location}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            style={{ backgroundColor: 'var(--couple-primary)' }}
          >
            <Sparkles className="w-4 h-4" />
            Generate {preGen.numRuns * shuttleCount} Run{preGen.numRuns * shuttleCount > 1 ? 's' : ''}
          </button>
        </div>

        {/* End of Night Generator */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4" style={{ color: 'var(--couple-primary)' }} />
            <h2
              className="text-sm font-semibold"
              style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
            >
              End of Night Generator
            </h2>
          </div>
          <p className="text-xs text-gray-500">
            First shuttle departs at your event end time. {TRANSIT_MINUTES}-min transit, {GAP_MINUTES}
            -min spacing between runs.
            {shuttleCount > 1 && ` ${shuttleCount} shuttles staggered by 15 min.`}
          </p>

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Event End Time</label>
              <input
                type="text"
                value={postGen.time}
                onChange={(e) => setPostGen({ ...postGen, time: e.target.value })}
                placeholder="e.g. 11:00 PM"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Number of Runs</label>
              <div className="flex gap-2">
                {RUN_COUNT_OPTIONS.map((n) => (
                  <button
                    key={n}
                    onClick={() => setPostGen({ ...postGen, numRuns: n })}
                    className={cn(
                      'flex-1 py-2 rounded-lg text-sm font-medium border transition-colors',
                      postGen.numRuns === n
                        ? 'text-white border-transparent'
                        : 'text-gray-600 border-gray-200 hover:border-gray-300 bg-white',
                    )}
                    style={
                      postGen.numRuns === n
                        ? { backgroundColor: 'var(--couple-primary)' }
                        : undefined
                    }
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Drop-off Location</label>
              {renderLocationInput(
                postGen.location,
                (v) => setPostGen({ ...postGen, location: v }),
                showPostSuggestions,
                setShowPostSuggestions,
                'e.g. Hampton Inn — Culpeper',
              )}
            </div>
          </div>

          <button
            onClick={generateEndOfNight}
            disabled={!postGen.time || !postGen.location}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            style={{ backgroundColor: 'var(--couple-primary)' }}
          >
            <Sparkles className="w-4 h-4" />
            Generate {postGen.numRuns * shuttleCount} End-of-Night Run{postGen.numRuns * shuttleCount > 1 ? 's' : ''}
          </button>
        </div>
      </div>

      {/* Stats */}
      {runs.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
            <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
              {runs.length}
            </p>
            <p className="text-xs text-gray-500 font-medium">Total Runs</p>
          </div>
          <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
            <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
              {preRuns.length + postRuns.length}
            </p>
            <p className="text-xs text-gray-500 font-medium">Generated</p>
          </div>
          <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
            <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
              {totalSeats || '--'}
            </p>
            <p className="text-xs text-gray-500 font-medium">Total Seats</p>
          </div>
          <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
            <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
              {shuttleCount}
            </p>
            <p className="text-xs text-gray-500 font-medium">Shuttle{shuttleCount !== 1 ? 's' : ''}</p>
          </div>
        </div>
      )}

      {/* Runs List */}
      {runs.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <Bus className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--couple-primary)', opacity: 0.3 }} />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            No shuttle runs yet
          </h3>
          <p className="text-gray-500 text-sm mb-4">
            Use the generators above to create runs, or they will appear here once generated.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Pre-Ceremony Runs */}
          {preRuns.length > 0 && (
            <div className="space-y-2">
              <h2
                className="text-sm font-semibold text-gray-600 uppercase tracking-wider flex items-center gap-2"
              >
                <Clock className="w-3.5 h-3.5" />
                Pre-Ceremony ({preRuns.length})
              </h2>
              {preRuns.map((run) => renderRunCard(run))}
            </div>
          )}

          {/* End of Night Runs */}
          {postRuns.length > 0 && (
            <div className="space-y-2">
              <h2
                className="text-sm font-semibold text-gray-600 uppercase tracking-wider flex items-center gap-2 mt-4"
              >
                <Clock className="w-3.5 h-3.5" />
                End of Night ({postRuns.length})
              </h2>
              {postRuns.map((run) => renderRunCard(run))}
            </div>
          )}

          {/* Other / manual Runs */}
          {otherRuns.length > 0 && (
            <div className="space-y-2">
              <h2
                className="text-sm font-semibold text-gray-600 uppercase tracking-wider flex items-center gap-2 mt-4"
              >
                <Bus className="w-3.5 h-3.5" />
                Other Runs ({otherRuns.length})
              </h2>
              {otherRuns.map((run) => renderRunCard(run))}
            </div>
          )}
        </div>
      )}
    </div>
  )

  // ---- Run card renderer ----
  function renderRunCard(run: ShuttleRun) {
    const isDeleting = deleteConfirm === run.id

    return (
      <div
        key={run.id}
        className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 group hover:shadow-md transition-shadow"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            {/* Label row */}
            <div className="flex items-center gap-2 mb-3">
              <Bus className="w-4 h-4 shrink-0" style={{ color: 'var(--couple-primary)' }} />
              {renderEditable(run, 'run_label', run.run_label, 'Run label...', 'font-semibold text-gray-800')}
              {run.shuttle_id && (
                <span
                  className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                  style={{
                    backgroundColor: 'color-mix(in srgb, var(--couple-primary) 15%, white)',
                    color: 'var(--couple-primary)',
                  }}
                >
                  {run.shuttle_id}
                </span>
              )}
            </div>

            {/* Pickup -> Dropoff flow */}
            <div className="flex items-start gap-3">
              {/* Route dot-line visualization */}
              <div className="flex flex-col items-center gap-0.5 shrink-0 pt-1">
                <div
                  className="w-2.5 h-2.5 rounded-full border-2"
                  style={{ borderColor: 'var(--couple-primary)' }}
                />
                <div
                  className="w-0.5 h-12"
                  style={{ backgroundColor: 'var(--couple-primary)', opacity: 0.3 }}
                />
                <div
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: 'var(--couple-primary)' }}
                />
              </div>

              <div className="flex-1 space-y-3">
                {/* Pickup */}
                <div>
                  <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wider">
                    Pickup
                  </p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <MapPin className="w-3 h-3 text-gray-400 shrink-0" />
                    {renderEditable(run, 'pickup_location', run.pickup_location, 'Pickup location...')}
                    <span className="text-gray-300">|</span>
                    <Clock className="w-3 h-3 text-gray-400 shrink-0" />
                    {renderEditable(
                      run,
                      'pickup_time',
                      dbToDisplay(run.pickup_time),
                      'h:mm AM/PM',
                      'w-28',
                    )}
                  </div>
                </div>

                {/* Arrow */}
                <div className="flex items-center gap-1 text-gray-300 -my-1">
                  <ArrowRight className="w-3 h-3" />
                  <span className="text-[10px]">{TRANSIT_MINUTES} min transit</span>
                </div>

                {/* Dropoff */}
                <div>
                  <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wider">
                    Drop-off
                  </p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <MapPin className="w-3 h-3 text-gray-400 shrink-0" />
                    {renderEditable(run, 'dropoff_location', run.dropoff_location, 'Drop-off location...')}
                    <span className="text-gray-300">|</span>
                    <Clock className="w-3 h-3 text-gray-400 shrink-0" />
                    {renderEditable(
                      run,
                      'dropoff_time',
                      dbToDisplay(run.dropoff_time),
                      'h:mm AM/PM',
                      'w-28',
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Seat count + notes row */}
            <div className="flex items-center gap-4 mt-3 flex-wrap">
              <div className="flex items-center gap-1 text-xs text-gray-400">
                <Users className="w-3 h-3" />
                {renderEditable(run, 'seat_count', run.seat_count?.toString() || '', 'Seats', 'w-16')}
              </div>
              <div className="flex-1 min-w-0">
                {renderEditableTextarea(run, 'notes', run.notes || '', 'Add notes...')}
              </div>
            </div>
          </div>

          {/* Delete */}
          <div className="shrink-0">
            {isDeleting ? (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => handleDelete(run.id)}
                  className="p-1.5 rounded-md text-red-500 hover:bg-red-50"
                  title="Confirm delete"
                >
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setDeleteConfirm(null)}
                  className="p-1.5 rounded-md text-gray-400 hover:bg-gray-100"
                  title="Cancel"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setDeleteConfirm(run.id)}
                className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-opacity"
                title="Delete run"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }
}
