'use client'

// Feature: configurable via venue_config.feature_flags
// Tables: bedroom_assignments, guest_list

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import { cn } from '@/lib/utils'
import {
  BedDouble,
  Plus,
  X,
  Edit2,
  Trash2,
  UserPlus,
  UserMinus,
  Hotel,
  Home,
  ExternalLink,
  Calendar,
  DollarSign,
  Link2,
  Info,
  Save,
  Check,
  Loader2,
  ChevronDown,
  ChevronUp,
  Users,
  ClipboardList,
  Search,
  Tag,
} from 'lucide-react'
import { TagChip, type TagChipData } from '@/components/couple/tag-chip'

// TODO: Get from auth session
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// RoomBlock is a UI-level interface; stored in bedroom_assignments
// with structured JSON in the notes field (marked _type: 'hotel_block')
interface RoomBlock {
  id: string
  hotel_name: string
  block_name: string
  rate_per_night: number | null
  rooms_reserved: number | null
  booking_deadline: string | null
  booking_link: string | null
  booking_code: string | null
  notes: string | null
}

interface RoomBlockForm {
  hotel_name: string
  block_name: string
  rate_per_night: string
  rooms_reserved: string
  booking_deadline: string
  booking_link: string
  booking_code: string
  notes: string
}

// OnSiteRoom maps to bedroom_assignments: room_name, room_description, guests (text[]), notes
interface OnSiteRoom {
  id: string
  room_name: string
  room_description: string | null
  guests: string[]
  notes: string | null
}

