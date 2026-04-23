'use client'

/**
 * Portal → Accommodations
 *
 * Coordinator editor for the accommodations table — the hotels / inns /
 * Airbnbs a venue recommends for their couples' out-of-town guests. Read
 * by the couple portal (/_couple-pages/venue-inventory/page.tsx) and the
 * wedding-website public route. Every venue ships with an empty table;
 * without entries the couple portal shows no accommodations.
 */

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { Hotel, Save, Plus, Trash2, Loader2, Star } from 'lucide-react'

interface Accommodation {
  id: string | null
  name: string
  type: string
  address: string
  website_url: string
  price_per_night: string
  distance_miles: string
  description: string
  is_recommended: boolean
  sort_order: number
}

const TYPE_OPTIONS = [
  'hotel',
  'inn',
  'bnb',
  'airbnb',
  'vacation_rental',
  'other',
]

function emptyRow(sort: number): Accommodation {
  return {
    id: null,
    name: '',
    type: 'hotel',
    address: '',
    website_url: '',
    price_per_night: '',
    distance_miles: '',
    description: '',
    is_recommended: false,
    sort_order: sort,
  }
}

export default function AccommodationsConfigPage() {
  const venueId = useVenueId()
  const [venueName, setVenueName] = useState('')
  const [rows, setRows] = useState<Accommodation[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const load = useCallback(async () => {
    if (!venueId) return
    setLoading(true)
    const supabase = createClient()
    const [{ data: accs }, { data: cfg }] = await Promise.all([
      supabase
        .from('accommodations')
        .select('*')
        .eq('venue_id', venueId)
        .order('sort_order', { ascending: true }),
      supabase
        .from('venue_config')
        .select('business_name')
        .eq('venue_id', venueId)
        .maybeSingle(),
    ])
    setVenueName((cfg?.business_name as string) || '')
    setRows(
      (accs ?? []).map((a) => ({
        id: a.id as string,
        name: (a.name as string) ?? '',
        type: (a.type as string) ?? 'hotel',
        address: (a.address as string) ?? '',
        website_url: (a.website_url as string) ?? '',
        price_per_night: a.price_per_night != null ? String(a.price_per_night) : '',
        distance_miles: a.distance_miles != null ? String(a.distance_miles) : '',
        description: (a.description as string) ?? '',
        is_recommended: (a.is_recommended as boolean) ?? false,
        sort_order: (a.sort_order as number) ?? 0,
      }))
    )
    setLoading(false)
  }, [venueId])

  useEffect(() => {
    load()
  }, [load])

  function update(i: number, patch: Partial<Accommodation>) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  function remove(i: number) {
    setRows((prev) => prev.filter((_, idx) => idx !== i))
  }

  async function handleSave() {
    if (!venueId) return
    setSaving(true)
    setSaved(false)
    setError(null)
    const supabase = createClient()

    const { data: existing } = await supabase
      .from('accommodations')
      .select('id')
      .eq('venue_id', venueId)
    const currentIds = new Set(rows.filter((r) => r.id).map((r) => r.id as string))
    const toDelete = (existing ?? [])
      .map((r) => r.id as string)
      .filter((id) => !currentIds.has(id))
    if (toDelete.length > 0) {
      const { error: delErr } = await supabase
        .from('accommodations')
        .delete()
        .in('id', toDelete)
      if (delErr) {
        setError(delErr.message)
        setSaving(false)
        return
      }
    }

    const payload = rows
      .filter((r) => r.name.trim() !== '')
      .map((r, i) => ({
        ...(r.id ? { id: r.id } : {}),
        venue_id: venueId,
        name: r.name.trim(),
        type: r.type,
        address: r.address.trim() || null,
        website_url: r.website_url.trim() || null,
        price_per_night: r.price_per_night.trim() ? Number(r.price_per_night) : null,
        distance_miles: r.distance_miles.trim() ? Number(r.distance_miles) : null,
        description: r.description.trim() || null,
        is_recommended: r.is_recommended,
        sort_order: i,
      }))

    if (payload.length > 0) {
      const { error: upErr } = await supabase.from('accommodations').upsert(payload)
      if (upErr) {
        setError(upErr.message)
        setSaving(false)
        return
      }
    }
    setSaved(true)
    setSaving(false)
    setTimeout(() => setSaved(false), 2500)
    await load()
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold text-sage-900 flex items-center gap-2">
          <Hotel className="w-6 h-6 text-sage-600" />
          {venueName ? `${venueName} · Accommodations` : 'Accommodations'}
        </h1>
        <p className="text-sm text-sage-600 mt-1">
          Hotels, inns, and rentals you recommend for out-of-town guests.
          Couples see this list in their portal. Mark your top picks as
          recommended to highlight them.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-sage-500 italic">Loading…</p>
      ) : (
        <div className="space-y-4">
          {rows.length === 0 && (
            <p className="text-sm text-sage-500 italic">
              No accommodations yet. Add the hotels and rentals you recommend.
            </p>
          )}
          {rows.map((r, i) => (
            <div
              key={r.id ?? `new-${i}`}
              className="bg-white border border-sage-200 rounded-lg p-4 space-y-3"
            >
              <div className="flex items-start gap-2">
                <input
                  type="text"
                  value={r.name}
                  onChange={(e) => update(i, { name: e.target.value })}
                  placeholder="Name (e.g. The Hamilton Hotel)"
                  className="flex-1 px-3 py-2 border border-sage-200 rounded text-sm font-medium"
                />
                <select
                  value={r.type}
                  onChange={(e) => update(i, { type: e.target.value })}
                  className="px-3 py-2 border border-sage-200 rounded text-sm"
                >
                  {TYPE_OPTIONS.map((t) => (
                    <option key={t} value={t}>{t.replace('_', ' ')}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => update(i, { is_recommended: !r.is_recommended })}
                  className={`px-2.5 py-2 rounded text-xs font-medium flex items-center gap-1 ${
                    r.is_recommended
                      ? 'bg-amber-100 text-amber-800 border border-amber-300'
                      : 'text-sage-600 border border-transparent hover:bg-sage-50'
                  }`}
                  title={r.is_recommended ? 'Top pick' : 'Mark as top pick'}
                >
                  <Star className={`w-3 h-3 ${r.is_recommended ? 'fill-current' : ''}`} />
                  {r.is_recommended ? 'Top pick' : 'Recommend'}
                </button>
                <button
                  type="button"
                  onClick={() => remove(i)}
                  className="p-2 text-rose-600 hover:bg-rose-50 rounded"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input
                  type="text"
                  value={r.address}
                  onChange={(e) => update(i, { address: e.target.value })}
                  placeholder="Address"
                  className="px-3 py-2 border border-sage-200 rounded text-sm"
                />
                <input
                  type="url"
                  value={r.website_url}
                  onChange={(e) => update(i, { website_url: e.target.value })}
                  placeholder="https://..."
                  className="px-3 py-2 border border-sage-200 rounded text-sm font-mono"
                />
                <input
                  type="number"
                  step="1"
                  value={r.price_per_night}
                  onChange={(e) => update(i, { price_per_night: e.target.value })}
                  placeholder="Price per night ($)"
                  className="px-3 py-2 border border-sage-200 rounded text-sm"
                />
                <input
                  type="number"
                  step="0.1"
                  value={r.distance_miles}
                  onChange={(e) => update(i, { distance_miles: e.target.value })}
                  placeholder="Distance (miles)"
                  className="px-3 py-2 border border-sage-200 rounded text-sm"
                />
              </div>
              <textarea
                value={r.description}
                onChange={(e) => update(i, { description: e.target.value })}
                rows={2}
                placeholder="Short description (optional)"
                className="w-full px-3 py-2 border border-sage-200 rounded text-sm"
              />
            </div>
          ))}
          <button
            type="button"
            onClick={() => setRows((p) => [...p, emptyRow(p.length)])}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm text-sage-700 border border-sage-200 rounded-lg hover:bg-sage-50"
          >
            <Plus className="w-4 h-4" /> Add accommodation
          </button>
        </div>
      )}

      <div className="flex items-center gap-3 pt-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-sage-600 text-white rounded-lg text-sm font-medium hover:bg-sage-700 disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="text-sm text-sage-600">Saved.</span>}
        {error && <span className="text-sm text-rose-600">{error}</span>}
      </div>
    </div>
  )
}
