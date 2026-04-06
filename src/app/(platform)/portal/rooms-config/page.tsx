'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { cn } from '@/lib/utils'
import {
  BedDouble,
  Save,
  Loader2,
  CheckCircle,
  Plus,
  Trash2,
  Hotel,
  FileText,
  ArrowUpDown,
  MapPin,
  Phone,
  DollarSign,
  Link,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AccommodationModel = 'on_site' | 'partner_hotels' | 'both' | 'none'

interface OnSiteRoom {
  id: string
  name: string
  description: string
  capacity: string
  bed_type: string
  amenities: string
  sort_order: number
}

interface PartnerHotel {
  id: string
  hotel_name: string
  address: string
  contact_person: string
  phone: string
  rate: number | null
  room_block_notes: string
  booking_link: string
  distance: string
}

interface RoomsConfig {
  accommodation_model: AccommodationModel
  on_site_rooms: OnSiteRoom[]
  partner_hotels: PartnerHotel[]
  notes_to_couples: string
}

const DEFAULT_CONFIG: RoomsConfig = {
  accommodation_model: 'none',
  on_site_rooms: [],
  partner_hotels: [],
  notes_to_couples: '',
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 10)
}

// ---------------------------------------------------------------------------
// Reusable components (platform style)
// ---------------------------------------------------------------------------

function RadioGroup({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (v: string) => void
  options: { key: string; label: string; description?: string }[]
}) {
  return (
    <div className="space-y-2">
      {options.map((opt) => (
        <label
          key={opt.key}
          className={cn(
            'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
            value === opt.key
              ? 'border-sage-400 bg-sage-50'
              : 'border-border bg-white hover:bg-sage-50/50'
          )}
        >
          <input
            type="radio"
            name="accommodation-model"
            checked={value === opt.key}
            onChange={() => onChange(opt.key)}
            className="mt-0.5 accent-sage-500"
          />
          <div>
            <span className="text-sm font-medium text-sage-800">{opt.label}</span>
            {opt.description && (
              <p className="text-xs text-sage-500 mt-0.5">{opt.description}</p>
            )}
          </div>
        </label>
      ))}
    </div>
  )
}