interface Guest {
  id: string
  accommodation: string | null
  first_name: string | null
  last_name: string | null
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EMPTY_BLOCK_FORM: RoomBlockForm = {
  hotel_name: '',
  block_name: '',
  rate_per_night: '',
  rooms_reserved: '',
  booking_deadline: '',
  booking_link: '',
  booking_code: '',
  notes: '',
}

// ---------------------------------------------------------------------------
// bedroom_assignments <-> RoomBlock helpers
// Hotel blocks are stored in bedroom_assignments with structured JSON in notes
// ---------------------------------------------------------------------------

interface HotelBlockMeta {
  _type: 'hotel_block'
  rate_per_night?: number | null
  rooms_reserved?: number | null
  booking_deadline?: string | null
  booking_link?: string | null
  booking_code?: string | null
  user_notes?: string | null
}

function isHotelBlockRow(row: Record<string, unknown>): boolean {
  try {
    const notes = row.notes as string | null
    if (!notes) return false
    const parsed = JSON.parse(notes)
    return parsed?._type === 'hotel_block'
  } catch {
    return false
  }
}

function rowToRoomBlock(row: Record<string, unknown>): RoomBlock {
  let meta: HotelBlockMeta = { _type: 'hotel_block' }
  try {
    meta = JSON.parse(row.notes as string)
  } catch { /* use defaults */ }

  return {
    id: row.id as string,
    hotel_name: (row.room_name as string) || '',
    block_name: (row.room_description as string) || '',
    rate_per_night: meta.rate_per_night ?? null,
    rooms_reserved: meta.rooms_reserved ?? null,
    booking_deadline: meta.booking_deadline ?? null,
    booking_link: meta.booking_link ?? null,
    booking_code: meta.booking_code ?? null,
    notes: meta.user_notes ?? null,
  }
}

function roomBlockToPayload(form: RoomBlockForm, venueId: string, weddingId: string) {
  const meta: HotelBlockMeta = {
    _type: 'hotel_block',
    rate_per_night: form.rate_per_night ? parseFloat(form.rate_per_night) : null,
    rooms_reserved: form.rooms_reserved ? parseInt(form.rooms_reserved) : null,
    booking_deadline: form.booking_deadline || null,
    booking_link: form.booking_link.trim() || null,
    booking_code: form.booking_code.trim() || null,
    user_notes: form.notes.trim() || null,
  }

  return {
    venue_id: venueId,
    wedding_id: weddingId,
    room_name: form.hotel_name.trim(),
    room_description: form.block_name.trim() || null,
    guests: [] as string[],
    notes: JSON.stringify(meta),
  }
}

function rowToOnSiteRoom(row: Record<string, unknown>): OnSiteRoom {
  return {
    id: row.id as string,
    room_name: (row.room_name as string) || '',
    room_description: (row.room_description as string) || null,
    guests: (row.guests as string[]) || [],
    notes: (row.notes as string) || null,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function guestName(guest: Guest): string {
  const name = [guest.first_name, guest.last_name].filter(Boolean).join(' ')
  return name || 'Unnamed'
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return ''
  try {
    const d = new Date(dateStr + 'T00:00:00')
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return dateStr
  }
}

function isDeadlineSoon(dateStr: string | null): boolean {
  if (!dateStr) return false
  const deadline = new Date(dateStr + 'T00:00:00')
  const now = new Date()
  const diff = deadline.getTime() - now.getTime()
  const daysDiff = diff / (1000 * 60 * 60 * 24)
  return daysDiff >= 0 && daysDiff <= 14
}

function isDeadlinePassed(dateStr: string | null): boolean {
  if (!dateStr) return false
  const deadline = new Date(dateStr + 'T00:00:00')
  return deadline < new Date()
}

// ---------------------------------------------------------------------------
// Room Assignments Page
// ---------------------------------------------------------------------------

export default function RoomAssignmentsPage() {
  const { venueId, weddingId, loading: contextLoading } = useCoupleContext()
  // Room blocks
  const [roomBlocks, setRoomBlocks] = useState<RoomBlock[]>([])
  const [showBlockModal, setShowBlockModal] = useState(false)
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null)
  const [blockForm, setBlockForm] = useState<RoomBlockForm>(EMPTY_BLOCK_FORM)

  // On-site rooms
  const [onSiteRooms, setOnSiteRooms] = useState<OnSiteRoom[]>([])
  const [savingRoom, setSavingRoom] = useState<string | null>(null)

  // Guest accommodation tracker
  const [guests, setGuests] = useState<Guest[]>([])
  const [showTracker, setShowTracker] = useState(false)
  const [trackerSearch, setTrackerSearch] = useState('')
  // When true, filter the tracker to show only guests tagged with the Hotel tag
  const [hotelTagFilter, setHotelTagFilter] = useState(false)

  // Hotel tag data
  const [hotelTag, setHotelTag] = useState<TagChipData | null>(null)
  const [hotelTaggedGuestIds, setHotelTaggedGuestIds] = useState<Set<string>>(new Set())

  // General
  const [loading, setLoading] = useState(true)
  const [expandedBlocks, setExpandedBlocks] = useState(true)
  const [expandedOnSite, setExpandedOnSite] = useState(true)

  const supabase = createClient()

  // ---- Fetch ----
  const fetchData = useCallback(async () => {
    const [assignmentsRes, guestsRes, hotelTagRes] = await Promise.all([
      supabase
        .from('bedroom_assignments')
        .select('*')
        .eq('wedding_id', weddingId)
        .order('created_at', { ascending: true }),
      supabase
        .from('guest_list')
        .select('id, accommodation, first_name, last_name')
        .eq('wedding_id', weddingId)
        .order('created_at', { ascending: true }),
      supabase
        .from('guest_tags')
        .select('id, tag_name, color')
        .eq('wedding_id', weddingId)
        .ilike('tag_name', 'hotel')
        .limit(1),
    ])

    if (assignmentsRes.data) {
      const rows = assignmentsRes.data as Record<string, unknown>[]
      const blocks: RoomBlock[] = []
      const rooms: OnSiteRoom[] = []
      for (const row of rows) {
        if (isHotelBlockRow(row)) {
          blocks.push(rowToRoomBlock(row))
        } else {
          rooms.push(rowToOnSiteRoom(row))
        }
      }
      setRoomBlocks(blocks)
      setOnSiteRooms(rooms)
    }
    if (guestsRes.data) setGuests(guestsRes.data as unknown as Guest[])

    // Hotel tag + its assignments
    const hotelTagRow = hotelTagRes.data && hotelTagRes.data.length > 0 ? hotelTagRes.data[0] : null
    if (hotelTagRow) {
      setHotelTag({
        id: hotelTagRow.id as string,
        name: hotelTagRow.tag_name as string,
        color: (hotelTagRow.color as string) || '#8B7355',
      })
      const { data: assignments } = await supabase
        .from('guest_tag_assignments')
        .select('guest_id')
        .eq('tag_id', hotelTagRow.id)
      const ids = new Set(
        ((assignments as { guest_id: string }[] | null) || []).map((a) => a.guest_id),
      )
      setHotelTaggedGuestIds(ids)
    } else {
      setHotelTag(null)
      setHotelTaggedGuestIds(new Set())
    }

    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ---- Derived ----
  const totalBlockRooms = roomBlocks.reduce((sum, b) => sum + (b.rooms_reserved || 0), 0)
  const accommodationOptions = useMemo(() => {
    const opts: string[] = []
    for (const block of roomBlocks) {
      opts.push(block.hotel_name + (block.block_name ? ` — ${block.block_name}` : ''))
    }
    for (const room of onSiteRooms) {
      opts.push(`On-site: ${room.room_name}`)
    }
    opts.push('Making own arrangements')
    return opts
  }, [roomBlocks, onSiteRooms])

  const guestsWithAccommodation = guests.filter((g) => g.accommodation)
  const guestsWithoutAccommodation = guests.filter((g) => !g.accommodation)

  const filteredGuests = useMemo(() => {
    let base = guests
    if (hotelTagFilter) {
      base = base.filter((g) => hotelTaggedGuestIds.has(g.id))
    }
    if (!trackerSearch.trim()) return base
    const q = trackerSearch.toLowerCase()
    return base.filter((g) => guestName(g).toLowerCase().includes(q))
  }, [guests, trackerSearch, hotelTagFilter, hotelTaggedGuestIds])

  // Count of guests with the Hotel tag
  const hotelTaggedCount = hotelTaggedGuestIds.size

  // ---- Room Block CRUD ----
  function openAddBlock() {
    setBlockForm(EMPTY_BLOCK_FORM)
    setEditingBlockId(null)
    setShowBlockModal(true)
  }

  function openEditBlock(block: RoomBlock) {
    setBlockForm({
      hotel_name: block.hotel_name,
      block_name: block.block_name || '',
      rate_per_night: block.rate_per_night?.toString() || '',
      rooms_reserved: block.rooms_reserved?.toString() || '',
      booking_deadline: block.booking_deadline || '',
      booking_link: block.booking_link || '',
      booking_code: block.booking_code || '',
      notes: block.notes || '',
    })
    setEditingBlockId(block.id)
    setShowBlockModal(true)
  }

  async function handleSaveBlock() {
    if (!blockForm.hotel_name.trim()) return
    if (!venueId || !weddingId) return

    const payload = roomBlockToPayload(blockForm, venueId, weddingId)

    if (editingBlockId) {
      await supabase.from('bedroom_assignments').update(payload).eq('id', editingBlockId)
    } else {
      await supabase.from('bedroom_assignments').insert(payload)
    }

    setShowBlockModal(false)
    setEditingBlockId(null)
    fetchData()
  }

  async function handleDeleteBlock(id: string) {
    if (!confirm('Remove this room block?')) return
    await supabase.from('bedroom_assignments').delete().eq('id', id)
    fetchData()
  }

  // ---- On-site room guest save ----
  async function saveRoomGuests(roomId: string, updatedGuests: string[]) {
    setSavingRoom(roomId)
    await supabase
      .from('bedroom_assignments')
      .update({ guests: updatedGuests })
      .eq('id', roomId)

    setSavingRoom(null)
    fetchData()
  }

  // ---- Guest accommodation ----
  async function updateGuestAccommodation(guestId: string, value: string) {
    await supabase
      .from('guest_list')
      .update({ accommodation: value || null })
      .eq('id', guestId)
    fetchData()
  }

  // ---- Loading ----
  if (contextLoading || !weddingId || !venueId || loading) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="h-8 w-48 bg-gray-200 rounded" />
        <div className="h-32 bg-gray-100 rounded-xl" />
        <div className="h-32 bg-gray-100 rounded-xl" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1
          className="text-3xl font-bold mb-1"
          style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
        >
          Room Assignments
        </h1>
        <p className="text-gray-500 text-sm">
          Manage hotel room blocks, on-site accommodations, and track where your guests are staying.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div className="bg-white rounded-xl p-3 border border-gray-100 shadow-sm text-center">
          <p className="text-xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
            {roomBlocks.length}
          </p>
          <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">Room Blocks</p>
        </div>
        <div className="bg-white rounded-xl p-3 border border-gray-100 shadow-sm text-center">
          <p className="text-xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
            {totalBlockRooms}
          </p>
          <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">Rooms Reserved</p>
        </div>
        <div className="bg-white rounded-xl p-3 border border-gray-100 shadow-sm text-center">
          <p className="text-xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
            {onSiteRooms.length}
          </p>
          <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">On-Site Rooms</p>
        </div>
        <div className="bg-white rounded-xl p-3 border border-gray-100 shadow-sm text-center">
          <p className={cn('text-xl font-bold tabular-nums', guestsWithoutAccommodation.length > 0 ? 'text-amber-600' : 'text-emerald-600')}>
            {guestsWithAccommodation.length}/{guests.length}
          </p>
          <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">Guests Tracked</p>
        </div>
        {hotelTag && (
          <div className="bg-white rounded-xl p-3 border border-gray-100 shadow-sm text-center">
            <p className="text-xl font-bold tabular-nums" style={{ color: hotelTag.color }}>
              {hotelTaggedCount}
            </p>
            <div className="flex items-center justify-center gap-1 mt-0.5">
              <Tag className="w-2.5 h-2.5 text-gray-400" />
              <p className="text-[10px] text-gray-500 font-medium uppercase tracking-wide">Hotel Tag</p>
            </div>
          </div>
        )}
      </div>

      {/* ================================================================ */}
      {/* SECTION 1: Room Blocks */}
      {/* ================================================================ */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <button
          onClick={() => setExpandedBlocks(!expandedBlocks)}
          className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors"
        >
          <div className="flex items-center gap-2">
            <Hotel className="w-4 h-4" style={{ color: 'var(--couple-primary)' }} />
            <h2
              className="text-sm font-semibold"
              style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
            >
              Hotel Room Blocks
            </h2>
            {roomBlocks.length > 0 && (
              <span className="text-[10px] font-medium text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                {roomBlocks.length}
              </span>
            )}
          </div>
          {expandedBlocks ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
        </button>

        {expandedBlocks && (
          <div className="px-5 pb-5 space-y-4">
            <div className="flex items-start gap-3 p-3 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-700">
              <Info className="w-4 h-4 mt-0.5 shrink-0 text-blue-500" />
              <p>
                Where are your guests staying? Add room blocks you have reserved at hotels. Share the booking codes
                and links on your wedding website or with your guests directly.
              </p>
            </div>

            {/* Room block cards */}
            {roomBlocks.length > 0 && (
              <div className="space-y-3">
                {roomBlocks.map((block) => {
                  const deadlineSoon = isDeadlineSoon(block.booking_deadline)
                  const deadlinePassed = isDeadlinePassed(block.booking_deadline)

                  return (
                    <div
                      key={block.id}
                      className="border border-gray-100 rounded-xl p-4 group hover:shadow-sm transition-shadow"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <h3
                            className="font-semibold text-sm"
                            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
                          >
                            {block.hotel_name}
                          </h3>
                          {block.block_name && (
                            <p className="text-xs text-gray-500 mt-0.5">Block: {block.block_name}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                          <button
                            onClick={() => openEditBlock(block)}
                            className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleDeleteBlock(block.id)}
                            className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
                        {block.rate_per_night != null && (
                          <div className="flex items-center gap-1.5 text-xs text-gray-500">
                            <DollarSign className="w-3 h-3 text-gray-400" />
                            <span>${block.rate_per_night}/night</span>
                          </div>
                        )}
                        {block.rooms_reserved != null && (
                          <div className="flex items-center gap-1.5 text-xs text-gray-500">
                            <BedDouble className="w-3 h-3 text-gray-400" />
                            <span>{block.rooms_reserved} rooms</span>
                          </div>
                        )}
                        {block.booking_deadline && (
                          <div className={cn(
                            'flex items-center gap-1.5 text-xs',
                            deadlinePassed ? 'text-red-500' : deadlineSoon ? 'text-amber-600' : 'text-gray-500',
                          )}>
                            <Calendar className="w-3 h-3" />
                            <span>
                              {deadlinePassed ? 'Expired: ' : deadlineSoon ? 'Soon: ' : 'By '}
                              {formatDate(block.booking_deadline)}
                            </span>
                          </div>
                        )}
                        {block.booking_code && (
                          <div className="flex items-center gap-1.5 text-xs text-gray-500">
                            <ClipboardList className="w-3 h-3 text-gray-400" />
                            <span className="font-mono">{block.booking_code}</span>
                          </div>
                        )}
                      </div>

                      {block.booking_link && (
                        <div className="mt-2">
                          <a
                            href={block.booking_link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs font-medium hover:underline"
                            style={{ color: 'var(--couple-primary)' }}
                          >
                            <Link2 className="w-3 h-3" />
                            Booking Link
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        </div>
                      )}

                      {block.notes && (
                        <p className="text-xs text-gray-400 mt-2 italic">{block.notes}</p>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {roomBlocks.length === 0 && (
              <div className="text-center py-8 bg-gray-50 rounded-lg border border-dashed border-gray-200">
                <Hotel className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                <p className="text-sm text-gray-500 mb-1">No room blocks added yet</p>
                <p className="text-xs text-gray-400 mb-3">
                  Add your hotel room blocks to share booking details with guests.
                </p>
              </div>
            )}

            <button
              onClick={openAddBlock}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
              style={{ backgroundColor: 'var(--couple-primary)' }}
            >
              <Plus className="w-4 h-4" />
              Add Room Block
            </button>
          </div>
        )}
      </div>

      {/* ================================================================ */}
      {/* SECTION 2: On-Site Rooms */}
      {/* ================================================================ */}
      {onSiteRooms.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <button
            onClick={() => setExpandedOnSite(!expandedOnSite)}
            className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Home className="w-4 h-4" style={{ color: 'var(--couple-primary)' }} />
              <h2
                className="text-sm font-semibold"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                On-Site Rooms
              </h2>
              <span className="text-[10px] font-medium text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                {onSiteRooms.length}
              </span>
            </div>
            {expandedOnSite ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
          </button>

          {expandedOnSite && (
            <div className="px-5 pb-5 space-y-4">
              <p className="text-xs text-gray-500">
                These rooms are set up by your venue. Enter guest names (comma-separated) for each room.
                Changes save automatically when you tab or click away.
              </p>

              <div className="space-y-3">
                {onSiteRooms.map((room) => (
                  <div
                    key={room.id}
                    className="border border-gray-100 rounded-xl overflow-hidden"
                  >
                    <div
                      className="px-4 py-3 border-b border-gray-100"
                      style={{ backgroundColor: 'color-mix(in srgb, var(--couple-primary) 5%, white)' }}
                    >
                      <h3
                        className="font-semibold text-sm"
                        style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
                      >
                        {room.room_name}
                      </h3>
                      {room.room_description && (
                        <p className="text-xs text-gray-500 mt-0.5">{room.room_description}</p>
                      )}
                    </div>

                    <div className="p-4">
                      <label className="block text-[10px] font-medium text-gray-400 uppercase tracking-wide mb-1">
                        Assigned Guests
                      </label>
                      <div className="relative">
                        <input
                          type="text"
                          defaultValue={(room.guests || []).join(', ')}
                          onBlur={(e) => {
                            const val = e.target.value.trim()
                            const updated = val ? val.split(',').map((g) => g.trim()).filter(Boolean) : []
                            saveRoomGuests(room.id, updated)
                          }}
                          placeholder="Guest names (comma-separated)"
                          className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                          style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                        />
                        {savingRoom === room.id && (
                          <Loader2 className="w-3.5 h-3.5 absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-gray-300" />
                        )}
                      </div>
                    </div>

                    {room.notes && (
                      <div className="px-4 pb-3">
                        <p className="text-xs text-gray-400 italic">{room.notes}</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ================================================================ */}
      {/* SECTION 3: Guest Accommodation Tracker */}
      {/* ================================================================ */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <button
          onClick={() => setShowTracker(!showTracker)}
          className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors"
        >
          <div className="flex items-center gap-2">
            <ClipboardList className="w-4 h-4" style={{ color: 'var(--couple-primary)' }} />
            <h2
              className="text-sm font-semibold"
              style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
            >
              Guest Accommodation Tracker
            </h2>
            {guestsWithAccommodation.length > 0 && (
              <span className="text-[10px] font-medium text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                {guestsWithAccommodation.length}/{guests.length}
              </span>
            )}
          </div>
          {showTracker ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
        </button>

        {showTracker && (
          <div className="px-5 pb-5 space-y-4">
            <p className="text-xs text-gray-500">
              Track where each guest is staying. This is optional but helps with transportation planning
              and guest communication.
            </p>

            {guests.length === 0 ? (
              <div className="text-center py-8 bg-gray-50 rounded-lg border border-dashed border-gray-200">
                <Users className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                <p className="text-sm text-gray-500">No guests in your guest list yet.</p>
                <p className="text-xs text-gray-400 mt-1">Add guests first, then track their accommodations here.</p>
              </div>
            ) : (
              <>
                {/* Search + hotel-tag filter toggle */}
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="relative flex-1 min-w-[200px]">
                    <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-300" />
                    <input
                      type="text"
                      value={trackerSearch}
                      onChange={(e) => setTrackerSearch(e.target.value)}
                      placeholder="Search guests..."
                      className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                      style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                    />
                  </div>
                  {hotelTag && hotelTaggedCount > 0 && (
                    <button
                      onClick={() => setHotelTagFilter((v) => !v)}
                      className={cn(
                        'inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border transition-colors',
                        hotelTagFilter
                          ? 'text-white border-transparent'
                          : 'text-gray-600 border-gray-200 bg-white hover:border-gray-300',
                      )}
                      style={hotelTagFilter ? { backgroundColor: hotelTag.color } : undefined}
                    >
                      <Tag className="w-3 h-3" />
                      {hotelTagFilter ? 'Showing Hotel-tagged' : `Filter: ${hotelTag.name} (${hotelTaggedCount})`}
                      {hotelTagFilter && <X className="w-3 h-3" />}
                    </button>
                  )}
                </div>

                {/* Guest list */}
                <div className="space-y-2 max-h-[500px] overflow-y-auto">
                  {filteredGuests.map((guest) => (
                    <div
                      key={guest.id}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-gray-100 hover:bg-gray-50 transition-colors"
                    >
                      <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-[10px] font-medium text-gray-500 shrink-0">
                        {guestName(guest).charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0 flex items-center gap-2">
                        <span className="text-sm text-gray-700 truncate">{guestName(guest)}</span>
                        {hotelTag && hotelTaggedGuestIds.has(guest.id) && (
                          <TagChip tag={hotelTag} />
                        )}
                      </div>
                      <select
                        value={guest.accommodation || ''}
                        onChange={(e) => updateGuestAccommodation(guest.id, e.target.value)}
                        className="px-2 py-1.5 border border-gray-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:border-transparent max-w-[200px]"
                        style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                      >
                        <option value="">Not set</option>
                        {accommodationOptions.map((opt) => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>

                {/* Summary */}
                {guestsWithoutAccommodation.length > 0 && (
                  <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-100 rounded-lg text-xs text-amber-700">
                    <Info className="w-4 h-4 shrink-0 text-amber-500" />
                    <span>
                      {guestsWithoutAccommodation.length} guest{guestsWithoutAccommodation.length !== 1 ? 's' : ''} still
                      need accommodation tracking.
                    </span>
                  </div>
                )}

                {guestsWithoutAccommodation.length === 0 && guests.length > 0 && (
                  <div className="flex items-center gap-2 p-3 bg-emerald-50 border border-emerald-100 rounded-lg text-xs text-emerald-700">
                    <Check className="w-4 h-4 shrink-0 text-emerald-500" />
                    <span>All guests have accommodation info tracked.</span>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* ================================================================ */}
      {/* Add/Edit Room Block Modal */}
      {/* ================================================================ */}
      {showBlockModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowBlockModal(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2
                className="text-lg font-semibold"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                {editingBlockId ? 'Edit Room Block' : 'Add Room Block'}
              </h2>
              <button onClick={() => setShowBlockModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Hotel Name *</label>
                <input
                  type="text"
                  value={blockForm.hotel_name}
                  onChange={(e) => setBlockForm({ ...blockForm, hotel_name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="e.g., Hampton Inn — Culpeper"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Block Name</label>
                <input
                  type="text"
                  value={blockForm.block_name}
                  onChange={(e) => setBlockForm({ ...blockForm, block_name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="e.g., Smith-Jones Wedding Block"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Rate / Night</label>
                  <div className="relative">
                    <DollarSign className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={blockForm.rate_per_night}
                      onChange={(e) => setBlockForm({ ...blockForm, rate_per_night: e.target.value })}
                      className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                      style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                      placeholder="149"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Rooms Reserved</label>
                  <input
                    type="number"
                    min={0}
                    value={blockForm.rooms_reserved}
                    onChange={(e) => setBlockForm({ ...blockForm, rooms_reserved: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                    placeholder="10"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Booking Deadline</label>
                <input
                  type="date"
                  value={blockForm.booking_deadline}
                  onChange={(e) => setBlockForm({ ...blockForm, booking_deadline: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Booking Link</label>
                <input
                  type="url"
                  value={blockForm.booking_link}
                  onChange={(e) => setBlockForm({ ...blockForm, booking_link: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="https://..."
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Booking Code</label>
                <input
                  type="text"
                  value={blockForm.booking_code}
                  onChange={(e) => setBlockForm({ ...blockForm, booking_code: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="e.g., SMITHJONES2026"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea
                  value={blockForm.notes}
                  onChange={(e) => setBlockForm({ ...blockForm, notes: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent resize-none"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  rows={3}
                  placeholder="Breakfast included, pet-friendly, shuttle available..."
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setShowBlockModal(false)}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveBlock}
                disabled={!blockForm.hotel_name.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                {editingBlockId ? 'Save Changes' : 'Add Room Block'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
