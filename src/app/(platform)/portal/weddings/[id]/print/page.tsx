'use client'

import { Suspense, useState, useEffect, useCallback } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  Printer,
  ArrowLeft,
  Check,
  Loader2,
} from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Person {
  id: string
  first_name: string | null
  last_name: string | null
  role: string | null
  email: string | null
  phone: string | null
}

interface Guest {
  id: string
  group_name: string | null
  rsvp_status: string | null
  meal_preference: string | null
  table_assignment_id: string | null
  dietary_restrictions: string | null
  plus_one: boolean | null
  plus_one_name: string | null
  care_notes: string | null
  person_id: string | null
}

interface CeremonyParticipant {
  id: string
  participant_name: string
  role: string | null
  side: string | null
  sort_order: number | null
  notes: string | null
}

interface ShuttleRun {
  id: string
  route_name: string
  pickup_location: string | null
  dropoff_location: string | null
  departure_time: string | null
  capacity: number | null
  notes: string | null
}

interface AllergyEntry {
  id: string
  guest_name: string
  allergy_type: string
  severity: string | null
  notes: string | null
  is_important: boolean | null
}

interface DecorItem {
  id: string
  item_name: string
  category: string | null
  quantity: number | null
  source: string | null
  vendor_name: string | null
  notes: string | null
  leaving_instructions: string | null
}

interface RoomAssignment {
  id: string
  room_name: string
  room_description: string | null
  guests: string[] | null
  notes: string | null
}

interface BookedVendor {
  id: string
  vendor_type: string
  vendor_name: string | null
  vendor_contact: string | null
  notes: string | null
  is_booked: boolean | null
  contract_uploaded: boolean | null
}

interface Contract {
  id: string
  vendor_id: string | null
  vendor_name: string | null
  filename: string | null
  status: string | null
}

interface TimelineRow {
  id: string
  time: string | null
  duration_minutes: number | null
  title: string
  description: string | null
  category: string | null
  location: string | null
  sort_order: number | null
  config_json?: {
    config?: { ceremonyTime?: string }
    events?: Array<{
      id: string
      name: string
      time: string
      duration: number
      included: boolean
      phase: string
      notes: string
    }>
    customEvents?: Array<{
      id: string
      name: string
      time: string
      duration: number
      notes?: string
      phase?: string
    }>
  } | null
}

interface WeddingDetails {
  wedding_colors: string | null
  ceremony_location: string | null
  arbor_choice: string | null
  unity_table: boolean | null
  ceremony_notes: string | null
  seating_method: string | null
  providing_table_numbers: boolean | null
  providing_charger_plates: boolean | null
  providing_champagne_glasses: boolean | null
  providing_cake_cutter: boolean | null
  providing_cake_topper: boolean | null
  favors_description: string | null
  reception_notes: string | null
  send_off_type: string | null
  send_off_notes: string | null
  dogs_coming: boolean | null
  dogs_description: string | null
}

interface WeddingPartyMember {
  id: string
  name: string
  role: string | null
  side: string | null
  relationship: string | null
}

interface MakeupSlot {
  id: string
  person_name: string
  role: string | null
  hair_time: string | null
  makeup_time: string | null
  notes: string | null
  sort_order: number | null
}

interface BarPlanning {
  bar_type: string | null
  guest_count: number | null
  bartender_count: number | null
  notes: string | null
}

interface BarShoppingItem {
  id: string
  item_name: string
  category: string | null
  quantity: number | null
  unit: string | null
  notes: string | null
  purchased: boolean | null
}

interface BarRecipe {
  id: string
  cocktail_name: string
  ingredients: unknown
  instructions: string | null
  servings: number | null
}

interface RehearsalDinner {
  location_name: string | null
  address: string | null
  date: string | null
  start_time: string | null
  end_time: string | null
  guest_count: number | null
  menu_notes: string | null
  special_arrangements: string | null
}

interface StaffingAssignment {
  id: string
  role: string | null
  person_name: string | null
  count: number | null
  hourly_rate: number | null
  hours: number | null
  notes: string | null
}

interface SeatingTable {
  id: string
  table_name: string | null
  table_type: string | null
  capacity: number | null
}

interface GuestCareNote {
  id: string
  guest_name: string
  care_type: string | null
  note: string | null
}

interface InternalNote {
  id: string
  content: string
  created_at: string
}

interface Wedding {
  id: string
  venue_id: string
  wedding_date: string | null
  guest_count_estimate: number | null
  ceremony_start: string | null
  reception_end: string | null
  event_code: string | null
  notes: string | null
}

// ---------------------------------------------------------------------------
// Section types
// ---------------------------------------------------------------------------

const ALL_SECTIONS = [
  { key: 'overview', label: 'Overview' },
  { key: 'details', label: 'Wedding Details' },
  { key: 'timeline', label: 'Timeline' },
  { key: 'ceremony', label: 'Ceremony Order' },
  { key: 'party', label: 'Wedding Party' },
  { key: 'vendors', label: 'Vendors' },
  { key: 'guests', label: 'Guest List' },
  { key: 'allergies', label: 'Allergies' },
  { key: 'guestCare', label: 'Guest Care' },
  { key: 'rooms', label: 'Bedrooms' },
  { key: 'tables', label: 'Tables / Seating' },
  { key: 'makeup', label: 'Hair & Makeup' },
  { key: 'shuttle', label: 'Shuttle' },
  { key: 'bar', label: 'Bar' },
  { key: 'decor', label: 'Décor' },
  { key: 'rehearsal', label: 'Rehearsal Dinner' },
  { key: 'staffing', label: 'Staffing' },
  { key: 'internal', label: 'Internal Notes' },
] as const

type SectionKey = (typeof ALL_SECTIONS)[number]['key']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'TBD'
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

function formatTime12(timeStr: string | null | undefined): string {
  if (!timeStr) return '--'
  let hours: number
  let minutes: number
  if (timeStr.includes('T')) {
    const d = new Date(timeStr)
    hours = d.getHours()
    minutes = d.getMinutes()
  } else if (/^\d+:\d+\s*(AM|PM|am|pm)/.test(timeStr)) {
    return timeStr
  } else {
    const parts = timeStr.split(':').map(Number)
    hours = parts[0]
    minutes = parts[1] ?? 0
    if (Number.isNaN(hours)) return timeStr
  }
  const ampm = hours >= 12 ? 'PM' : 'AM'
  const displayHours = hours % 12 || 12
  return `${displayHours}:${String(minutes).padStart(2, '0')} ${ampm}`
}

