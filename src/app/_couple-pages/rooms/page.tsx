'use client'

// Feature: configurable via venue_config.feature_flags
// Table: bedroom_assignments

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  BedDouble,
  Plus,
  X,
  Edit2,
  Trash2,
  UserPlus,
  UserMinus,
  Home,
  ExternalLink,
  Info,
  Accessibility,
} from 'lucide-react'

// TODO: Get from auth session
const WEDDING_ID = '44444444-4444-4444-4444-444444000109'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RoomModel = 'on_site' | 'nearby_partner' | 'none'

interface RoomAssignment {
  id: string
  room_name: string
  description: string | null
  assigned_guests: string[]
  accessibility_notes: string | null
  notes: string | null
  sort_order: number
}

interface RoomFormData {
  room_name: string
  description: string
  accessibility_notes: string
  notes: string
}

interface Guest {
  id: string
  person: {
    first_name: string | null
    last_name: string | null
  } | null
}

const EMPTY_FORM: RoomFormData = {
  room_name: '',
  description: '',
  accessibility_notes: '',
  notes: '',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function guestName(guest: Guest): string {
  if (guest.person) {
    return [guest.person.first_name, guest.person.last_name].filter(Boolean).join(' ') || 'Unnamed'
  }
  return 'Unnamed'
}

// ---------------------------------------------------------------------------
// Room Assignments Page
// ---------------------------------------------------------------------------

export default function RoomAssignmentsPage() {
  const [rooms, setRooms] = useState<RoomAssignment[]>([])
  const [guests, setGuests] = useState<Guest[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<RoomFormData>(EMPTY_FORM)
  const [showAssignModal, setShowAssignModal] = useState(false)
  const [assigningRoomId, setAssigningRoomId] = useState<string | null>(null)
  const [roomModel, setRoomModel] = useState<RoomModel>('on_site')

  const supabase = createClient()

  // ---- Fetch ----
  const fetchData = useCallback(async () => {
    const [roomsRes, guestsRes] = await Promise.all([
      supabase
        .from('bedroom_assignments')
        .select('*')
        .eq('wedding_id', WEDDING_ID)
        .order('sort_order', { ascending: true }),
      supabase
        .from('guest_list')
        .select('id, person:people(first_name, last_name)')
        .eq('wedding_id', WEDDING_ID)
        .order('created_at', { ascending: true }),
    ])

    if (roomsRes.data) setRooms(roomsRes.data as unknown as RoomAssignment[])
    if (guestsRes.data) setGuests(guestsRes.data as unknown as Guest[])
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ---- Derived ----
  const assignedGuestIds = useMemo(() => {
    const ids = new Set<string>()
    for (const room of rooms) {
      for (const gId of room.assigned_guests || []) {
        ids.add(gId)
      }
    }
    return ids
  }, [rooms])

  const unassignedGuests = useMemo(() => {
    return guests.filter((g) => !assignedGuestIds.has(g.id))
  }, [guests, assignedGuestIds])

  const totalGuestsHoused = assignedGuestIds.size

  // ---- Room CRUD ----
  function openAdd() {
    setForm(EMPTY_FORM)
    setEditingId(null)
    setShowModal(true)
  }

  function openEdit(room: RoomAssignment) {
    setForm({
      room_name: room.room_name,
      description: room.description || '',
      accessibility_notes: room.accessibility_notes || '',
      notes: room.notes || '',
    })
    setEditingId(room.id)
    setShowModal(true)
  }

  async function handleSave() {
    if (!form.room_name.trim()) return

    const payload = {
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      room_name: form.room_name.trim(),
      description: form.description.trim() || null,
      accessibility_notes: form.accessibility_notes.trim() || null,
      notes: form.notes.trim() || null,
    }

    if (editingId) {
      await supabase.from('bedroom_assignments').update(payload).eq('id', editingId)
    } else {
      await supabase.from('bedroom_assignments').insert({
        ...payload,
        assigned_guests: [],
        sort_order: rooms.length,
      })
    }

    setShowModal(false)
    setEditingId(null)
    fetchData()
  }

  async function handleDeleteRoom(id: string) {
    if (!confirm('Remove this room? Guest assignments will be cleared.')) return
    await supabase.from('bedroom_assignments').delete().eq('id', id)
    fetchData()
  }

  // ---- Guest assignment ----
  function openAssignModal(roomId: string) {
    setAssigningRoomId(roomId)
    setShowAssignModal(true)
  }

  async function assignGuest(roomId: string, guestId: string) {
    const room = rooms.find((r) => r.id === roomId)
    if (!room) return

    const updated = [...(room.assigned_guests || []), guestId]
    await supabase.from('bedroom_assignments').update({ assigned_guests: updated }).eq('id', roomId)
    fetchData()
  }

  async function unassignGuest(roomId: string, guestId: string) {
    const room = rooms.find((r) => r.id === roomId)
    if (!room) return

    const updated = (room.assigned_guests || []).filter((id) => id !== guestId)
    await supabase.from('bedroom_assignments').update({ assigned_guests: updated }).eq('id', roomId)
    fetchData()
  }

  if (loading) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="h-8 w-48 bg-gray-200 rounded" />
        <div className="h-32 bg-gray-100 rounded-xl" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1
            className="text-3xl font-bold mb-1"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Room Assignments
          </h1>
          <p className="text-gray-500 text-sm">Assign guests to on-site rooms or accommodations.</p>
        </div>
        <button
          onClick={openAdd}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
          style={{ backgroundColor: 'var(--couple-primary)' }}
        >
          <Plus className="w-4 h-4" />
          Add Room
        </button>
      </div>

      {/* Accommodation model selector */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
        <label className="block text-sm font-medium text-gray-700 mb-2">Accommodation Type</label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <button
            onClick={() => setRoomModel('on_site')}
            className={`text-left p-3 rounded-lg border text-sm transition-colors ${
              roomModel === 'on_site' ? 'text-white border-transparent' : 'text-gray-700 border-gray-200 hover:border-gray-300 bg-white'
            }`}
            style={roomModel === 'on_site' ? { backgroundColor: 'var(--couple-primary)' } : undefined}
          >
            <div className="flex items-center gap-2">
              <Home className="w-4 h-4" />
              <span className="font-medium">On-Site Rooms</span>
            </div>
            <p className={`text-xs mt-1 ${roomModel === 'on_site' ? 'text-white/80' : 'text-gray-400'}`}>
              Your venue offers on-site accommodations
            </p>
          </button>
          <button
            onClick={() => setRoomModel('nearby_partner')}
            className={`text-left p-3 rounded-lg border text-sm transition-colors ${
              roomModel === 'nearby_partner' ? 'text-white border-transparent' : 'text-gray-700 border-gray-200 hover:border-gray-300 bg-white'
            }`}
            style={roomModel === 'nearby_partner' ? { backgroundColor: 'var(--couple-primary)' } : undefined}
          >
            <div className="flex items-center gap-2">
              <ExternalLink className="w-4 h-4" />
              <span className="font-medium">Nearby Stays</span>
            </div>
            <p className={`text-xs mt-1 ${roomModel === 'nearby_partner' ? 'text-white/80' : 'text-gray-400'}`}>
              Your venue partners with nearby accommodations
            </p>
          </button>
          <button
            onClick={() => setRoomModel('none')}
            className={`text-left p-3 rounded-lg border text-sm transition-colors ${
              roomModel === 'none' ? 'text-white border-transparent' : 'text-gray-700 border-gray-200 hover:border-gray-300 bg-white'
            }`}
            style={roomModel === 'none' ? { backgroundColor: 'var(--couple-primary)' } : undefined}
          >
            <div className="flex items-center gap-2">
              <Info className="w-4 h-4" />
              <span className="font-medium">No Rooms</span>
            </div>
            <p className={`text-xs mt-1 ${roomModel === 'none' ? 'text-white/80' : 'text-gray-400'}`}>
              Not applicable for your venue
            </p>
          </button>
        </div>
      </div>

      {roomModel === 'none' && (
        <div className="flex items-start gap-3 p-4 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-600">
          <Info className="w-5 h-5 mt-0.5 shrink-0 text-gray-400" />
          <p>Room assignments are not needed for your venue. You can still add rooms if you want to track hotel room blocks or external accommodations for your guests.</p>
        </div>
      )}

      {roomModel === 'nearby_partner' && (
        <div className="flex items-start gap-3 p-4 bg-blue-50 border border-blue-100 rounded-xl text-sm text-blue-800">
          <ExternalLink className="w-5 h-5 mt-0.5 shrink-0 text-blue-500" />
          <p>Your venue partners with nearby stays. Use the rooms below to track room block assignments, or share accommodation details on your wedding website.</p>
        </div>
      )}

      {/* Stats */}
      {rooms.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
            <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
              {rooms.length}
            </p>
            <p className="text-xs text-gray-500 font-medium">Rooms</p>
          </div>
          <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
            <p className="text-2xl font-bold tabular-nums text-emerald-600">
              {totalGuestsHoused}
            </p>
            <p className="text-xs text-gray-500 font-medium">Guests Housed</p>
          </div>
          <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
            <p className={`text-2xl font-bold tabular-nums ${unassignedGuests.length > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
              {guests.length - totalGuestsHoused}
            </p>
            <p className="text-xs text-gray-500 font-medium">Without Room</p>
          </div>
        </div>
      )}

      {/* Room Cards */}
      {rooms.length === 0 && roomModel !== 'none' ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <BedDouble className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--couple-primary)', opacity: 0.3 }} />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            No rooms added yet
          </h3>
          <p className="text-gray-500 text-sm mb-4">Add rooms to start assigning guests.</p>
          <button
            onClick={openAdd}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
            style={{ backgroundColor: 'var(--couple-primary)' }}
          >
            <Plus className="w-4 h-4" />
            Add First Room
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {rooms.map((room) => {
            const roomGuests = guests.filter((g) => (room.assigned_guests || []).includes(g.id))
            return (
              <div key={room.id} className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden group">
                {/* Room header */}
                <div className="p-4 border-b border-gray-100" style={{ backgroundColor: 'color-mix(in srgb, var(--couple-primary) 5%, white)' }}>
                  <div className="flex items-start justify-between">
                    <div>
                      <h3
                        className="font-semibold text-sm"
                        style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
                      >
                        {room.room_name}
                      </h3>
                      {room.description && (
                        <p className="text-xs text-gray-500 mt-0.5">{room.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => openEdit(room)} className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-white/50">
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => handleDeleteRoom(room.id)} className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50/50">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {room.accessibility_notes && (
                    <div className="flex items-center gap-1 mt-2 text-xs text-gray-500">
                      <Accessibility className="w-3 h-3" />
                      {room.accessibility_notes}
                    </div>
                  )}
                </div>

                {/* Assigned guests */}
                <div className="p-4">
                  {roomGuests.length === 0 ? (
                    <p className="text-xs text-gray-400 text-center py-3">No guests assigned</p>
                  ) : (
                    <div className="space-y-1 mb-3">
                      {roomGuests.map((guest) => (
                        <div key={guest.id} className="flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-gray-50">
                          <span className="text-sm text-gray-700">{guestName(guest)}</span>
                          <button
                            onClick={() => unassignGuest(room.id, guest.id)}
                            className="text-gray-300 hover:text-red-500 transition-colors"
                          >
                            <UserMinus className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <button
                    onClick={() => openAssignModal(room.id)}
                    className="w-full inline-flex items-center justify-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    <UserPlus className="w-3 h-3" />
                    Assign Guest
                  </button>

                  {room.notes && (
                    <p className="text-xs text-gray-400 mt-3 italic">{room.notes}</p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Add/Edit Room Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowModal(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2
                className="text-lg font-semibold"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                {editingId ? 'Edit Room' : 'Add Room'}
              </h2>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Room Name</label>
                <input
                  type="text"
                  value={form.room_name}
                  onChange={(e) => setForm({ ...form, room_name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="e.g., Rose Suite, Room 204"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent resize-none"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  rows={2}
                  placeholder="Room features, bed type, sleeps N..."
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  <Accessibility className="w-3.5 h-3.5 inline mr-1" />
                  Accessibility Notes
                </label>
                <input
                  type="text"
                  value={form.accessibility_notes}
                  onChange={(e) => setForm({ ...form, accessibility_notes: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="e.g., First floor, wheelchair accessible, stairs required"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent resize-none"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  rows={2}
                  placeholder="Check-in time, amenities, etc."
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setShowModal(false)}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!form.room_name.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                {editingId ? 'Save Changes' : 'Add Room'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Assign Guest Modal */}
      {showAssignModal && assigningRoomId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowAssignModal(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4 max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2
                className="text-lg font-semibold"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                Assign Guest to {rooms.find((r) => r.id === assigningRoomId)?.room_name}
              </h2>
              <button onClick={() => setShowAssignModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            {unassignedGuests.length === 0 ? (
              <p className="text-sm text-gray-400 py-4 text-center">
                All guests have been assigned to rooms.
              </p>
            ) : (
              <div className="space-y-1">
                {unassignedGuests.map((guest) => (
                  <button
                    key={guest.id}
                    onClick={() => {
                      assignGuest(assigningRoomId, guest.id)
                    }}
                    className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    <span>{guestName(guest)}</span>
                    <Plus className="w-3.5 h-3.5 text-gray-300" />
                  </button>
                ))}
              </div>
            )}

            <div className="flex justify-end pt-2">
              <button
                onClick={() => setShowAssignModal(false)}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
