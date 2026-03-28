'use client'

// Feature: configurable via venue_config.feature_flags
// Table: rehearsal_dinner

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  CalendarDays,
  Plus,
  X,
  Edit2,
  Trash2,
  MapPin,
  Clock,
  Users,
  Utensils,
  FileText,
} from 'lucide-react'

// TODO: Get from auth session
const WEDDING_ID = '44444444-4444-4444-4444-444444000109'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RehearsalDinner {
  id: string
  location_name: string
  address: string | null
  event_date: string | null
  start_time: string | null
  end_time: string | null
  guest_count: number | null
  menu_notes: string | null
  special_arrangements: string | null
  notes: string | null
}

interface RehearsalGuest {
  id: string
  rehearsal_dinner_id: string
  guest_name: string
  role: string | null
  notes: string | null
}

interface DinnerFormData {
  location_name: string
  address: string
  event_date: string
  start_time: string
  end_time: string
  guest_count: string
  menu_notes: string
  special_arrangements: string
  notes: string
}

interface GuestFormData {
  guest_name: string
  role: string
  notes: string
}

const EMPTY_DINNER_FORM: DinnerFormData = {
  location_name: '',
  address: '',
  event_date: '',
  start_time: '',
  end_time: '',
  guest_count: '',
  menu_notes: '',
  special_arrangements: '',
  notes: '',
}

const EMPTY_GUEST_FORM: GuestFormData = {
  guest_name: '',
  role: '',
  notes: '',
}