function timeToMin(time: string): number {
  // Handle HH:MM and H:MM AM/PM
  const ampm = time.match(/(\d+):(\d+)\s*(AM|PM)/i)
  if (ampm) {
    let h = parseInt(ampm[1])
    const m = parseInt(ampm[2])
    const isPm = ampm[3].toUpperCase() === 'PM'
    if (isPm && h !== 12) h += 12
    if (!isPm && h === 12) h = 0
    return h * 60 + m
  }
  const [h, m] = time.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

function getCoupleNames(people: Person[]): string {
  const principals = people.filter(
    (p) => p.role === 'partner1' || p.role === 'partner2'
  )
  if (principals.length === 0) {
    const first = people.slice(0, 2)
    return first.map((p) => p.first_name).filter(Boolean).join(' & ') || 'Wedding'
  }
  return principals.map((p) => p.first_name).filter(Boolean).join(' & ')
}

function isNonEmpty<T>(v: T | null | undefined): v is T {
  return v !== null && v !== undefined && (typeof v !== 'string' || v.trim().length > 0)
}

function settledData<T>(res: PromiseSettledResult<{ data: T | null; error: unknown }>): T | null {
  if (res.status !== 'fulfilled') return null
  if (res.value.error) return null
  return res.value.data
}

function settledArray<T>(res: PromiseSettledResult<{ data: T[] | null; error: unknown }>): T[] {
  if (res.status !== 'fulfilled') return []
  if (res.value.error) return []
  return res.value.data ?? []
}

// ---------------------------------------------------------------------------
// Sub-components: small, repeatable building blocks
// ---------------------------------------------------------------------------

function DataRow({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined || value === '') return null
  const display =
    value === true ? 'Yes' : value === false ? 'No' : String(value).trim()
  if (!display) return null
  return (
    <div className="data-row">
      <span className="data-label">{label}</span>
      <span className="data-value">{display}</span>
    </div>
  )
}

function NotesBlock({ label, value }: { label: string; value: string | null | undefined }) {
  if (!isNonEmpty(value)) return null
  return (
    <div className="notes-block">
      <strong>{label}:</strong> {value}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Print Page wrapper
// ---------------------------------------------------------------------------

export default function PrintDayOfPackagePageWrapper() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="flex items-center gap-3 text-sage-500">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">Loading print package...</span>
        </div>
      </div>
    }>
      <PrintDayOfPackagePage />
    </Suspense>
  )
}

