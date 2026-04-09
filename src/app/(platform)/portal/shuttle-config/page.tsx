'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { cn } from '@/lib/utils'
import {
  Bus,
  Save,
  Loader2,
  CheckCircle,
  Plus,
  X,
  Trash2,
  MapPin,
  Clock,
  Phone,
  FileText,
  Users,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PickupLocation {
  id: string
  name: string
  address: string
  transit_minutes: number | null
}

interface ShuttleConfig {
  pickup_locations: PickupLocation[]
  default_transit_time: number
  arrival_buffer_minutes: number
  available_shuttles: number
  seats_per_shuttle: number
  shuttle_provider: string
  provider_contact: string
  notes_to_couples: string
}

const ARRIVAL_BUFFER_OPTIONS = [15, 20, 30, 45, 60]

const DEFAULT_CONFIG: ShuttleConfig = {
  pickup_locations: [],
  default_transit_time: 25,
  arrival_buffer_minutes: 30,
  available_shuttles: 2,
  seats_per_shuttle: 40,
  shuttle_provider: '',
  provider_contact: '',
  notes_to_couples: '',
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 10)
}

// ---------------------------------------------------------------------------
// Reusable components
// ---------------------------------------------------------------------------

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
// Pickup Location Editor
// ---------------------------------------------------------------------------

