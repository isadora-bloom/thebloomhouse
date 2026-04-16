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
  first_name: string
  last_name: string
  role: string
  email: string | null
  phone: string | null
}

interface Guest {
  id: string
  first_name: string | null
  last_name: string | null
  rsvp_status: string | null
  meal_choice: string | null
  table_assignment: string | null
  dietary_restrictions: string | null
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
  is_important: boolean
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
  guests: string[]
  notes: string | null
}

interface BookedVendor {
  id: string
  vendor_type: string
  vendor_name: string | null
  vendor_contact: string | null
  contact_name: string | null
  contact_email: string | null
  contact_phone: string | null
  category: string | null
  notes: string | null
}

interface TimelineEvent {
  id: string
  time: string | null
  duration_minutes: number | null
  title: string
  description: string | null
  category: string | null
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
  }
}

interface Wedding {
  id: string
  venue_id: string
  wedding_date: string | null
  guest_count: number | null
  ceremony_time: string | null
  notes: string | null
}

// ---------------------------------------------------------------------------
// Section types
// ---------------------------------------------------------------------------

const ALL_SECTIONS = [
  { key: 'timeline', label: 'Timeline' },
  { key: 'guests', label: 'Guest List' },
  { key: 'ceremony', label: 'Ceremony Order' },
  { key: 'shuttle', label: 'Shuttle Schedule' },
  { key: 'allergies', label: 'Allergy Registry' },
  { key: 'decor', label: 'Decor Inventory' },
  { key: 'rooms', label: 'Room Assignments' },
  { key: 'contacts', label: 'Vendor Contacts' },
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

function formatTime12(timeStr: string | null): string {
  if (!timeStr) return '--'
  // Handle both "HH:MM" and ISO timestamp formats
  let hours: number
  let minutes: number
  if (timeStr.includes('T')) {
    const d = new Date(timeStr)
    hours = d.getHours()
    minutes = d.getMinutes()
  } else {
    const parts = timeStr.split(':').map(Number)
    hours = parts[0]
    minutes = parts[1]
  }
  const ampm = hours >= 12 ? 'PM' : 'AM'
  const displayHours = hours % 12 || 12
  return `${displayHours}:${String(minutes).padStart(2, '0')} ${ampm}`
}

function getCoupleNames(people: Person[]): string {
  const principals = people.filter(
    (p) => p.role === 'bride' || p.role === 'groom' || p.role === 'partner' || p.role === 'partner1' || p.role === 'partner2'
  )
  if (principals.length === 0) {
    const first = people.slice(0, 2)
    return first.map((p) => p.first_name).join(' & ') || 'Wedding'
  }
  return principals.map((p) => p.first_name).join(' & ')
}

// ---------------------------------------------------------------------------
// Print Sections
// ---------------------------------------------------------------------------

function TimelinePrintSection({ timeline }: { timeline: TimelineEvent | null }) {
  if (!timeline || !timeline.config_json?.events) {
    return <p className="print-empty">No timeline data available.</p>
  }

  const events = timeline.config_json.events
    .filter((e) => e.included && e.time)
    .sort((a, b) => {
      const aMin = timeToMin(a.time)
      const bMin = timeToMin(b.time)
      return aMin - bMin
    })

  return (
    <table className="print-table">
      <thead>
        <tr>
          <th style={{ width: '100px' }}>Time</th>
          <th>Event</th>
          <th style={{ width: '120px' }}>Phase</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>
        {events.map((e) => (
          <tr key={e.id}>
            <td className="tabular-nums">{formatTime12(e.time)}</td>
            <td className="font-medium">{e.name}</td>
            <td className="capitalize text-gray-500">{e.phase?.replace(/_/g, ' ')}</td>
            <td className="text-gray-500">{e.notes || '--'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function timeToMin(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

function GuestListPrintSection({ guests }: { guests: Guest[] }) {
  const sorted = [...guests].sort((a, b) =>
    (a.last_name ?? '').localeCompare(b.last_name ?? '')
  )

  return (
    <table className="print-table">
      <thead>
        <tr>
          <th>Name</th>
          <th style={{ width: '90px' }}>RSVP</th>
          <th style={{ width: '120px' }}>Meal</th>
          <th style={{ width: '80px' }}>Table</th>
          <th>Dietary</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((g) => (
          <tr key={g.id}>
            <td className="font-medium">
              {g.first_name} {g.last_name}
            </td>
            <td>
              <span
                className={cn(
                  'inline-block px-1.5 py-0.5 rounded text-[10px] font-medium',
                  g.rsvp_status === 'attending' || g.rsvp_status === 'confirmed'
                    ? 'bg-green-100 text-green-800'
                    : g.rsvp_status === 'declined'
                      ? 'bg-red-100 text-red-800'
                      : 'bg-gray-100 text-gray-600'
                )}
              >
                {g.rsvp_status || 'pending'}
              </span>
            </td>
            <td className="text-gray-600">{g.meal_choice || '--'}</td>
            <td className="text-gray-600">{g.table_assignment || '--'}</td>
            <td className="text-gray-500 text-xs">{g.dietary_restrictions || '--'}</td>
          </tr>
        ))}
        {guests.length === 0 && (
          <tr>
            <td colSpan={5} className="text-center text-gray-400 italic py-4">
              No guests added yet.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

function CeremonyOrderPrintSection({ participants }: { participants: CeremonyParticipant[] }) {
  const sorted = [...participants].sort((a, b) => (a.sort_order ?? 99) - (b.sort_order ?? 99))

  return (
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
        {sorted.map((p, idx) => (
          <tr key={p.id}>
            <td className="text-gray-400 tabular-nums">{idx + 1}</td>
            <td className="font-medium">{p.participant_name}</td>
            <td className="capitalize text-gray-600">{p.role?.replace(/_/g, ' ') || '--'}</td>
            <td className="capitalize text-gray-500">{p.side || '--'}</td>
            <td className="text-gray-500 text-xs">{p.notes || '--'}</td>
          </tr>
        ))}
        {participants.length === 0 && (
          <tr>
            <td colSpan={5} className="text-center text-gray-400 italic py-4">
              No ceremony order set.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

function ShuttlePrintSection({ runs }: { runs: ShuttleRun[] }) {
  return (
    <table className="print-table">
      <thead>
        <tr>
          <th>Route</th>
          <th>Departure</th>
          <th>Pickup</th>
          <th>Dropoff</th>
          <th style={{ width: '70px' }}>Capacity</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id}>
            <td className="font-medium">{r.route_name}</td>
            <td className="tabular-nums">{formatTime12(r.departure_time)}</td>
            <td className="text-gray-600">{r.pickup_location || '--'}</td>
            <td className="text-gray-600">{r.dropoff_location || '--'}</td>
            <td className="text-center tabular-nums">{r.capacity ?? '--'}</td>
            <td className="text-gray-500 text-xs">{r.notes || '--'}</td>
          </tr>
        ))}
        {runs.length === 0 && (
          <tr>
            <td colSpan={6} className="text-center text-gray-400 italic py-4">
              No shuttle runs scheduled.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

function AllergyPrintSection({ allergies }: { allergies: AllergyEntry[] }) {
  const sorted = [...allergies].sort((a, b) => {
    // Sort severe/life-threatening first
    const severityOrder: Record<string, number> = {
      life_threatening: 0,
      severe: 1,
      moderate: 2,
      mild: 3,
    }
    const aSev = severityOrder[a.severity ?? 'mild'] ?? 4
    const bSev = severityOrder[b.severity ?? 'mild'] ?? 4
    return aSev - bSev
  })

  return (
    <table className="print-table">
      <thead>
        <tr>
          <th>Guest</th>
          <th>Allergy</th>
          <th style={{ width: '120px' }}>Severity</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((a) => (
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
            <td className="text-gray-500 text-xs">{a.notes || '--'}</td>
          </tr>
        ))}
        {allergies.length === 0 && (
          <tr>
            <td colSpan={4} className="text-center text-gray-400 italic py-4">
              No allergies recorded.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

function DecorPrintSection({ items }: { items: DecorItem[] }) {
  // Group by category
  const byCategory: Record<string, DecorItem[]> = {}
  for (const item of items) {
    const cat = item.category || 'other'
    if (!byCategory[cat]) byCategory[cat] = []
    byCategory[cat].push(item)
  }

  return (
    <table className="print-table">
      <thead>
        <tr>
          <th style={{ width: '120px' }}>Space</th>
          <th>Item</th>
          <th style={{ width: '50px' }}>Qty</th>
          <th style={{ width: '90px' }}>Source</th>
          <th>Goes Home With</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(byCategory).map(([cat, catItems]) =>
          catItems.map((item, idx) => (
            <tr key={item.id}>
              {idx === 0 && (
                <td
                  rowSpan={catItems.length}
                  className="font-medium capitalize align-top border-r border-gray-200"
                >
                  {cat.replace(/_/g, ' ')}
                </td>
              )}
              <td>{item.item_name}{item.vendor_name ? ` (${item.vendor_name})` : ''}</td>
              <td className="text-center tabular-nums">{item.quantity ?? 1}</td>
              <td className="capitalize text-gray-600">{item.source || '--'}</td>
              <td className="text-gray-500 text-xs">{item.leaving_instructions || '--'}</td>
            </tr>
          ))
        )}
        {items.length === 0 && (
          <tr>
            <td colSpan={5} className="text-center text-gray-400 italic py-4">
              No decor items listed.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

function RoomsPrintSection({ rooms }: { rooms: RoomAssignment[] }) {
  return (
    <table className="print-table">
      <thead>
        <tr>
          <th>Room</th>
          <th>Guests</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>
        {rooms.map((r) => (
          <tr key={r.id}>
            <td className="font-medium">
              {r.room_name}
              {r.room_description && (
                <span className="block text-xs text-gray-400">{r.room_description}</span>
              )}
            </td>
            <td>{r.guests?.length ? r.guests.join(', ') : '--'}</td>
            <td className="text-gray-500 text-xs">{r.notes || '--'}</td>
          </tr>
        ))}
        {rooms.length === 0 && (
          <tr>
            <td colSpan={3} className="text-center text-gray-400 italic py-4">
              No room assignments set.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

function VendorContactsPrintSection({ vendors }: { vendors: BookedVendor[] }) {
  return (
    <table className="print-table">
      <thead>
        <tr>
          <th>Type</th>
          <th>Vendor</th>
          <th>Contact</th>
          <th>Phone</th>
          <th>Email</th>
        </tr>
      </thead>
      <tbody>
        {vendors.map((v) => (
          <tr key={v.id}>
            <td className="capitalize font-medium">{v.category || v.vendor_type || '--'}</td>
            <td>{v.vendor_name || '--'}</td>
            <td>{v.contact_name || v.vendor_contact || '--'}</td>
            <td className="tabular-nums text-sm">{v.contact_phone || '--'}</td>
            <td className="text-sm">{v.contact_email || '--'}</td>
          </tr>
        ))}
        {vendors.length === 0 && (
          <tr>
            <td colSpan={5} className="text-center text-gray-400 italic py-4">
              No vendors booked yet.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

// ---------------------------------------------------------------------------
// Main Print Page
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

  // Parse requested sections from query params
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
  const [timeline, setTimeline] = useState<TimelineEvent | null>(null)
  const [ceremony, setCeremony] = useState<CeremonyParticipant[]>([])
  const [shuttles, setShuttles] = useState<ShuttleRun[]>([])
  const [allergies, setAllergies] = useState<AllergyEntry[]>([])
  const [decor, setDecor] = useState<DecorItem[]>([])
  const [rooms, setRooms] = useState<RoomAssignment[]>([])
  const [vendors, setVendors] = useState<BookedVendor[]>([])

  const fetchData = useCallback(async () => {
    try {
      const supabase = createClient()

      const { data: weddingData, error: weddingErr } = await supabase
        .from('weddings')
        .select('*')
        .eq('id', weddingId)
        .single()

      if (weddingErr) throw weddingErr
      setWedding(weddingData as Wedding)

      const venueId = weddingData.venue_id

      // Fetch venue name
      const { data: venueData } = await supabase
        .from('venues')
        .select('name')
        .eq('id', venueId)
        .single()
      if (venueData) setVenueName(venueData.name)

      // Fetch all data in parallel
      const [
        peopleRes,
        guestRes,
        timelineRes,
        ceremonyRes,
        shuttleRes,
        allergyRes,
        decorRes,
        roomRes,
        vendorRes,
      ] = await Promise.all([
        supabase.from('people').select('*').eq('wedding_id', weddingId),
        supabase.from('guest_list').select('*').eq('wedding_id', weddingId).order('last_name'),
        supabase.from('timeline').select('*').eq('wedding_id', weddingId).maybeSingle(),
        supabase.from('ceremony_order').select('*').eq('wedding_id', weddingId).order('sort_order'),
        supabase.from('shuttle_schedule').select('*').eq('wedding_id', weddingId).order('departure_time'),
        supabase.from('allergy_registry').select('*').eq('wedding_id', weddingId).order('severity'),
        supabase.from('decor_inventory').select('*').eq('wedding_id', weddingId).order('category'),
        supabase.from('bedroom_assignments').select('*').eq('wedding_id', weddingId).order('room_name'),
        supabase.from('booked_vendors').select('*').eq('wedding_id', weddingId).order('vendor_type'),
      ])

      setPeople((peopleRes.data ?? []) as Person[])
      setGuests((guestRes.data ?? []) as Guest[])
      setTimeline((timelineRes.data ?? null) as TimelineEvent | null)
      setCeremony((ceremonyRes.data ?? []) as CeremonyParticipant[])
      setShuttles((shuttleRes.data ?? []) as ShuttleRun[])
      setAllergies((allergyRes.data ?? []) as AllergyEntry[])
      setDecor((decorRes.data ?? []) as DecorItem[])
      setRooms((roomRes.data ?? []) as RoomAssignment[])
      setVendors((vendorRes.data ?? []) as BookedVendor[])

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

  const coupleNames = people.length > 0 ? getCoupleNames(people) : 'Wedding'

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

  return (
    <>
      {/* Print-specific styles */}
      <style dangerouslySetInnerHTML={{ __html: `
        @media print {
          .no-print,
          nav,
          aside,
          header,
          .sidebar,
          [data-shell] {
            display: none !important;
          }
          body {
            margin: 0 !important;
            padding: 0 !important;
            background: white !important;
          }
          main {
            padding: 0 !important;
            margin: 0 !important;
          }
          main > div {
            padding: 0 !important;
            max-width: 100% !important;
          }
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
          .print-header h1 {
            font-size: 20pt !important;
            margin-bottom: 4pt !important;
          }
          .print-header p {
            font-size: 11pt !important;
            color: #555 !important;
          }
          .print-section {
            page-break-inside: avoid;
            break-inside: avoid;
            margin-bottom: 24pt;
          }
          .print-section-break {
            page-break-before: always;
            break-before: page;
          }
          .print-section h2 {
            font-size: 14pt !important;
            border-bottom: 1px solid #999;
            padding-bottom: 4pt;
            margin-bottom: 8pt;
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
        .print-table tr:nth-child(even) {
          background: #fafaf8;
        }
      ` }} />

      <div className="print-page space-y-6 pb-12">
        {/* Screen-only controls */}
        <div className="no-print space-y-4">
          {/* Back link */}
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

          {/* Section selector */}
          <div className="bg-surface border border-border rounded-xl p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-3">
              Select sections to include
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {ALL_SECTIONS.map((section) => (
                <button
                  key={section.key}
                  onClick={() => toggleSection(section.key)}
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors border',
                    selectedSections.has(section.key)
                      ? 'border-sage-300 bg-sage-50 text-sage-800'
                      : 'border-gray-200 bg-white text-gray-400'
                  )}
                >
                  <div
                    className={cn(
                      'w-4 h-4 rounded flex items-center justify-center shrink-0',
                      selectedSections.has(section.key)
                        ? 'bg-sage-600'
                        : 'border-2 border-gray-300'
                    )}
                  >
                    {selectedSections.has(section.key) && (
                      <Check className="w-3 h-3 text-white" />
                    )}
                  </div>
                  {section.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Print header (visible in both screen preview and print) */}
        <div className="print-header text-center border-b-2 border-sage-200 pb-4">
          <h1 className="font-heading text-2xl font-bold text-sage-900">{coupleNames}</h1>
          <p className="text-sm text-sage-500">
            {wedding?.wedding_date ? formatDate(wedding.wedding_date) : 'Date TBD'}
            {venueName ? ` | ${venueName}` : ''}
          </p>
          <p className="text-xs text-sage-400 mt-1">Day-of Coordination Package</p>
        </div>

        {/* Sections */}
        {selectedSections.has('timeline') && (
          <div className="print-section">
            <h2 className="text-lg font-heading font-semibold text-sage-900 border-b border-sage-200 pb-2 mb-3">
              Timeline
            </h2>
            <TimelinePrintSection timeline={timeline} />
          </div>
        )}

        {selectedSections.has('guests') && (
          <div className="print-section print-section-break">
            <h2 className="text-lg font-heading font-semibold text-sage-900 border-b border-sage-200 pb-2 mb-3">
              Guest List ({guests.length} guests)
            </h2>
            <GuestListPrintSection guests={guests} />
          </div>
        )}

        {selectedSections.has('ceremony') && (
          <div className="print-section print-section-break">
            <h2 className="text-lg font-heading font-semibold text-sage-900 border-b border-sage-200 pb-2 mb-3">
              Ceremony Order
            </h2>
            <CeremonyOrderPrintSection participants={ceremony} />
          </div>
        )}

        {selectedSections.has('shuttle') && (
          <div className="print-section print-section-break">
            <h2 className="text-lg font-heading font-semibold text-sage-900 border-b border-sage-200 pb-2 mb-3">
              Shuttle Schedule
            </h2>
            <ShuttlePrintSection runs={shuttles} />
          </div>
        )}

        {selectedSections.has('allergies') && (
          <div className="print-section print-section-break">
            <h2 className="text-lg font-heading font-semibold text-sage-900 border-b border-sage-200 pb-2 mb-3">
              Allergy Registry ({allergies.length} entries)
            </h2>
            <AllergyPrintSection allergies={allergies} />
          </div>
        )}

        {selectedSections.has('decor') && (
          <div className="print-section print-section-break">
            <h2 className="text-lg font-heading font-semibold text-sage-900 border-b border-sage-200 pb-2 mb-3">
              Decor Inventory ({decor.length} items)
            </h2>
            <DecorPrintSection items={decor} />
          </div>
        )}

        {selectedSections.has('rooms') && (
          <div className="print-section print-section-break">
            <h2 className="text-lg font-heading font-semibold text-sage-900 border-b border-sage-200 pb-2 mb-3">
              Room Assignments
            </h2>
            <RoomsPrintSection rooms={rooms} />
          </div>
        )}

        {selectedSections.has('contacts') && (
          <div className="print-section print-section-break">
            <h2 className="text-lg font-heading font-semibold text-sage-900 border-b border-sage-200 pb-2 mb-3">
              Vendor Contacts ({vendors.length} vendors)
            </h2>
            <VendorContactsPrintSection vendors={vendors} />
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