function PrintDayOfPackagePage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const weddingId = params.id as string

  const requestedSections = searchParams.get('sections')
  const initialSections: Set<SectionKey> = requestedSections
    ? new Set(requestedSections.split(',').filter((s): s is SectionKey => ALL_SECTIONS.some((as) => as.key === s)))
    : new Set(ALL_SECTIONS.map((s) => s.key))

  const [selectedSections, setSelectedSections] = useState<Set<SectionKey>>(initialSections)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Data state
  const [wedding, setWedding] = useState<Wedding | null>(null)
  const [venueName, setVenueName] = useState<string>('')
  const [people, setPeople] = useState<Person[]>([])
  const [guests, setGuests] = useState<Guest[]>([])
  const [timeline, setTimeline] = useState<TimelineRow | null>(null)
  const [timelineRows, setTimelineRows] = useState<TimelineRow[]>([])
  const [ceremony, setCeremony] = useState<CeremonyParticipant[]>([])
  const [shuttles, setShuttles] = useState<ShuttleRun[]>([])
  const [allergies, setAllergies] = useState<AllergyEntry[]>([])
  const [decor, setDecor] = useState<DecorItem[]>([])
  const [rooms, setRooms] = useState<RoomAssignment[]>([])
  const [vendors, setVendors] = useState<BookedVendor[]>([])
  const [contracts, setContracts] = useState<Contract[]>([])
  const [details, setDetails] = useState<WeddingDetails | null>(null)
  const [party, setParty] = useState<WeddingPartyMember[]>([])
  const [makeup, setMakeup] = useState<MakeupSlot[]>([])
  const [bar, setBar] = useState<BarPlanning | null>(null)
  const [barShopping, setBarShopping] = useState<BarShoppingItem[]>([])
  const [barRecipes, setBarRecipes] = useState<BarRecipe[]>([])
  const [rehearsal, setRehearsal] = useState<RehearsalDinner | null>(null)
  const [staffing, setStaffing] = useState<StaffingAssignment[]>([])
  const [seatingTables, setSeatingTables] = useState<SeatingTable[]>([])
  const [guestCare, setGuestCare] = useState<GuestCareNote[]>([])
  const [internalNotes, setInternalNotes] = useState<InternalNote[]>([])

  const fetchData = useCallback(async () => {
    try {
      const supabase = createClient()

      const { data: weddingData, error: weddingErr } = await supabase
        .from('weddings')
        .select('id, venue_id, wedding_date, guest_count_estimate, ceremony_start, reception_end, event_code, notes')
        .eq('id', weddingId)
        .single()

      if (weddingErr) throw weddingErr
      setWedding(weddingData as Wedding)

      const venueId = weddingData.venue_id

      // Fetch venue name
      supabase
        .from('venues')
        .select('name')
        .eq('id', venueId)
        .maybeSingle()
        .then(({ data }) => {
          if (data?.name) setVenueName(data.name)
        })

      // Fetch all data in parallel with Promise.allSettled — any single
      // failure (e.g. table missing on older deploys) does not break the page.
      const [
        peopleRes,
        guestRes,
        timelineSingleRes,
        timelineRowsRes,
        ceremonyRes,
        shuttleRes,
        allergyRes,
        decorRes,
        roomRes,
        vendorRes,
        contractRes,
        detailsRes,
        partyRes,
        makeupRes,
        barRes,
        barShoppingRes,
        barRecipesRes,
        rehearsalRes,
        staffingRes,
        seatingTablesRes,
        guestCareRes,
        internalNotesRes,
      ] = await Promise.allSettled([
        supabase.from('people').select('id, first_name, last_name, role, email, phone').eq('wedding_id', weddingId),
        supabase.from('guest_list').select('id, group_name, rsvp_status, meal_preference, table_assignment_id, dietary_restrictions, plus_one, plus_one_name, care_notes, person_id').eq('wedding_id', weddingId),
        supabase.from('timeline').select('*').eq('wedding_id', weddingId).maybeSingle(),
        supabase.from('timeline').select('id, time, duration_minutes, title, description, category, location, sort_order').eq('wedding_id', weddingId).order('sort_order', { ascending: true }),
        supabase.from('ceremony_order').select('id, participant_name, role, side, sort_order, notes').eq('wedding_id', weddingId).order('sort_order'),
        supabase.from('shuttle_schedule').select('id, route_name, pickup_location, dropoff_location, departure_time, capacity, notes').eq('wedding_id', weddingId).order('departure_time'),
        supabase.from('allergy_registry').select('id, guest_name, allergy_type, severity, notes, is_important').eq('wedding_id', weddingId),
        supabase.from('decor_inventory').select('id, item_name, category, quantity, source, vendor_name, notes, leaving_instructions').eq('wedding_id', weddingId).order('category'),
        supabase.from('bedroom_assignments').select('id, room_name, room_description, guests, notes').eq('wedding_id', weddingId).order('room_name'),
        supabase.from('booked_vendors').select('id, vendor_type, vendor_name, vendor_contact, notes, is_booked, contract_uploaded').eq('wedding_id', weddingId).order('vendor_type'),
        supabase.from('contracts').select('id, vendor_id, vendor_name, filename, status').eq('wedding_id', weddingId),
        supabase.from('wedding_details').select('*').eq('wedding_id', weddingId).maybeSingle(),
        supabase.from('wedding_party').select('id, name, role, side, relationship').eq('wedding_id', weddingId).order('sort_order'),
        supabase.from('makeup_schedule').select('id, person_name, role, hair_time, makeup_time, notes, sort_order').eq('wedding_id', weddingId).order('sort_order'),
        supabase.from('bar_planning').select('bar_type, guest_count, bartender_count, notes').eq('wedding_id', weddingId).maybeSingle(),
        supabase.from('bar_shopping_list').select('id, item_name, category, quantity, unit, notes, purchased').eq('wedding_id', weddingId).order('category'),
        supabase.from('bar_recipes').select('id, cocktail_name, ingredients, instructions, servings').eq('wedding_id', weddingId),
        supabase.from('rehearsal_dinner').select('location_name, address, date, start_time, end_time, guest_count, menu_notes, special_arrangements').eq('wedding_id', weddingId).maybeSingle(),
        supabase.from('staffing_assignments').select('id, role, person_name, count, hourly_rate, hours, notes').eq('wedding_id', weddingId),
        supabase.from('seating_tables').select('id, table_name, table_type, capacity').eq('wedding_id', weddingId).order('table_name'),
        supabase.from('guest_care_notes').select('id, guest_name, care_type, note').eq('wedding_id', weddingId),
        // Internal notes — table added in migration 097, may not exist on
        // older deploys. Failure is silently swallowed by allSettled.
        supabase.from('wedding_internal_notes').select('id, content, created_at').eq('wedding_id', weddingId).order('created_at', { ascending: false }),
      ])

      setPeople(settledArray<Person>(peopleRes))
      setGuests(settledArray<Guest>(guestRes))
      setTimeline(settledData<TimelineRow>(timelineSingleRes))
      setTimelineRows(settledArray<TimelineRow>(timelineRowsRes))
      setCeremony(settledArray<CeremonyParticipant>(ceremonyRes))
      setShuttles(settledArray<ShuttleRun>(shuttleRes))
      setAllergies(settledArray<AllergyEntry>(allergyRes))
      setDecor(settledArray<DecorItem>(decorRes))
      setRooms(settledArray<RoomAssignment>(roomRes))
      setVendors(settledArray<BookedVendor>(vendorRes))
      setContracts(settledArray<Contract>(contractRes))
      setDetails(settledData<WeddingDetails>(detailsRes))
      setParty(settledArray<WeddingPartyMember>(partyRes))
      setMakeup(settledArray<MakeupSlot>(makeupRes))
      setBar(settledData<BarPlanning>(barRes))
      setBarShopping(settledArray<BarShoppingItem>(barShoppingRes))
      setBarRecipes(settledArray<BarRecipe>(barRecipesRes))
      setRehearsal(settledData<RehearsalDinner>(rehearsalRes))
      setStaffing(settledArray<StaffingAssignment>(staffingRes))
      setSeatingTables(settledArray<SeatingTable>(seatingTablesRes))
      setGuestCare(settledArray<GuestCareNote>(guestCareRes))
      setInternalNotes(settledArray<InternalNote>(internalNotesRes))

      setError(null)
    } catch (err) {
      console.error('Failed to fetch print data:', err)
      setError('Failed to load wedding data')
    } finally {
      setLoading(false)
    }
  }, [weddingId])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  function toggleSection(key: SectionKey) {
    setSelectedSections((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Build sorted timeline event list. Prefer config_json events when present
  // (couple-portal builder writes there); otherwise use per-row timeline.
  const timelineEvents: Array<{ id: string; time: string; name: string; duration: number; phase: string; notes: string }> = (() => {
    const out: Array<{ id: string; time: string; name: string; duration: number; phase: string; notes: string }> = []
    if (timeline?.config_json?.events) {
      for (const e of timeline.config_json.events) {
        if (!e.included || !e.time) continue
        out.push({ id: e.id, time: e.time, name: e.name, duration: e.duration ?? 0, phase: e.phase ?? '', notes: e.notes ?? '' })
      }
      for (const e of timeline.config_json.customEvents ?? []) {
        if (!e.time) continue
        out.push({ id: e.id, time: e.time, name: e.name, duration: e.duration ?? 0, phase: e.phase ?? '', notes: e.notes ?? '' })
      }
    } else if (timelineRows.length > 0) {
      for (const r of timelineRows) {
        if (!r.time) continue
        out.push({ id: r.id, time: r.time, name: r.title, duration: r.duration_minutes ?? 0, phase: r.category ?? '', notes: [r.location, r.description].filter(Boolean).join(' • ') })
      }
    }
    out.sort((a, b) => timeToMin(a.time) - timeToMin(b.time))
    return out
  })()

  // Build keyed lookups
  const peopleById = new Map(people.map((p) => [p.id, p]))
  const tablesById = new Map(seatingTables.map((t) => [t.id, t]))

  // Group guests by table for the seating section
  const seatingByTable: Record<string, Array<{ guest: Guest; person: Person | null }>> = {}
  const unseatedGuests: Array<{ guest: Guest; person: Person | null }> = []
  for (const g of guests) {
    const person = g.person_id ? peopleById.get(g.person_id) ?? null : null
    const entry = { guest: g, person }
    if (g.table_assignment_id) {
      if (!seatingByTable[g.table_assignment_id]) seatingByTable[g.table_assignment_id] = []
      seatingByTable[g.table_assignment_id].push(entry)
    } else {
      unseatedGuests.push(entry)
    }
  }

  // Quick reference: keys vendors (photo, catering, dj)
  const KEY_VENDOR_TYPES = ['photographer', 'catering', 'caterer', 'florist', 'dj', 'planner', 'coordinator', 'officiant']
  const keyVendors = vendors.filter((v) =>
    KEY_VENDOR_TYPES.some((k) => v.vendor_type.toLowerCase().includes(k))
  )

  // Bar shopping by category
  const barShoppingByCat: Record<string, BarShoppingItem[]> = {}
  for (const item of barShopping) {
    const cat = item.category || 'other'
    if (!barShoppingByCat[cat]) barShoppingByCat[cat] = []
    barShoppingByCat[cat].push(item)
  }

  // Décor by category (space)
  const decorByCategory: Record<string, DecorItem[]> = {}
  for (const item of decor) {
    const cat = item.category || 'other'
    if (!decorByCategory[cat]) decorByCategory[cat] = []
    decorByCategory[cat].push(item)
  }

  // Staffing summary by day. The schema doesn't carry friday/saturday split,
  // but rehearsal_dinner runs Friday and the wedding day Saturday. Render a
  // simple total + breakdown by role.
  const staffingTotal = staffing.reduce((s, x) => s + (x.count ?? 1), 0)
  const staffingByRole: Record<string, number> = {}
  for (const s of staffing) {
    const r = s.role ?? 'other'
    staffingByRole[r] = (staffingByRole[r] ?? 0) + (s.count ?? 1)
  }

  // Contracts lookup by vendor_id
  const contractsByVendor = new Map<string, Contract>()
  for (const c of contracts) {
    if (c.vendor_id) contractsByVendor.set(c.vendor_id, c)
  }

  const coupleNames = people.length > 0 ? getCoupleNames(people) : 'Wedding'
  const guestCount = wedding?.guest_count_estimate ?? guests.length

  // Visibility helpers — hide sections that have no data so the printout
  // doesn't waste paper.
  const hasOverview = !!wedding
  const hasDetails = !!details && Object.values(details).some((v) => isNonEmpty(v))
  const hasTimeline = timelineEvents.length > 0
  const hasCeremony = ceremony.length > 0
  const hasParty = party.length > 0
  const hasVendors = vendors.length > 0
  const hasGuests = guests.length > 0
  const hasAllergies = allergies.length > 0
  const hasGuestCare = guestCare.length > 0
  const hasRooms = rooms.length > 0
  const hasTables = seatingTables.length > 0 || guests.some((g) => !!g.table_assignment_id)
  const hasMakeup = makeup.length > 0
  const hasShuttle = shuttles.length > 0
  const hasBar =
    !!bar?.bar_type || barShopping.length > 0 || barRecipes.length > 0
  const hasDecor = decor.length > 0
  const hasRehearsal = !!rehearsal && Object.values(rehearsal).some((v) => isNonEmpty(v))
  const hasStaffing = staffing.length > 0
  const hasInternal = internalNotes.length > 0

  const visibleSections: Record<SectionKey, boolean> = {
    overview: hasOverview,
    details: hasDetails,
    timeline: hasTimeline,
    ceremony: hasCeremony,
    party: hasParty,
    vendors: hasVendors,
    guests: hasGuests,
    allergies: hasAllergies,
    guestCare: hasGuestCare,
    rooms: hasRooms,
    tables: hasTables,
    makeup: hasMakeup,
    shuttle: hasShuttle,
    bar: hasBar,
    decor: hasDecor,
    rehearsal: hasRehearsal,
    staffing: hasStaffing,
    internal: hasInternal,
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="flex items-center gap-3 text-sage-500">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">Loading print package...</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-center">
        <p className="text-sm text-red-700 mb-3">{error}</p>
        <button
          onClick={() => {
            setLoading(true)
            fetchData()
          }}
          className="text-sm font-medium text-red-600 hover:text-red-800"
        >
          Retry
        </button>
      </div>
    )
  }

  function show(key: SectionKey) {
    return selectedSections.has(key) && visibleSections[key]
  }

  const printedAt = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

  return (
    <>
      {/* Print-specific styles */}
      <style dangerouslySetInnerHTML={{ __html: `
        @media print {
          .no-print, nav, aside, header, .sidebar, [data-shell] {
            display: none !important;
          }
          body {
            margin: 0 !important;
            padding: 0 !important;
            background: white !important;
          }
          main { padding: 0 !important; margin: 0 !important; }
          main > div { padding: 0 !important; max-width: 100% !important; }
          .print-page {
            font-family: 'Georgia', 'Times New Roman', serif !important;
            color: #000 !important;
            font-size: 11pt !important;
            line-height: 1.4 !important;
          }
          .print-header {
            text-align: center;
            border-bottom: 2px solid #333;
            padding-bottom: 12pt;
            margin-bottom: 16pt;
          }
          .print-header h1 { font-size: 22pt !important; margin-bottom: 4pt !important; }
          .print-header p { font-size: 11pt !important; color: #555 !important; }
          .print-section {
            page-break-inside: avoid;
            break-inside: avoid;
            margin-bottom: 22pt;
          }
          .print-section-break {
            page-break-before: always;
            break-before: page;
          }
          .print-subsection {
            page-break-inside: avoid;
            break-inside: avoid;
            margin-bottom: 14pt;
          }
          .print-section h2 {
            font-size: 14pt !important;
            border-bottom: 1px solid #999;
            padding-bottom: 4pt;
            margin-bottom: 8pt;
          }
          .print-section h3 {
            font-size: 11pt !important;
            font-weight: 700;
            margin-top: 8pt;
            margin-bottom: 4pt;
            color: #333;
          }
          .print-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 10pt !important;
          }
          .print-table th {
            background: #f0f0f0 !important;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
            border: 1px solid #ccc;
            padding: 4pt 6pt;
            text-align: left;
            font-weight: 600;
            font-size: 9pt;
          }
          .print-table td {
            border: 1px solid #ddd;
            padding: 3pt 6pt;
            vertical-align: top;
          }
          .print-table tr:nth-child(even) {
            background: #fafafa !important;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          .print-empty {
            text-align: center;
            color: #999;
            font-style: italic;
            padding: 12pt;
          }
          .data-row {
            display: flex; flex-direction: column;
            padding: 4pt 6pt; border: 1px solid #ddd;
            background: #fafafa !important;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
            border-radius: 2pt;
          }
          .info-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 4pt;
          }
        }
        .print-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
        }
        .print-table th {
          background: #f8f8f6;
          border: 1px solid #e5e5e0;
          padding: 6px 10px;
          text-align: left;
          font-weight: 600;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.03em;
          color: #6b7280;
        }
        .print-table td {
          border: 1px solid #e5e5e0;
          padding: 5px 10px;
          vertical-align: top;
          color: #374151;
        }
        .print-table tr:nth-child(even) { background: #fafaf8; }
        .info-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 8px;
        }
        .info-grid.cols-3 { grid-template-columns: repeat(3, 1fr); }
        .data-row {
          display: flex; flex-direction: column; gap: 2px;
          padding: 8px 12px;
          background: #faf8f5;
          border-radius: 6px;
          border: 1px solid #ede8e0;
        }
        .data-label {
          font-size: 10px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #9a8b7a;
        }
        .data-value { font-size: 13px; color: #2d3748; }
        .notes-block {
          margin-top: 8px;
          padding: 8px 12px;
          background: #faf8f5;
          border: 1px solid #ede8e0;
          border-radius: 6px;
          font-size: 12px;
          color: #4a5568;
        }
      ` }} />

      <div className="print-page space-y-6 pb-12">
        {/* Screen-only controls */}
        <div className="no-print space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <Link
              href={`/portal/weddings/${weddingId}/portal`}
              className="text-sage-400 hover:text-sage-600 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <span className="text-xs text-sage-400">Back to Wedding</span>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <h1 className="font-heading text-2xl font-bold text-sage-900">
                Day-of Print Package
              </h1>
              <p className="text-sm text-sage-500">
                {coupleNames} {wedding?.wedding_date ? `- ${formatDate(wedding.wedding_date)}` : ''}
              </p>
            </div>
            <button
              onClick={() => window.print()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-sage-600 text-white hover:bg-sage-700 transition-colors shrink-0"
            >
              <Printer className="w-4 h-4" />
              Print this page
            </button>
          </div>

          <div className="bg-surface border border-border rounded-xl p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-3">
              Select sections to include
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {ALL_SECTIONS.map((section) => {
                const available = visibleSections[section.key]
                return (
                  <button
                    key={section.key}
                    onClick={() => available && toggleSection(section.key)}
                    disabled={!available}
                    className={cn(
                      'flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors border text-left',
                      !available
                        ? 'border-gray-100 bg-gray-50 text-gray-300 cursor-not-allowed'
                        : selectedSections.has(section.key)
                          ? 'border-sage-300 bg-sage-50 text-sage-800'
                          : 'border-gray-200 bg-white text-gray-400'
                    )}
                  >
                    <div
                      className={cn(
                        'w-4 h-4 rounded flex items-center justify-center shrink-0',
                        !available
                          ? 'border border-gray-200'
                          : selectedSections.has(section.key)
                            ? 'bg-sage-600'
                            : 'border-2 border-gray-300'
                      )}
                    >
                      {available && selectedSections.has(section.key) && (
                        <Check className="w-3 h-3 text-white" />
                      )}
                    </div>
                    <span>{section.label}</span>
                    {!available && <span className="ml-auto text-[10px] uppercase text-gray-300">Empty</span>}
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        {/* Print header */}
        <div className="print-header text-center border-b-2 border-sage-200 pb-4">
          <h1 className="font-heading text-3xl font-bold text-sage-900">{coupleNames}</h1>
          <p className="text-sm text-sage-600 mt-1">
            {wedding?.wedding_date ? formatDate(wedding.wedding_date) : 'Date TBD'}
            {venueName ? ` · ${venueName}` : ''}
          </p>
          {wedding?.event_code && (
            <p className="text-xs text-sage-400 mt-1">Event Code: {wedding.event_code}</p>
          )}
          <p className="text-xs text-sage-400 mt-1">Day-of Coordination Package · Printed {printedAt}</p>
        </div>

        {/* OVERVIEW / QUICK REFERENCE */}
        {show('overview') && (
          <div className="print-section">
            <h2 className="text-lg font-heading font-semibold text-sage-900 border-b border-sage-200 pb-2 mb-3">
              Quick Reference
            </h2>
            <div className="info-grid">
              <DataRow label="Couple" value={coupleNames} />
              <DataRow label="Date" value={wedding?.wedding_date ? formatDate(wedding.wedding_date) : null} />
              <DataRow label="Venue" value={venueName} />
              <DataRow label="Event Code" value={wedding?.event_code} />
              <DataRow label="Guest Count" value={guestCount} />
              <DataRow label="Ceremony Start" value={formatTime12(wedding?.ceremony_start ?? null)} />
              <DataRow label="Reception End" value={formatTime12(wedding?.reception_end ?? null)} />
              {keyVendors.slice(0, 6).map((v) => (
                <DataRow
                  key={v.id}
                  label={v.vendor_type}
                  value={[v.vendor_name, v.vendor_contact].filter(Boolean).join(' · ')}
                />
              ))}
            </div>
            <NotesBlock label="Notes" value={wedding?.notes} />
          </div>
        )}

        {/* WEDDING DETAILS */}
        {show('details') && details && (
          <div className="print-section print-section-break">
            <h2 className="text-lg font-heading font-semibold text-sage-900 border-b border-sage-200 pb-2 mb-3">
              Wedding Details
            </h2>
            <div className="info-grid">
              <DataRow label="Colors" value={details.wedding_colors} />
              <DataRow label="Ceremony Location" value={details.ceremony_location} />
              <DataRow label="Arbor" value={details.arbor_choice} />
              <DataRow label="Unity Table" value={details.unity_table} />
              <DataRow label="Seating Method" value={details.seating_method} />
              <DataRow label="Send-Off" value={details.send_off_type} />
              <DataRow label="Dogs Coming" value={details.dogs_coming === true ? `Yes${details.dogs_description ? ` — ${details.dogs_description}` : ''}` : details.dogs_coming === false ? 'No' : null} />
              <DataRow label="Table Numbers" value={details.providing_table_numbers === true ? 'Couple providing' : details.providing_table_numbers === false ? 'Not needed' : null} />
              <DataRow label="Charger Plates" value={details.providing_charger_plates === true ? 'Couple providing' : details.providing_charger_plates === false ? 'Not providing' : null} />
              <DataRow label="Champagne Glasses" value={details.providing_champagne_glasses === true ? 'Couple providing' : details.providing_champagne_glasses === false ? 'Not providing' : null} />
              <DataRow label="Cake Cutter" value={details.providing_cake_cutter === true ? 'Couple providing' : details.providing_cake_cutter === false ? 'Not providing' : null} />
              <DataRow label="Cake Topper" value={details.providing_cake_topper === true ? 'Couple providing' : details.providing_cake_topper === false ? 'Not providing' : null} />
              <DataRow label="Favors" value={details.favors_description} />
            </div>
            <NotesBlock label="Ceremony notes" value={details.ceremony_notes} />
            <NotesBlock label="Reception notes" value={details.reception_notes} />
            <NotesBlock label="Send-off notes" value={details.send_off_notes} />
          </div>
        )}

        {/* TIMELINE */}
        {show('timeline') && (
          <div className="print-section print-section-break">
            <h2 className="text-lg font-heading font-semibold text-sage-900 border-b border-sage-200 pb-2 mb-3">
              Timeline
            </h2>
            <table className="print-table">
              <thead>
                <tr>
                  <th style={{ width: '90px' }}>Time</th>
                  <th>Event</th>
                  <th style={{ width: '70px' }}>Length</th>
                  <th style={{ width: '120px' }}>Phase</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {timelineEvents.map((e) => (
                  <tr key={e.id}>
                    <td className="tabular-nums">{formatTime12(e.time)}</td>
                    <td className="font-medium">{e.name}</td>
                    <td className="text-gray-500 tabular-nums">{e.duration > 0 ? `${e.duration} min` : '--'}</td>
                    <td className="capitalize text-gray-500">{e.phase?.replace(/_/g, ' ') || '--'}</td>
                    <td className="text-gray-500">{e.notes || '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* CEREMONY ORDER */}
        {show('ceremony') && (
          <div className="print-section print-section-break">
            <h2 className="text-lg font-heading font-semibold text-sage-900 border-b border-sage-200 pb-2 mb-3">
              Ceremony Order
            </h2>
            <table className="print-table">
              <thead>
                <tr>
                  <th style={{ width: '40px' }}>#</th>
                  <th>Participant</th>
                  <th style={{ width: '140px' }}>Role</th>
                  <th style={{ width: '80px' }}>Side</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {ceremony.map((p, idx) => (
                  <tr key={p.id}>
                    <td className="text-gray-400 tabular-nums">{idx + 1}</td>
                    <td className="font-medium">{p.participant_name}</td>
                    <td className="capitalize text-gray-600">{p.role?.replace(/_/g, ' ') || '--'}</td>
                    <td className="capitalize text-gray-500">{p.side || '--'}</td>
                    <td className="text-gray-500 text-xs">{p.notes || '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* WEDDING PARTY */}
        {show('party') && (
          <div className="print-section print-section-break">
            <h2 className="text-lg font-heading font-semibold text-sage-900 border-b border-sage-200 pb-2 mb-3">
              Wedding Party ({party.length})
            </h2>
            <table className="print-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th style={{ width: '160px' }}>Role</th>
                  <th style={{ width: '80px' }}>Side</th>
                  <th>Relationship</th>
                </tr>
              </thead>
              <tbody>
                {party.map((m) => (
                  <tr key={m.id}>
                    <td className="font-medium">{m.name}</td>
                    <td className="capitalize text-gray-600">{m.role?.replace(/_/g, ' ') || '--'}</td>
                    <td className="capitalize text-gray-500">{m.side || '--'}</td>
                    <td className="text-gray-500">{m.relationship || '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* VENDORS */}
        {show('vendors') && (
          <div className="print-section print-section-break">
            <h2 className="text-lg font-heading font-semibold text-sage-900 border-b border-sage-200 pb-2 mb-3">
              Vendors ({vendors.length})
            </h2>
            <table className="print-table">
              <thead>
                <tr>
                  <th style={{ width: '140px' }}>Type</th>
                  <th>Vendor</th>
                  <th>Contact</th>
                  <th style={{ width: '90px' }}>Booked</th>
                  <th style={{ width: '90px' }}>Contract</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {vendors.map((v) => {
                  const contract = contractsByVendor.get(v.id)
                  const contractStatus = v.contract_uploaded || contract
                    ? 'Yes'
                    : 'No'
                  return (
                    <tr key={v.id}>
                      <td className="capitalize font-medium">{v.vendor_type}</td>
                      <td>{v.vendor_name || '--'}</td>
                      <td className="text-sm">{v.vendor_contact || '--'}</td>
                      <td>{v.is_booked ? 'Yes' : 'Pending'}</td>
                      <td>{contractStatus}</td>
                      <td className="text-gray-500 text-xs">{v.notes || '--'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* GUEST LIST */}
        {show('guests') && (
          <div className="print-section print-section-break">
            <h2 className="text-lg font-heading font-semibold text-sage-900 border-b border-sage-200 pb-2 mb-3">
              Guest List ({guests.length} guests)
            </h2>
            <table className="print-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th style={{ width: '90px' }}>RSVP</th>
                  <th style={{ width: '120px' }}>Meal</th>
                  <th style={{ width: '100px' }}>Table</th>
                  <th>Dietary</th>
                  <th>Tags / Care</th>
                </tr>
              </thead>
              <tbody>
                {guests
                  .map((g) => ({ g, p: g.person_id ? peopleById.get(g.person_id) ?? null : null }))
                  .sort((a, b) => (a.p?.last_name ?? '').localeCompare(b.p?.last_name ?? ''))
                  .map(({ g, p }) => {
                    const tableName = g.table_assignment_id
                      ? tablesById.get(g.table_assignment_id)?.table_name ?? '--'
                      : '--'
                    return (
                      <tr key={g.id}>
                        <td className="font-medium">
                          {p ? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() : g.group_name || '--'}
                          {g.plus_one && (
                            <span className="block text-xs text-gray-500">+ {g.plus_one_name || 'plus one'}</span>
                          )}
                        </td>
                        <td>
                          <span
                            className={cn(
                              'inline-block px-1.5 py-0.5 rounded text-[10px] font-medium',
                              g.rsvp_status === 'attending'
                                ? 'bg-green-100 text-green-800'
                                : g.rsvp_status === 'declined'
                                  ? 'bg-red-100 text-red-800'
                                  : 'bg-gray-100 text-gray-600'
                            )}
                          >
                            {g.rsvp_status || 'pending'}
                          </span>
                        </td>
                        <td className="text-gray-600">{g.meal_preference || '--'}</td>
                        <td className="text-gray-600">{tableName}</td>
                        <td className="text-gray-500 text-xs">{g.dietary_restrictions || '--'}</td>
                        <td className="text-gray-500 text-xs">{g.care_notes || '--'}</td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          </div>
        )}

        {/* ALLERGIES */}
        {show('allergies') && (
          <div className="print-section print-section-break">
            <h2 className="text-lg font-heading font-semibold text-sage-900 border-b border-sage-200 pb-2 mb-3">
              Allergy Registry ({allergies.length} entries)
            </h2>
            <table className="print-table">
              <thead>
                <tr>
                  <th>Guest</th>
                  <th>Allergy</th>
                  <th style={{ width: '120px' }}>Severity</th>
                  <th style={{ width: '110px' }}>Caterer Alerted</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {[...allergies]
                  .sort((a, b) => {
                    const order: Record<string, number> = {
                      life_threatening: 0,
                      severe: 1,
                      moderate: 2,
                      mild: 3,
                    }
                    return (order[a.severity ?? 'mild'] ?? 4) - (order[b.severity ?? 'mild'] ?? 4)
                  })
                  .map((a) => (
                    <tr key={a.id} className={a.severity === 'life_threatening' || a.severity === 'severe' ? 'bg-red-50' : ''}>
                      <td className="font-medium">{a.guest_name}</td>
                      <td>{a.allergy_type}</td>
                      <td>
                        <span
                          className={cn(
                            'inline-block px-1.5 py-0.5 rounded text-[10px] font-medium capitalize',
                            a.severity === 'life_threatening'
                              ? 'bg-red-200 text-red-900'
                              : a.severity === 'severe'
                                ? 'bg-red-100 text-red-800'
                                : a.severity === 'moderate'
                                  ? 'bg-amber-100 text-amber-800'
                                  : 'bg-gray-100 text-gray-600'
                          )}
                        >
                          {a.severity?.replace(/_/g, ' ') || 'unknown'}
                        </span>
                      </td>
                      <td>{a.is_important ? 'Yes' : 'No'}</td>
                      <td className="text-gray-500 text-xs">{a.notes || '--'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}

        {/* GUEST CARE */}
        {show('guestCare') && (
          <div className="print-section print-section-break">
            <h2 className="text-lg font-heading font-semibold text-sage-900 border-b border-sage-200 pb-2 mb-3">
              Guest Care Notes
            </h2>
            <table className="print-table">
              <thead>
                <tr>
                  <th>Guest</th>
                  <th style={{ width: '140px' }}>Type</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {guestCare.map((g) => (
                  <tr key={g.id}>
                    <td className="font-medium">{g.guest_name}</td>
                    <td className="capitalize text-gray-600">{g.care_type || '--'}</td>
                    <td className="text-gray-500">{g.note || '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* BEDROOMS */}
        {show('rooms') && (
          <div className="print-section print-section-break">
            <h2 className="text-lg font-heading font-semibold text-sage-900 border-b border-sage-200 pb-2 mb-3">
              Bedroom Assignments
            </h2>
            <table className="print-table">
              <thead>
                <tr>
                  <th>Room</th>
                  <th>Description</th>
                  <th>Occupants</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {rooms.map((r) => (
                  <tr key={r.id}>
                    <td className="font-medium">{r.room_name}</td>
                    <td className="text-gray-600 text-xs">{r.room_description || '--'}</td>
                    <td>{r.guests && r.guests.length > 0 ? r.guests.join(', ') : <span className="text-gray-400 italic">Unassigned</span>}</td>
                    <td className="text-gray-500 text-xs">{r.notes || '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* TABLES / SEATING */}
        {show('tables') && (
          <div className="print-section print-section-break">
            <h2 className="text-lg font-heading font-semibold text-sage-900 border-b border-sage-200 pb-2 mb-3">
              Tables &amp; Seating
            </h2>

            {seatingTables.length > 0 && (
              <div className="print-subsection mb-4">
                <h3 className="text-sm font-semibold text-sage-800 mb-2">Tables ({seatingTables.length})</h3>
                <table className="print-table">
                  <thead>
                    <tr>
                      <th>Table</th>
                      <th style={{ width: '120px' }}>Type</th>
                      <th style={{ width: '90px' }}>Capacity</th>
                      <th style={{ width: '90px' }}>Seated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {seatingTables.map((t) => {
                      const seated = (seatingByTable[t.id] ?? []).length
                      return (
                        <tr key={t.id}>
                          <td className="font-medium">{t.table_name || '--'}</td>
                          <td className="capitalize text-gray-600">{t.table_type || '--'}</td>
                          <td className="text-center tabular-nums">{t.capacity ?? '--'}</td>
                          <td className="text-center tabular-nums">{seated}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Per-table seating roster */}
            {Object.keys(seatingByTable).length > 0 && (
              <div className="print-subsection mb-4">
                <h3 className="text-sm font-semibold text-sage-800 mb-2">Seating Chart</h3>
                {Object.entries(seatingByTable)
                  .map(([tableId, entries]) => ({
                    tableId,
                    name: tablesById.get(tableId)?.table_name || tableId.slice(0, 8),
                    entries,
                  }))
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map(({ tableId, name, entries }) => (
                    <div key={tableId} className="print-subsection" style={{ marginBottom: 10 }}>
                      <p className="font-semibold text-sm border-b border-sage-100 pb-1 mb-1">
                        {name} <span className="font-normal text-gray-400 text-xs">({entries.length} guest{entries.length !== 1 ? 's' : ''})</span>
                      </p>
                      {entries.map(({ guest, person }) => (
                        <p key={guest.id} className="text-xs pl-3 leading-relaxed">
                          {person ? `${person.first_name ?? ''} ${person.last_name ?? ''}`.trim() : guest.group_name || '--'}
                          {guest.meal_preference && <span className="text-gray-500"> · {guest.meal_preference}</span>}
                          {guest.dietary_restrictions && <span className="text-red-600"> · {guest.dietary_restrictions}</span>}
                        </p>
                      ))}
                    </div>
                  ))}
                {unseatedGuests.length > 0 && (
                  <div className="print-subsection">
                    <p className="font-semibold text-sm border-b border-sage-100 pb-1 mb-1">
                      Unassigned <span className="font-normal text-gray-400 text-xs">({unseatedGuests.length})</span>
                    </p>
                    {unseatedGuests.map(({ guest, person }) => (
                      <p key={guest.id} className="text-xs pl-3 leading-relaxed">
                        {person ? `${person.first_name ?? ''} ${person.last_name ?? ''}`.trim() : guest.group_name || '--'}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* HAIR & MAKEUP */}
        {show('makeup') && (
          <div className="print-section print-section-break">
            <h2 className="text-lg font-heading font-semibold text-sage-900 border-b border-sage-200 pb-2 mb-3">
              Hair &amp; Makeup Schedule
            </h2>
            <table className="print-table">
              <thead>
                <tr>
                  <th style={{ width: '100px' }}>Hair</th>
                  <th style={{ width: '100px' }}>Makeup</th>
                  <th>Person</th>
                  <th style={{ width: '140px' }}>Role</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {[...makeup]
                  .sort((a, b) => {
                    const aT = a.hair_time || a.makeup_time || ''
                    const bT = b.hair_time || b.makeup_time || ''
                    if (!aT) return 1
                    if (!bT) return -1
                    return timeToMin(aT) - timeToMin(bT)
                  })
                  .map((s) => (
                    <tr key={s.id}>
                      <td className="tabular-nums">{formatTime12(s.hair_time)}</td>
                      <td className="tabular-nums">{formatTime12(s.makeup_time)}</td>
                      <td className="font-medium">{s.person_name}</td>
                      <td className="text-gray-600 capitalize">{s.role?.replace(/_/g, ' ') || '--'}</td>
                      <td className="text-gray-500 text-xs">{s.notes || '--'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}

        {/* SHUTTLE */}
        {show('shuttle') && (
          <div className="print-section print-section-break">
            <h2 className="text-lg font-heading font-semibold text-sage-900 border-b border-sage-200 pb-2 mb-3">
              Shuttle Schedule
            </h2>
            <table className="print-table">
              <thead>
                <tr>
                  <th>Route</th>
                  <th style={{ width: '110px' }}>Departure</th>
                  <th>Pickup</th>
                  <th>Dropoff</th>
                  <th style={{ width: '70px' }}>Cap.</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {shuttles.map((r) => (
                  <tr key={r.id}>
                    <td className="font-medium">{r.route_name}</td>
                    <td className="tabular-nums">{formatTime12(r.departure_time)}</td>
                    <td className="text-gray-600">{r.pickup_location || '--'}</td>
                    <td className="text-gray-600">{r.dropoff_location || '--'}</td>
                    <td className="text-center tabular-nums">{r.capacity ?? '--'}</td>
                    <td className="text-gray-500 text-xs">{r.notes || '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* BAR */}
        {show('bar') && (
          <div className="print-section print-section-break">
            <h2 className="text-lg font-heading font-semibold text-sage-900 border-b border-sage-200 pb-2 mb-3">
              Bar
            </h2>

            {bar && (bar.bar_type || bar.guest_count || bar.bartender_count || bar.notes) && (
              <div className="print-subsection mb-3">
                <h3 className="text-sm font-semibold text-sage-800 mb-2">Plan</h3>
                <div className="info-grid">
                  <DataRow label="Bar Type" value={bar.bar_type?.replace(/_/g, ' ')} />
                  <DataRow label="Guest Count" value={bar.guest_count} />
                  <DataRow label="Bartenders" value={bar.bartender_count} />
                </div>
                <NotesBlock label="Notes" value={bar.notes} />
              </div>
            )}

            {Object.keys(barShoppingByCat).length > 0 && (
              <div className="print-subsection mb-3">
                <h3 className="text-sm font-semibold text-sage-800 mb-2">Shopping List</h3>
                <table className="print-table">
                  <thead>
                    <tr>
                      <th style={{ width: '120px' }}>Category</th>
                      <th>Item</th>
                      <th style={{ width: '90px' }}>Qty</th>
                      <th style={{ width: '70px' }}>Got?</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(barShoppingByCat).map(([cat, items]) =>
                      items.map((item, idx) => (
                        <tr key={item.id}>
                          {idx === 0 && (
                            <td
                              rowSpan={items.length}
                              className="font-medium capitalize align-top border-r border-gray-200"
                            >
                              {cat}
                            </td>
                          )}
                          <td>{item.item_name}</td>
                          <td className="tabular-nums">{item.quantity ?? '--'}{item.unit ? ` ${item.unit}` : ''}</td>
                          <td>{item.purchased ? 'Yes' : 'No'}</td>
                          <td className="text-gray-500 text-xs">{item.notes || '--'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {barRecipes.length > 0 && (
              <div className="print-subsection">
                <h3 className="text-sm font-semibold text-sage-800 mb-2">Recipes</h3>
                {barRecipes.map((r) => (
                  <div key={r.id} className="print-subsection mb-2 border border-sage-100 rounded p-2">
                    <p className="font-semibold text-sm">
                      {r.cocktail_name}
                      {r.servings ? <span className="font-normal text-gray-500 text-xs"> · serves {r.servings}</span> : null}
                    </p>
                    {Array.isArray(r.ingredients) && r.ingredients.length > 0 && (
                      <ul className="text-xs text-gray-600 list-disc list-inside mt-1">
                        {(r.ingredients as Array<{ name?: string; amount?: string } | string>).map((ing, i) => (
                          <li key={i}>
                            {typeof ing === 'string'
                              ? ing
                              : `${ing.amount ?? ''} ${ing.name ?? ''}`.trim()}
                          </li>
                        ))}
                      </ul>
                    )}
                    {r.instructions && <p className="text-xs text-gray-700 mt-1">{r.instructions}</p>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* DÉCOR */}
        {show('decor') && (
          <div className="print-section print-section-break">
            <h2 className="text-lg font-heading font-semibold text-sage-900 border-b border-sage-200 pb-2 mb-3">
              Décor Inventory ({decor.length} items)
            </h2>
            <table className="print-table">
              <thead>
                <tr>
                  <th style={{ width: '120px' }}>Space</th>
                  <th>Item</th>
                  <th style={{ width: '50px' }}>Qty</th>
                  <th style={{ width: '90px' }}>Source</th>
                  <th>Goes Home With / Notes</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(decorByCategory).map(([cat, items]) =>
                  items.map((item, idx) => (
                    <tr key={item.id}>
                      {idx === 0 && (
                        <td
                          rowSpan={items.length}
                          className="font-medium capitalize align-top border-r border-gray-200"
                        >
                          {cat.replace(/_/g, ' ')}
                        </td>
                      )}
                      <td>
                        {item.item_name}
                        {item.vendor_name ? <span className="text-gray-500"> ({item.vendor_name})</span> : null}
                      </td>
                      <td className="text-center tabular-nums">{item.quantity ?? 1}</td>
                      <td className="capitalize text-gray-600">{item.source || '--'}</td>
                      <td className="text-gray-500 text-xs">
                        {[item.leaving_instructions, item.notes].filter(Boolean).join(' · ') || '--'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* REHEARSAL DINNER */}
        {show('rehearsal') && rehearsal && (
          <div className="print-section print-section-break">
            <h2 className="text-lg font-heading font-semibold text-sage-900 border-b border-sage-200 pb-2 mb-3">
              Rehearsal Dinner
            </h2>
            <div className="info-grid">
              <DataRow label="Location" value={rehearsal.location_name} />
              <DataRow label="Address" value={rehearsal.address} />
              <DataRow label="Date" value={rehearsal.date ? formatDate(rehearsal.date) : null} />
              <DataRow label="Start" value={formatTime12(rehearsal.start_time)} />
              <DataRow label="End" value={formatTime12(rehearsal.end_time)} />
              <DataRow label="Guest Count" value={rehearsal.guest_count} />
            </div>
            <NotesBlock label="Menu notes" value={rehearsal.menu_notes} />
            <NotesBlock label="Special arrangements" value={rehearsal.special_arrangements} />
          </div>
        )}

        {/* STAFFING */}
        {show('staffing') && (
          <div className="print-section print-section-break">
            <h2 className="text-lg font-heading font-semibold text-sage-900 border-b border-sage-200 pb-2 mb-3">
              Staffing ({staffingTotal} total)
            </h2>
            <div className="info-grid mb-3">
              {Object.entries(staffingByRole).map(([role, count]) => (
                <DataRow key={role} label={role.replace(/_/g, ' ')} value={count} />
              ))}
            </div>
            <table className="print-table">
              <thead>
                <tr>
                  <th style={{ width: '140px' }}>Role</th>
                  <th>Person</th>
                  <th style={{ width: '60px' }}>Count</th>
                  <th style={{ width: '90px' }}>Hours</th>
                  <th style={{ width: '90px' }}>Rate</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {staffing.map((s) => (
                  <tr key={s.id}>
                    <td className="capitalize font-medium">{s.role?.replace(/_/g, ' ') || '--'}</td>
                    <td>{s.person_name || '--'}</td>
                    <td className="text-center tabular-nums">{s.count ?? 1}</td>
                    <td className="text-center tabular-nums">{s.hours ?? '--'}</td>
                    <td className="text-center tabular-nums">{s.hourly_rate ? `$${s.hourly_rate}` : '--'}</td>
                    <td className="text-gray-500 text-xs">{s.notes || '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* INTERNAL NOTES — admin only */}
        {show('internal') && (
          <div className="print-section print-section-break">
            <h2 className="text-lg font-heading font-semibold text-sage-900 border-b border-sage-200 pb-2 mb-3">
              Internal Notes <span className="text-xs font-normal text-gray-400">(admin-only)</span>
            </h2>
            <div className="space-y-2">
              {internalNotes.map((n) => (
                <div key={n.id} className="border border-sage-100 rounded p-2 bg-sage-50/40">
                  <p className="text-xs text-gray-500 mb-1">
                    {new Date(n.created_at).toLocaleString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </p>
                  <p className="text-sm whitespace-pre-wrap text-gray-700">{n.content}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {selectedSections.size === 0 && (
          <div className="bg-surface border border-border rounded-xl p-12 text-center">
            <p className="text-sm text-sage-500">
              Select at least one section above to preview the print package.
            </p>
          </div>
        )}
      </div>
    </>
  )
}