function ConfigSection({
  title,
  icon: Icon,
  children,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}) {
  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="px-6 py-4 border-b border-border flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-sage-100 flex items-center justify-center">
          <Icon className="w-5 h-5 text-sage-600" />
        </div>
        <h2 className="font-heading text-lg font-semibold text-sage-900">{title}</h2>
      </div>
      <div className="p-6 space-y-5">{children}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// On-Site Room Editor
// ---------------------------------------------------------------------------

function OnSiteRoomEditor({
  rooms,
  onChange,
}: {
  rooms: OnSiteRoom[]
  onChange: (r: OnSiteRoom[]) => void
}) {
  function addRoom() {
    onChange([
      ...rooms,
      {
        id: generateId(),
        name: '',
        description: '',
        capacity: '',
        bed_type: '',
        amenities: '',
        sort_order: rooms.length + 1,
      },
    ])
  }

  function updateRoom(idx: number, updates: Partial<OnSiteRoom>) {
    onChange(rooms.map((r, i) => (i === idx ? { ...r, ...updates } : r)))
  }

  function removeRoom(idx: number) {
    onChange(rooms.filter((_, i) => i !== idx))
  }

  return (
    <div className="space-y-3">
      {rooms.map((room, idx) => (
        <div
          key={room.id}
          className="bg-warm-white border border-border rounded-lg p-4 space-y-3"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-sage-600 mb-1">
                    Room Name
                  </label>
                  <input
                    type="text"
                    value={room.name}
                    onChange={(e) => updateRoom(idx, { name: e.target.value })}
                    placeholder="e.g., Newlywed Suite"
                    className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-sage-600 mb-1">
                    Bed Type
                  </label>
                  <input
                    type="text"
                    value={room.bed_type}
                    onChange={(e) => updateRoom(idx, { bed_type: e.target.value })}
                    placeholder="e.g., King, 2 Queens"
                    className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-sage-600 mb-1">
                    Capacity
                  </label>
                  <input
                    type="text"
                    value={room.capacity}
                    onChange={(e) => updateRoom(idx, { capacity: e.target.value })}
                    placeholder="e.g., 2 adults"
                    className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-sage-600 mb-1">
                  Description
                </label>
                <input
                  type="text"
                  value={room.description}
                  onChange={(e) => updateRoom(idx, { description: e.target.value })}
                  placeholder="e.g., King bed, bathtub, makeup salon"
                  className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-sage-600 mb-1">
                    Amenities Notes
                  </label>
                  <input
                    type="text"
                    value={room.amenities}
                    onChange={(e) => updateRoom(idx, { amenities: e.target.value })}
                    placeholder="e.g., Private bathroom, AC, robes"
                    className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-sage-600 mb-1">
                    Sort Order
                  </label>
                  <input
                    type="number"
                    value={room.sort_order}
                    onChange={(e) =>
                      updateRoom(idx, { sort_order: Number(e.target.value) || 0 })
                    }
                    className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                  />
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => removeRoom(idx)}
              className="p-1.5 rounded-md hover:bg-red-50 text-sage-400 hover:text-red-500 transition-colors shrink-0"
              title="Remove room"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={addRoom}
        className="inline-flex items-center gap-2 px-4 py-2 bg-sage-50 text-sage-700 rounded-lg text-sm font-medium hover:bg-sage-100 transition-colors border border-sage-200"
      >
        <Plus className="w-4 h-4" />
        Add Room
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Partner Hotel Editor
// ---------------------------------------------------------------------------

function PartnerHotelEditor({
  hotels,
  onChange,
}: {
  hotels: PartnerHotel[]
  onChange: (h: PartnerHotel[]) => void
}) {
  function addHotel() {
    onChange([
      ...hotels,
      {
        id: generateId(),
        hotel_name: '',
        address: '',
        contact_person: '',
        phone: '',
        rate: null,
        room_block_notes: '',
        booking_link: '',
        distance: '',
      },
    ])
  }

  function updateHotel(idx: number, updates: Partial<PartnerHotel>) {
    onChange(hotels.map((h, i) => (i === idx ? { ...h, ...updates } : h)))
  }

  function removeHotel(idx: number) {
    onChange(hotels.filter((_, i) => i !== idx))
  }

  return (
    <div className="space-y-3">
      {hotels.map((hotel, idx) => (
        <div
          key={hotel.id}
          className="bg-warm-white border border-border rounded-lg p-4 space-y-3"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-sage-600 mb-1">
                    Hotel Name
                  </label>
                  <input
                    type="text"
                    value={hotel.hotel_name}
                    onChange={(e) => updateHotel(idx, { hotel_name: e.target.value })}
                    placeholder="e.g., Hampton Inn — Culpeper"
                    className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-sage-600 mb-1">
                    Distance from Venue
                  </label>
                  <input
                    type="text"
                    value={hotel.distance}
                    onChange={(e) => updateHotel(idx, { distance: e.target.value })}
                    placeholder="e.g., 15 minutes"
                    className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-sage-600 mb-1">
                  Address
                </label>
                <input
                  type="text"
                  value={hotel.address}
                  onChange={(e) => updateHotel(idx, { address: e.target.value })}
                  placeholder="Full address..."
                  className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-sage-600 mb-1">
                    Contact Person
                  </label>
                  <input
                    type="text"
                    value={hotel.contact_person}
                    onChange={(e) => updateHotel(idx, { contact_person: e.target.value })}
                    placeholder="e.g., Jane Smith"
                    className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-sage-600 mb-1">
                    Phone
                  </label>
                  <input
                    type="text"
                    value={hotel.phone}
                    onChange={(e) => updateHotel(idx, { phone: e.target.value })}
                    placeholder="e.g., (540) 555-0123"
                    className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-sage-600 mb-1">
                    Rate ($/night)
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sage-400 text-sm">$</span>
                    <input
                      type="number"
                      value={hotel.rate ?? ''}
                      onChange={(e) =>
                        updateHotel(idx, {
                          rate: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                      placeholder="e.g., 139"
                      className="w-full pl-7 pr-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                    />
                  </div>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-sage-600 mb-1">
                  Room Block Notes
                </label>
                <textarea
                  value={hotel.room_block_notes}
                  onChange={(e) => updateHotel(idx, { room_block_notes: e.target.value })}
                  placeholder="e.g., Block of 20 rooms, cutoff date 30 days prior"
                  rows={2}
                  className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors resize-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-sage-600 mb-1">
                  Booking Link / Code
                </label>
                <input
                  type="text"
                  value={hotel.booking_link}
                  onChange={(e) => updateHotel(idx, { booking_link: e.target.value })}
                  placeholder="URL or booking code..."
                  className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                />
              </div>
            </div>
            <button
              type="button"
              onClick={() => removeHotel(idx)}
              className="p-1.5 rounded-md hover:bg-red-50 text-sage-400 hover:text-red-500 transition-colors shrink-0"
              title="Remove hotel"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={addHotel}
        className="inline-flex items-center gap-2 px-4 py-2 bg-sage-50 text-sage-700 rounded-lg text-sm font-medium hover:bg-sage-100 transition-colors border border-sage-200"
      >
        <Plus className="w-4 h-4" />
        Add Partner Hotel
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function RoomsConfigPage() {
  const VENUE_ID = useVenueId()
  const [config, setConfig] = useState<RoomsConfig>(DEFAULT_CONFIG)
  const [originalConfig, setOriginalConfig] = useState<RoomsConfig>(DEFAULT_CONFIG)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchConfig = useCallback(async () => {
    try {
      const supabase = createClient()
      const { data, error: fetchErr } = await supabase
        .from('venue_config')
        .select('feature_flags')
        .eq('venue_id', VENUE_ID)
        .maybeSingle()

      if (fetchErr) throw fetchErr

      if (data) {
        const flags = (data.feature_flags ?? {}) as Record<string, unknown>
        const rc = (flags.rooms_config ?? {}) as Record<string, unknown>
        const loaded: RoomsConfig = {
          accommodation_model:
            (rc.accommodation_model as AccommodationModel) ?? 'none',
          on_site_rooms: (rc.on_site_rooms as OnSiteRoom[]) ?? [],
          partner_hotels: (rc.partner_hotels as PartnerHotel[]) ?? [],
          notes_to_couples: (rc.notes_to_couples as string) ?? '',
        }
        setConfig(loaded)
        setOriginalConfig(loaded)
      }
      setError(null)
    } catch (err) {
      console.error('Failed to fetch rooms config:', err)
      setError('Failed to load rooms configuration')
    } finally {
      setLoading(false)
    }
  }, [VENUE_ID])

  useEffect(() => {
    fetchConfig()
  }, [fetchConfig])

  const hasChanges = JSON.stringify(config) !== JSON.stringify(originalConfig)

  const handleSave = async () => {
    if (!hasChanges) return
    setSaving(true)
    setSaved(false)

    try {
      const supabase = createClient()

      const { data: current } = await supabase
        .from('venue_config')
        .select('feature_flags')
        .eq('venue_id', VENUE_ID)
        .maybeSingle()

      const flags = (current?.feature_flags ?? {}) as Record<string, unknown>
      flags.rooms_config = {
        accommodation_model: config.accommodation_model,
        on_site_rooms: config.on_site_rooms,
        partner_hotels: config.partner_hotels,
        notes_to_couples: config.notes_to_couples,
      }

      const { error: updateErr } = await supabase
        .from('venue_config')
        .update({
          feature_flags: flags,
          updated_at: new Date().toISOString(),
        })
        .eq('venue_id', VENUE_ID)

      if (updateErr) throw updateErr

      setOriginalConfig({ ...config })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      console.error('Save failed:', err)
      setError('Failed to save rooms configuration')
    } finally {
      setSaving(false)
    }
  }

  const update = <K extends keyof RoomsConfig>(field: K, value: RoomsConfig[K]) => {
    setConfig((prev) => ({ ...prev, [field]: value }))
    setSaved(false)
  }

  const showOnSite =
    config.accommodation_model === 'on_site' ||
    config.accommodation_model === 'both'
  const showPartner =
    config.accommodation_model === 'partner_hotels' ||
    config.accommodation_model === 'both'

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Rooms &amp; Accommodations
          </h1>
          <p className="text-sage-600">
            Manage on-site rooms, suites, and nearby accommodation recommendations. Couples can browse options and reserve rooms for their wedding party and out-of-town guests.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {saved && (
            <span className="flex items-center gap-1.5 text-sm text-emerald-600">
              <CheckCircle className="w-4 h-4" />
              Saved
            </span>
          )}
          <button
            onClick={handleSave}
            disabled={!hasChanges || saving}
            className={cn(
              'inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
              hasChanges
                ? 'bg-sage-600 text-white hover:bg-sage-700'
                : 'bg-sage-100 text-sage-400 cursor-not-allowed'
            )}
          >
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={() => { setError(null); setLoading(true); fetchConfig() }}
            className="mt-1 text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-surface border border-border rounded-xl p-6 animate-pulse">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-9 h-9 bg-sage-100 rounded-lg" />
                <div className="h-5 w-40 bg-sage-100 rounded" />
              </div>
              <div className="space-y-3">
                <div className="h-4 w-64 bg-sage-50 rounded" />
                <div className="h-4 w-48 bg-sage-50 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-6">
          {/* Accommodation Model */}
          <ConfigSection title="Accommodation Model" icon={ArrowUpDown}>
            <p className="text-sm text-sage-600 mb-3">
              How does your venue handle guest accommodations?
            </p>
            <RadioGroup
              value={config.accommodation_model}
              onChange={(v) => update('accommodation_model', v as AccommodationModel)}
              options={[
                {
                  key: 'on_site',
                  label: 'On-Site Rooms',
                  description: 'Venue has guest rooms on the property',
                },
                {
                  key: 'partner_hotels',
                  label: 'Partner Hotels',
                  description: 'Nearby hotels with room block partnerships',
                },
                {
                  key: 'both',
                  label: 'Both',
                  description: 'On-site rooms and partner hotel options',
                },
                {
                  key: 'none',
                  label: 'None',
                  description: 'No accommodation management needed',
                },
              ]}
            />
          </ConfigSection>

          {/* On-Site Rooms */}
          {showOnSite && (
            <ConfigSection title="On-Site Rooms" icon={BedDouble}>
              <p className="text-sm text-sage-600 mb-3">
                Define the rooms available at your venue. These get seeded into bedroom
                assignments when a new wedding is created.
              </p>
              <OnSiteRoomEditor
                rooms={config.on_site_rooms}
                onChange={(r) => update('on_site_rooms', r)}
              />
            </ConfigSection>
          )}

          {/* Partner Hotels */}
          {showPartner && (
            <ConfigSection title="Partner Hotels" icon={Hotel}>
              <p className="text-sm text-sage-600 mb-3">
                Nearby hotel partnerships with room block details. These populate the
                accommodations section for couples.
              </p>
              <PartnerHotelEditor
                hotels={config.partner_hotels}
                onChange={(h) => update('partner_hotels', h)}
              />
            </ConfigSection>
          )}

          {/* Notes to Couples */}
          <ConfigSection title="Notes to Couples" icon={FileText}>
            <p className="text-sm text-sage-600 mb-2">
              Accommodation information and tips shown to couples in their portal.
            </p>
            <textarea
              value={config.notes_to_couples}
              onChange={(e) => update('notes_to_couples', e.target.value)}
              placeholder="e.g., Check-in begins at 3pm Friday. The Newlywed Suite includes a complimentary breakfast. Pets are welcome in the Cottage room only."
              rows={4}
              className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors resize-none"
            />
          </ConfigSection>
        </div>
      )}
    </div>
  )
}
