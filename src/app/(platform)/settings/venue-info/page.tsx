'use client'

/**
 * Settings → Venue Info
 *
 * Coordinator surface to populate venue address + day-of logistics. The
 * fields here flow through to the couple-portal /venue-info page via the
 * `venues` table:
 *   - address_line1 / city / state / zip / latitude / longitude (mig 008)
 *   - parking_instructions / entry_instructions / day_of_contact_name /
 *     day_of_contact_phone (mig 221)
 *
 * Tier-B audit #52 closure. Latitude/longitude are coordinator-only —
 * if populated they take precedence over the formatted-address geocode
 * on the public-facing Google Maps link.
 */

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useScope } from '@/lib/hooks/use-scope'
import { Save, MapPin, Loader2, Check } from 'lucide-react'

interface VenueLocation {
  address_line1: string | null
  city: string | null
  state: string | null
  zip: string | null
  latitude: number | null
  longitude: number | null
  parking_instructions: string | null
  entry_instructions: string | null
  day_of_contact_name: string | null
  day_of_contact_phone: string | null
}

const EMPTY: VenueLocation = {
  address_line1: '',
  city: '',
  state: '',
  zip: '',
  latitude: null,
  longitude: null,
  parking_instructions: '',
  entry_instructions: '',
  day_of_contact_name: '',
  day_of_contact_phone: '',
}

export default function VenueInfoSettingsPage() {
  const { venueId, level: scopeLevel } = useScope()
  const supabase = createClient()
  const [data, setData] = useState<VenueLocation>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!venueId) return
    let cancelled = false
    async function load() {
      const { data: row, error: loadErr } = await supabase
        .from('venues')
        .select(
          'address_line1, city, state, zip, latitude, longitude, parking_instructions, entry_instructions, day_of_contact_name, day_of_contact_phone',
        )
        .eq('id', venueId)
        .maybeSingle()
      if (cancelled) return
      if (loadErr) setError(loadErr.message)
      setData((row as VenueLocation | null) ?? EMPTY)
      setLoading(false)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [venueId, supabase])

  async function save() {
    if (!venueId) return
    setSaving(true)
    setSaved(false)
    setError(null)
    const payload = {
      address_line1: data.address_line1 || null,
      city: data.city || null,
      state: data.state || null,
      zip: data.zip || null,
      latitude: data.latitude,
      longitude: data.longitude,
      parking_instructions: data.parking_instructions || null,
      entry_instructions: data.entry_instructions || null,
      day_of_contact_name: data.day_of_contact_name || null,
      day_of_contact_phone: data.day_of_contact_phone || null,
    }
    const { error: saveErr } = await supabase
      .from('venues')
      .update(payload)
      .eq('id', venueId)
    setSaving(false)
    if (saveErr) {
      setError(saveErr.message)
      return
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  function set<K extends keyof VenueLocation>(key: K, value: VenueLocation[K]) {
    setData((prev) => ({ ...prev, [key]: value }))
  }

  if (scopeLevel !== 'venue') {
    return (
      <div className="max-w-2xl mx-auto px-6 py-10">
        <p className="text-sm text-sage-600">
          Switch to a single venue to edit logistics info.
        </p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-10 flex items-center gap-2 text-sage-500">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading…
      </div>
    )
  }

  const inputCls =
    'w-full px-3 py-2 border border-sage-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-sage-300'

  return (
    <div className="max-w-2xl mx-auto px-6 py-10">
      <header className="mb-8">
        <div className="flex items-center gap-2 mb-2">
          <MapPin className="w-5 h-5 text-sage-700" />
          <h1 className="font-heading text-2xl font-bold text-sage-900">
            Venue Info
          </h1>
        </div>
        <p className="text-sm text-sage-600 leading-relaxed">
          What couples and guests see on the &quot;Venue Info&quot; page in
          the portal. Address powers the Google Maps link; parking + entry
          + day-of contact render as separate cards when populated.
        </p>
      </header>

      <section className="mb-8 rounded-xl border border-sage-100 bg-white p-6">
        <h2 className="font-medium text-sage-900 mb-4">Address</h2>
        <div className="space-y-3">
          <input
            className={inputCls}
            placeholder="Street address"
            value={data.address_line1 ?? ''}
            onChange={(e) => set('address_line1', e.target.value)}
          />
          <div className="grid grid-cols-3 gap-3">
            <input
              className={inputCls}
              placeholder="City"
              value={data.city ?? ''}
              onChange={(e) => set('city', e.target.value)}
            />
            <input
              className={inputCls}
              placeholder="State"
              value={data.state ?? ''}
              onChange={(e) => set('state', e.target.value)}
            />
            <input
              className={inputCls}
              placeholder="ZIP"
              value={data.zip ?? ''}
              onChange={(e) => set('zip', e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input
              className={inputCls}
              placeholder="Latitude (optional)"
              type="number"
              step="any"
              value={data.latitude ?? ''}
              onChange={(e) =>
                set('latitude', e.target.value ? Number(e.target.value) : null)
              }
            />
            <input
              className={inputCls}
              placeholder="Longitude (optional)"
              type="number"
              step="any"
              value={data.longitude ?? ''}
              onChange={(e) =>
                set('longitude', e.target.value ? Number(e.target.value) : null)
              }
            />
          </div>
          <p className="text-xs text-sage-500">
            Lat/lng improve the map pin on phones with weaker geocoding.
            Optional.
          </p>
        </div>
      </section>

      <section className="mb-8 rounded-xl border border-sage-100 bg-white p-6">
        <h2 className="font-medium text-sage-900 mb-4">Parking</h2>
        <textarea
          className={inputCls}
          rows={3}
          placeholder="e.g. Park in the gravel lot to the right of the main gate. Overflow on the grass behind the barn. Valet on Saturday weddings."
          value={data.parking_instructions ?? ''}
          onChange={(e) => set('parking_instructions', e.target.value)}
        />
      </section>

      <section className="mb-8 rounded-xl border border-sage-100 bg-white p-6">
        <h2 className="font-medium text-sage-900 mb-4">Where to enter</h2>
        <textarea
          className={inputCls}
          rows={3}
          placeholder="e.g. Main entrance for couples and guests. Vendors use the rear service road. Accessible entrance is around the side, marked."
          value={data.entry_instructions ?? ''}
          onChange={(e) => set('entry_instructions', e.target.value)}
        />
      </section>

      <section className="mb-8 rounded-xl border border-sage-100 bg-white p-6">
        <h2 className="font-medium text-sage-900 mb-4">Day-of contact</h2>
        <div className="space-y-3">
          <input
            className={inputCls}
            placeholder="Name (e.g. Sarah from Bloom House)"
            value={data.day_of_contact_name ?? ''}
            onChange={(e) => set('day_of_contact_name', e.target.value)}
          />
          <input
            className={inputCls}
            type="tel"
            placeholder="Phone (e.g. +1 555 123 4567)"
            value={data.day_of_contact_phone ?? ''}
            onChange={(e) => set('day_of_contact_phone', e.target.value)}
          />
          <p className="text-xs text-sage-500">
            What couples and vendors see, and what they tap to call on the day.
            Use the venue&apos;s published number, not a personal cell.
          </p>
        </div>
      </section>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-sage-700 text-white text-sm font-medium hover:bg-sage-800 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {saving ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : saved ? (
          <Check className="w-4 h-4" />
        ) : (
          <Save className="w-4 h-4" />
        )}
        {saving ? 'Saving…' : saved ? 'Saved' : 'Save'}
      </button>
    </div>
  )
}
