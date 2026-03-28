'use client'

// Feature: configurable via venue_config.feature_flags
// Table: shuttle_schedule

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Bus,
  Plus,
  X,
  Edit2,
  Trash2,
  MapPin,
  Clock,
  Users,
  Info,
} from 'lucide-react'

// TODO: Get from auth session
const WEDDING_ID = '44444444-4444-4444-4444-444444000109'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TransportRoute {
  id: string
  route_name: string
  pickup_location: string
  dropoff_location: string
  departure_time: string | null
  capacity: number | null
  notes: string | null
  sort_order: number
}

interface RouteFormData {
  route_name: string
  pickup_location: string
  dropoff_location: string
  departure_time: string
  capacity: string
  notes: string
}

const EMPTY_FORM: RouteFormData = {
  route_name: '',
  pickup_location: '',
  dropoff_location: '',
  departure_time: '',
  capacity: '',
  notes: '',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(timeStr: string | null): string {
  if (!timeStr) return 'TBD'
  const [hours, minutes] = timeStr.split(':').map(Number)
  const ampm = hours >= 12 ? 'PM' : 'AM'
  const displayHours = hours % 12 || 12
  return `${displayHours}:${String(minutes).padStart(2, '0')} ${ampm}`
}

// ---------------------------------------------------------------------------
// Transportation Page
// ---------------------------------------------------------------------------

export default function TransportationPage() {
  const [routes, setRoutes] = useState<TransportRoute[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<RouteFormData>(EMPTY_FORM)

  const supabase = createClient()

  // ---- Fetch ----
  const fetchRoutes = useCallback(async () => {
    const { data, error } = await supabase
      .from('shuttle_schedule')
      .select('*')
      .eq('wedding_id', WEDDING_ID)
      .order('departure_time', { ascending: true, nullsFirst: false })
      .order('sort_order', { ascending: true })

    if (!error && data) {
      setRoutes(data as TransportRoute[])
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchRoutes()
  }, [fetchRoutes])

  // ---- Modal helpers ----
  function openAdd() {
    setForm(EMPTY_FORM)
    setEditingId(null)
    setShowModal(true)
  }

  function openEdit(route: TransportRoute) {
    setForm({
      route_name: route.route_name,
      pickup_location: route.pickup_location,
      dropoff_location: route.dropoff_location,
      departure_time: route.departure_time || '',
      capacity: route.capacity?.toString() || '',
      notes: route.notes || '',
    })
    setEditingId(route.id)
    setShowModal(true)
  }

  async function handleSave() {
    if (!form.route_name.trim() || !form.pickup_location.trim()) return

    const payload = {
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      route_name: form.route_name.trim(),
      pickup_location: form.pickup_location.trim(),
      dropoff_location: form.dropoff_location.trim(),
      departure_time: form.departure_time || null,
      capacity: form.capacity ? parseInt(form.capacity) : null,
      notes: form.notes.trim() || null,
    }

    if (editingId) {
      await supabase.from('shuttle_schedule').update(payload).eq('id', editingId)
    } else {
      await supabase.from('shuttle_schedule').insert({
        ...payload,
        sort_order: routes.length,
      })
    }

    setShowModal(false)
    setEditingId(null)
    fetchRoutes()
  }

  async function handleDelete(id: string) {
    if (!confirm('Remove this route?')) return
    await supabase.from('shuttle_schedule').delete().eq('id', id)
    fetchRoutes()
  }

  // ---- Derived ----
  const totalCapacity = routes.reduce((sum, r) => sum + (r.capacity || 0), 0)

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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1
            className="text-3xl font-bold mb-1"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Transportation
          </h1>
          <p className="text-gray-500 text-sm">Plan transportation routes for your guests and wedding party.</p>
        </div>
        <button
          onClick={openAdd}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
          style={{ backgroundColor: 'var(--couple-primary)' }}
        >
          <Plus className="w-4 h-4" />
          Add Route
        </button>
      </div>

      {/* Tips */}
      <div className="flex items-start gap-3 p-4 bg-blue-50 border border-blue-100 rounded-xl text-sm text-blue-800">
        <Info className="w-5 h-5 mt-0.5 shrink-0 text-blue-500" />
        <div>
          <p className="font-medium mb-1">Timing Tips</p>
          <ul className="text-xs text-blue-700 space-y-1">
            <li>Schedule arrival routes at least 30 minutes before your ceremony start time.</li>
            <li>Plan departure routes for 30 minutes after your reception end time to accommodate lingering guests.</li>
            <li>If you have multiple routes, stagger departures by 10-15 minutes to avoid congestion.</li>
          </ul>
        </div>
      </div>

      {/* Stats */}
      {routes.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
            <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
              {routes.length}
            </p>
            <p className="text-xs text-gray-500 font-medium">Routes</p>
          </div>
          <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
            <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--couple-secondary, var(--couple-primary))' }}>
              {totalCapacity || '--'}
            </p>
            <p className="text-xs text-gray-500 font-medium">Total Capacity</p>
          </div>
        </div>
      )}

      {/* Routes List */}
      {routes.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <Bus className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--couple-primary)', opacity: 0.3 }} />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            No transportation routes yet
          </h3>
          <p className="text-gray-500 text-sm mb-4">Add routes for shuttles, cars, or any guest transportation needs.</p>
          <button
            onClick={openAdd}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
            style={{ backgroundColor: 'var(--couple-primary)' }}
          >
            <Plus className="w-4 h-4" />
            Add First Route
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {routes.map((route) => (
            <div key={route.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 group hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-3">
                    <Bus className="w-4 h-4" style={{ color: 'var(--couple-primary)' }} />
                    <h3 className="font-semibold text-gray-800 text-sm">{route.route_name}</h3>
                    {route.departure_time && (
                      <span
                        className="px-2 py-0.5 rounded-full text-[10px] font-medium text-white"
                        style={{ backgroundColor: 'var(--couple-primary)' }}
                      >
                        {formatTime(route.departure_time)}
                      </span>
                    )}
                  </div>

                  <div className="flex items-start gap-3">
                    {/* Route visualization */}
                    <div className="flex flex-col items-center gap-0.5 shrink-0">
                      <div className="w-2.5 h-2.5 rounded-full border-2" style={{ borderColor: 'var(--couple-primary)' }} />
                      <div className="w-0.5 h-8" style={{ backgroundColor: 'var(--couple-primary)', opacity: 0.3 }} />
                      <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: 'var(--couple-primary)' }} />
                    </div>

                    <div className="flex-1 space-y-3">
                      <div>
                        <p className="text-xs text-gray-400 font-medium uppercase tracking-wider">Pickup</p>
                        <p className="text-sm text-gray-700 flex items-center gap-1">
                          <MapPin className="w-3 h-3 text-gray-400" />
                          {route.pickup_location}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-400 font-medium uppercase tracking-wider">Drop-off</p>
                        <p className="text-sm text-gray-700 flex items-center gap-1">
                          <MapPin className="w-3 h-3 text-gray-400" />
                          {route.dropoff_location}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 mt-3 text-xs text-gray-400">
                    {route.capacity && (
                      <span className="flex items-center gap-1">
                        <Users className="w-3 h-3" />
                        {route.capacity} passengers
                      </span>
                    )}
                    {route.departure_time && (
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        Departs {formatTime(route.departure_time)}
                      </span>
                    )}
                  </div>

                  {route.notes && (
                    <p className="text-xs text-gray-400 mt-2 italic">{route.notes}</p>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => openEdit(route)}
                    className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(route.id)}
                    className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowModal(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2
                className="text-lg font-semibold"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                {editingId ? 'Edit Route' : 'Add Route'}
              </h2>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Route Name</label>
                <input
                  type="text"
                  value={form.route_name}
                  onChange={(e) => setForm({ ...form, route_name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="e.g., Guest Shuttle to Ceremony"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  <MapPin className="w-3.5 h-3.5 inline mr-1" />
                  Pickup Location
                </label>
                <input
                  type="text"
                  value={form.pickup_location}
                  onChange={(e) => setForm({ ...form, pickup_location: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="e.g., Hampton Inn Lobby"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  <MapPin className="w-3.5 h-3.5 inline mr-1" />
                  Drop-off Location
                </label>
                <input
                  type="text"
                  value={form.dropoff_location}
                  onChange={(e) => setForm({ ...form, dropoff_location: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="e.g., Your Venue Main Entrance"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    <Clock className="w-3.5 h-3.5 inline mr-1" />
                    Departure Time
                  </label>
                  <input
                    type="time"
                    value={form.departure_time}
                    onChange={(e) => setForm({ ...form, departure_time: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    <Users className="w-3.5 h-3.5 inline mr-1" />
                    Capacity
                  </label>
                  <input
                    type="number"
                    value={form.capacity}
                    onChange={(e) => setForm({ ...form, capacity: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                    placeholder="e.g., 40"
                    min={1}
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent resize-none"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  rows={2}
                  placeholder="Vehicle type, provider, special instructions..."
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
                disabled={!form.route_name.trim() || !form.pickup_location.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                {editingId ? 'Save Changes' : 'Add Route'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