function PickupLocationEditor({
  locations,
  onChange,
}: {
  locations: PickupLocation[]
  onChange: (locs: PickupLocation[]) => void
}) {
  function addLocation() {
    onChange([
      ...locations,
      { id: generateId(), name: '', address: '', transit_minutes: null },
    ])
  }

  function updateLocation(idx: number, updates: Partial<PickupLocation>) {
    onChange(locations.map((loc, i) => (i === idx ? { ...loc, ...updates } : loc)))
  }

  function removeLocation(idx: number) {
    onChange(locations.filter((_, i) => i !== idx))
  }

  return (
    <div className="space-y-3">
      {locations.map((loc, idx) => (
        <div
          key={loc.id}
          className="bg-warm-white border border-border rounded-lg p-4"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-sage-600 mb-1">
                    Location Name
                  </label>
                  <input
                    type="text"
                    value={loc.name}
                    onChange={(e) => updateLocation(idx, { name: e.target.value })}
                    placeholder="e.g., Hampton Inn — Culpeper"
                    className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-sage-600 mb-1">
                    Transit Time (min)
                  </label>
                  <input
                    type="number"
                    value={loc.transit_minutes ?? ''}
                    onChange={(e) =>
                      updateLocation(idx, {
                        transit_minutes: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                    placeholder="e.g., 25"
                    className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-sage-600 mb-1">
                  Address (optional)
                </label>
                <input
                  type="text"
                  value={loc.address}
                  onChange={(e) => updateLocation(idx, { address: e.target.value })}
                  placeholder="Full address..."
                  className="w-full px-3 py-2 bg-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                />
              </div>
            </div>
            <button
              type="button"
              onClick={() => removeLocation(idx)}
              className="p-1.5 rounded-md hover:bg-red-50 text-sage-400 hover:text-red-500 transition-colors shrink-0"
              title="Remove location"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={addLocation}
        className="inline-flex items-center gap-2 px-4 py-2 bg-sage-50 text-sage-700 rounded-lg text-sm font-medium hover:bg-sage-100 transition-colors border border-sage-200"
      >
        <Plus className="w-4 h-4" />
        Add Pickup Location
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function ShuttleConfigPage() {
  const VENUE_ID = useVenueId()
  const [config, setConfig] = useState<ShuttleConfig>(DEFAULT_CONFIG)
  const [originalConfig, setOriginalConfig] = useState<ShuttleConfig>(DEFAULT_CONFIG)
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
        const sc = (flags.shuttle_config ?? {}) as Record<string, unknown>

        const loaded: ShuttleConfig = {
          pickup_locations: (sc.pickup_locations as PickupLocation[]) ?? [],
          default_transit_time: (sc.default_transit_time as number) ?? 25,
          arrival_buffer_minutes: (sc.arrival_buffer_minutes as number) ?? 30,
          available_shuttles: (sc.available_shuttles as number) ?? 2,
          seats_per_shuttle: (sc.seats_per_shuttle as number) ?? 40,
          shuttle_provider: (sc.shuttle_provider as string) ?? '',
          provider_contact: (sc.provider_contact as string) ?? '',
          notes_to_couples: (sc.notes_to_couples as string) ?? '',
        }
        setConfig(loaded)
        setOriginalConfig(loaded)
      }
      setError(null)
    } catch (err) {
      console.error('Failed to fetch shuttle config:', err)
      setError('Failed to load shuttle configuration')
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
      flags.shuttle_config = {
        pickup_locations: config.pickup_locations,
        default_transit_time: config.default_transit_time,
        arrival_buffer_minutes: config.arrival_buffer_minutes,
        available_shuttles: config.available_shuttles,
        seats_per_shuttle: config.seats_per_shuttle,
        shuttle_provider: config.shuttle_provider,
        provider_contact: config.provider_contact,
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
      setError('Failed to save shuttle configuration')
    } finally {
      setSaving(false)
    }
  }

  const update = <K extends keyof ShuttleConfig>(field: K, value: ShuttleConfig[K]) => {
    setConfig((prev) => ({ ...prev, [field]: value }))
    setSaved(false)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Shuttle Configuration
          </h1>
          <p className="text-sage-600">
            Set up shuttle routes, pickup times, and transportation logistics. Couples see these options on their portal to coordinate guest transportation on the wedding day.
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
          {/* Guest Arrival Timing */}
          <ConfigSection title="Guest Arrival Timing" icon={Clock}>
            <div>
              <label className="block text-sm font-medium text-sage-800 mb-1">
                How long before the ceremony start time do you want guests to arrive?
              </label>
              <p className="text-xs text-sage-500 mb-2">
                Used when generating the shuttle schedule — guests are targeted to arrive this many minutes before the ceremony.
              </p>
              <select
                value={config.arrival_buffer_minutes}
                onChange={(e) => update('arrival_buffer_minutes', Number(e.target.value))}
                className="w-full sm:w-64 px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
              >
                {ARRIVAL_BUFFER_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n} minutes before ceremony
                  </option>
                ))}
              </select>
            </div>
          </ConfigSection>

          {/* Pickup Locations */}
          <ConfigSection title="Pickup Locations" icon={MapPin}>
            <p className="text-sm text-sage-600 mb-3">
              Add pickup locations that auto-suggest for couples when they plan shuttle routes.
            </p>
            <PickupLocationEditor
              locations={config.pickup_locations}
              onChange={(locs) => update('pickup_locations', locs)}
            />
          </ConfigSection>

          {/* Shuttle Defaults */}
          <ConfigSection title="Shuttle Defaults" icon={Bus}>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-sage-800 mb-1">
                  Default Transit Time (min)
                </label>
                <p className="text-xs text-sage-500 mb-2">
                  Fallback if not set per location
                </p>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sage-400">
                    <Clock className="w-4 h-4" />
                  </span>
                  <input
                    type="number"
                    value={config.default_transit_time}
                    onChange={(e) => update('default_transit_time', Number(e.target.value) || 1)}
                    className="w-full pl-9 pr-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-sage-800 mb-1">
                  Available Shuttles
                </label>
                <p className="text-xs text-sage-500 mb-2">
                  How many buses/shuttles
                </p>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sage-400">
                    <Bus className="w-4 h-4" />
                  </span>
                  <input
                    type="number"
                    value={config.available_shuttles}
                    onChange={(e) => update('available_shuttles', Number(e.target.value) || 1)}
                    className="w-full pl-9 pr-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-sage-800 mb-1">
                  Seats Per Shuttle
                </label>
                <p className="text-xs text-sage-500 mb-2">
                  Capacity per bus
                </p>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sage-400">
                    <Users className="w-4 h-4" />
                  </span>
                  <input
                    type="number"
                    value={config.seats_per_shuttle}
                    onChange={(e) => update('seats_per_shuttle', Number(e.target.value) || 1)}
                    className="w-full pl-9 pr-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                  />
                </div>
              </div>
            </div>
          </ConfigSection>

          {/* Provider Info */}
          <ConfigSection title="Shuttle Provider" icon={Phone}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-sage-800 mb-1">
                  Provider Name
                </label>
                <input
                  type="text"
                  value={config.shuttle_provider}
                  onChange={(e) => update('shuttle_provider', e.target.value)}
                  placeholder="e.g., Blue Ridge Shuttle Co."
                  className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-sage-800 mb-1">
                  Contact (phone/email)
                </label>
                <input
                  type="text"
                  value={config.provider_contact}
                  onChange={(e) => update('provider_contact', e.target.value)}
                  placeholder="e.g., (540) 555-0123 or info@shuttle.co"
                  className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                />
              </div>
            </div>
          </ConfigSection>

          {/* Notes to Couples */}
          <ConfigSection title="Notes to Couples" icon={FileText}>
            <p className="text-sm text-sage-600 mb-2">
              Shuttle info, pickup tips, and timing guidance shown to couples.
            </p>
            <textarea
              value={config.notes_to_couples}
              onChange={(e) => update('notes_to_couples', e.target.value)}
              placeholder="e.g., Shuttles depart from the hotel lobby. Last shuttle leaves the venue at 11:00pm. Couples should advise guests to arrive 10 minutes before departure."
              rows={4}
              className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors resize-none"
            />
          </ConfigSection>
        </div>
      )}
    </div>
  )
}