const GUEST_ROLES = [
  'Wedding Party',
  'Immediate Family',
  'Extended Family',
  'Out-of-Town Guest',
  'Officiant',
  'Other',
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(timeStr: string | null): string {
  if (!timeStr) return '--'
  const [hours, minutes] = timeStr.split(':').map(Number)
  const ampm = hours >= 12 ? 'PM' : 'AM'
  const displayHours = hours % 12 || 12
  return `${displayHours}:${String(minutes).padStart(2, '0')} ${ampm}`
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '--'
  const date = new Date(dateStr + 'T00:00:00')
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

// ---------------------------------------------------------------------------
// Rehearsal Page
// ---------------------------------------------------------------------------

export default function RehearsalPage() {
  const [dinner, setDinner] = useState<RehearsalDinner | null>(null)
  const [guests, setGuests] = useState<RehearsalGuest[]>([])
  const [loading, setLoading] = useState(true)

  // Forms
  const [showDinnerModal, setShowDinnerModal] = useState(false)
  const [dinnerForm, setDinnerForm] = useState<DinnerFormData>(EMPTY_DINNER_FORM)
  const [showGuestModal, setShowGuestModal] = useState(false)
  const [editingGuestId, setEditingGuestId] = useState<string | null>(null)
  const [guestForm, setGuestForm] = useState<GuestFormData>(EMPTY_GUEST_FORM)

  const supabase = createClient()

  // ---- Fetch ----
  const fetchData = useCallback(async () => {
    const { data: dinnerData } = await supabase
      .from('rehearsal_dinner')
      .select('*')
      .eq('wedding_id', WEDDING_ID)
      .maybeSingle()

    if (dinnerData) {
      const d = dinnerData as RehearsalDinner
      setDinner(d)
      setDinnerForm({
        location_name: d.location_name,
        address: d.address || '',
        event_date: d.event_date || '',
        start_time: d.start_time || '',
        end_time: d.end_time || '',
        guest_count: d.guest_count?.toString() || '',
        menu_notes: d.menu_notes || '',
        special_arrangements: d.special_arrangements || '',
        notes: d.notes || '',
      })

      // Fetch rehearsal guests
      const { data: guestData } = await supabase
        .from('rehearsal_dinner')
        .select('id')
        .eq('wedding_id', WEDDING_ID)
        .single()

      if (guestData) {
        // We store guests as JSONB or a related lookup — for now use a simple approach
        // Guests are stored in the rehearsal_dinner row itself or a separate join
        // Using the same table with a guests array approach
      }
    }

    // Fetch rehearsal guests from the rehearsal_dinner_guests virtual —
    // Since we may not have a separate table, store guest list in notes or a JSONB column
    // For now, we'll track guests locally and save to the rehearsal_dinner record
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ---- Save dinner details ----
  async function handleSaveDinner() {
    if (!dinnerForm.location_name.trim()) return

    const payload = {
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      location_name: dinnerForm.location_name.trim(),
      address: dinnerForm.address.trim() || null,
      event_date: dinnerForm.event_date || null,
      start_time: dinnerForm.start_time || null,
      end_time: dinnerForm.end_time || null,
      guest_count: dinnerForm.guest_count ? parseInt(dinnerForm.guest_count) : null,
      menu_notes: dinnerForm.menu_notes.trim() || null,
      special_arrangements: dinnerForm.special_arrangements.trim() || null,
      notes: dinnerForm.notes.trim() || null,
    }

    if (dinner) {
      await supabase.from('rehearsal_dinner').update(payload).eq('id', dinner.id)
    } else {
      await supabase.from('rehearsal_dinner').insert(payload)
    }

    setShowDinnerModal(false)
    fetchData()
  }

  if (loading) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="h-8 w-48 bg-gray-200 rounded" />
        <div className="h-64 bg-gray-100 rounded-xl" />
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
            Rehearsal
          </h1>
          <p className="text-gray-500 text-sm">Plan your rehearsal dinner details and guest list.</p>
        </div>
        <button
          onClick={() => setShowDinnerModal(true)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
          style={{ backgroundColor: 'var(--couple-primary)' }}
        >
          <Edit2 className="w-4 h-4" />
          {dinner ? 'Edit Details' : 'Add Details'}
        </button>
      </div>

      {/* Dinner Details Card */}
      {!dinner ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <CalendarDays className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--couple-primary)', opacity: 0.3 }} />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            No rehearsal details yet
          </h3>
          <p className="text-gray-500 text-sm mb-4">Add your rehearsal dinner location, date, and details.</p>
          <button
            onClick={() => setShowDinnerModal(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
            style={{ backgroundColor: 'var(--couple-primary)' }}
          >
            <Plus className="w-4 h-4" />
            Set Up Rehearsal
          </button>
        </div>
      ) : (
        <>
          {/* Main details card */}
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            {/* Header banner */}
            <div className="p-6" style={{ backgroundColor: 'color-mix(in srgb, var(--couple-primary) 8%, white)' }}>
              <h2
                className="text-xl font-bold mb-1"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                {dinner.location_name}
              </h2>
              {dinner.address && (
                <p className="text-sm text-gray-600 flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5" />
                  {dinner.address}
                </p>
              )}
            </div>

            <div className="p-6 grid grid-cols-1 sm:grid-cols-3 gap-6">
              {/* Date */}
              <div>
                <p className="text-xs text-gray-400 font-medium uppercase tracking-wider mb-1">Date</p>
                <p className="text-sm text-gray-800 flex items-center gap-1.5">
                  <CalendarDays className="w-4 h-4 text-gray-400" />
                  {formatDate(dinner.event_date)}
                </p>
              </div>

              {/* Time */}
              <div>
                <p className="text-xs text-gray-400 font-medium uppercase tracking-wider mb-1">Time</p>
                <p className="text-sm text-gray-800 flex items-center gap-1.5">
                  <Clock className="w-4 h-4 text-gray-400" />
                  {formatTime(dinner.start_time)}
                  {dinner.end_time && ` - ${formatTime(dinner.end_time)}`}
                </p>
              </div>

              {/* Guest count */}
              <div>
                <p className="text-xs text-gray-400 font-medium uppercase tracking-wider mb-1">Expected Guests</p>
                <p className="text-sm text-gray-800 flex items-center gap-1.5">
                  <Users className="w-4 h-4 text-gray-400" />
                  {dinner.guest_count || '--'}
                </p>
              </div>
            </div>

            {/* Menu & Arrangements */}
            {(dinner.menu_notes || dinner.special_arrangements) && (
              <div className="px-6 pb-6 grid grid-cols-1 sm:grid-cols-2 gap-6 border-t border-gray-100 pt-6">
                {dinner.menu_notes && (
                  <div>
                    <p className="text-xs text-gray-400 font-medium uppercase tracking-wider mb-2 flex items-center gap-1">
                      <Utensils className="w-3.5 h-3.5" />
                      Menu Notes
                    </p>
                    <p className="text-sm text-gray-600 whitespace-pre-wrap">{dinner.menu_notes}</p>
                  </div>
                )}
                {dinner.special_arrangements && (
                  <div>
                    <p className="text-xs text-gray-400 font-medium uppercase tracking-wider mb-2 flex items-center gap-1">
                      <FileText className="w-3.5 h-3.5" />
                      Special Arrangements
                    </p>
                    <p className="text-sm text-gray-600 whitespace-pre-wrap">{dinner.special_arrangements}</p>
                  </div>
                )}
              </div>
            )}

            {dinner.notes && (
              <div className="px-6 pb-6 border-t border-gray-100 pt-6">
                <p className="text-xs text-gray-400 font-medium uppercase tracking-wider mb-2">Additional Notes</p>
                <p className="text-sm text-gray-600 whitespace-pre-wrap">{dinner.notes}</p>
              </div>
            )}
          </div>
        </>
      )}

      {/* Dinner Details Modal */}
      {showDinnerModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowDinnerModal(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2
                className="text-lg font-semibold"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                {dinner ? 'Edit Rehearsal Details' : 'Rehearsal Details'}
              </h2>
              <button onClick={() => setShowDinnerModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Location Name</label>
                <input
                  type="text"
                  value={dinnerForm.location_name}
                  onChange={(e) => setDinnerForm({ ...dinnerForm, location_name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="e.g., Bella's Italian Kitchen"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  <MapPin className="w-3.5 h-3.5 inline mr-1" />
                  Address
                </label>
                <input
                  type="text"
                  value={dinnerForm.address}
                  onChange={(e) => setDinnerForm({ ...dinnerForm, address: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="Full address"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
                <input
                  type="date"
                  value={dinnerForm.event_date}
                  onChange={(e) => setDinnerForm({ ...dinnerForm, event_date: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Start Time</label>
                  <input
                    type="time"
                    value={dinnerForm.start_time}
                    onChange={(e) => setDinnerForm({ ...dinnerForm, start_time: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">End Time</label>
                  <input
                    type="time"
                    value={dinnerForm.end_time}
                    onChange={(e) => setDinnerForm({ ...dinnerForm, end_time: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Guest Count</label>
                <input
                  type="number"
                  value={dinnerForm.guest_count}
                  onChange={(e) => setDinnerForm({ ...dinnerForm, guest_count: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="How many guests?"
                  min={0}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  <Utensils className="w-3.5 h-3.5 inline mr-1" />
                  Menu Notes
                </label>
                <textarea
                  value={dinnerForm.menu_notes}
                  onChange={(e) => setDinnerForm({ ...dinnerForm, menu_notes: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent resize-none"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  rows={3}
                  placeholder="Menu selections, dietary accommodations, course details..."
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Special Arrangements</label>
                <textarea
                  value={dinnerForm.special_arrangements}
                  onChange={(e) => setDinnerForm({ ...dinnerForm, special_arrangements: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent resize-none"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  rows={2}
                  placeholder="Toasts, slideshows, decorations, gifts..."
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Additional Notes</label>
                <textarea
                  value={dinnerForm.notes}
                  onChange={(e) => setDinnerForm({ ...dinnerForm, notes: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent resize-none"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  rows={2}
                  placeholder="Parking, dress code, anything else..."
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setShowDinnerModal(false)}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveDinner}
                disabled={!dinnerForm.location_name.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                {dinner ? 'Save Changes' : 'Save Details'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
