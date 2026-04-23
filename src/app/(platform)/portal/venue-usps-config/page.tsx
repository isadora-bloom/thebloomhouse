'use client'

/**
 * Portal → Venue USPs
 *
 * Coordinator editor for venue_usps — the short "what makes us different"
 * statements Sage blends into inquiry and client replies. Every venue ships
 * with an empty table until a coordinator enters these; without them the
 * personality-builder USP block is blank and Sage's drafts read generic.
 *
 * Multi-venue: rows are scoped by venue_id from useVenueId(). Two venues
 * in the same org never see each other's USPs. White-label: header uses
 * the venue's business_name from venue_config.
 */

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { Sparkles, Save, Plus, Trash2, Loader2 } from 'lucide-react'

interface USP {
  id: string | null
  usp_text: string
  sort_order: number
  is_active: boolean
}

export default function VenueUSPsConfigPage() {
  const venueId = useVenueId()
  const [venueName, setVenueName] = useState('')
  const [usps, setUsps] = useState<USP[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const load = useCallback(async () => {
    if (!venueId) return
    setLoading(true)
    const supabase = createClient()
    const [{ data: rows }, { data: cfg }] = await Promise.all([
      supabase
        .from('venue_usps')
        .select('id, usp_text, sort_order, is_active')
        .eq('venue_id', venueId)
        .order('sort_order', { ascending: true }),
      supabase
        .from('venue_config')
        .select('business_name')
        .eq('venue_id', venueId)
        .maybeSingle(),
    ])
    setVenueName((cfg?.business_name as string) || '')
    setUsps(
      (rows ?? []).map((r) => ({
        id: r.id as string,
        usp_text: (r.usp_text as string) ?? '',
        sort_order: (r.sort_order as number) ?? 0,
        is_active: (r.is_active as boolean) ?? true,
      }))
    )
    setLoading(false)
  }, [venueId])

  useEffect(() => {
    load()
  }, [load])

  function addRow() {
    setUsps((prev) => [
      ...prev,
      {
        id: null,
        usp_text: '',
        sort_order: prev.length,
        is_active: true,
      },
    ])
  }

  function removeRow(index: number) {
    setUsps((prev) => prev.filter((_, i) => i !== index))
  }

  function updateRow(index: number, patch: Partial<USP>) {
    setUsps((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  async function handleSave() {
    if (!venueId) return
    setSaving(true)
    setSaved(false)
    setError(null)
    const supabase = createClient()

    // Delete rows removed since load (those in DB but not in current state).
    const { data: existing } = await supabase
      .from('venue_usps')
      .select('id')
      .eq('venue_id', venueId)
    const currentIds = new Set(usps.filter((u) => u.id).map((u) => u.id as string))
    const toDelete = (existing ?? [])
      .map((r) => r.id as string)
      .filter((id) => !currentIds.has(id))
    if (toDelete.length > 0) {
      const { error: delErr } = await supabase
        .from('venue_usps')
        .delete()
        .in('id', toDelete)
      if (delErr) {
        setError(delErr.message)
        setSaving(false)
        return
      }
    }

    // Upsert the remaining rows with normalised sort_order.
    const payload = usps
      .filter((u) => u.usp_text.trim() !== '')
      .map((u, i) => ({
        ...(u.id ? { id: u.id } : {}),
        venue_id: venueId,
        usp_text: u.usp_text.trim(),
        sort_order: i,
        is_active: u.is_active,
      }))
    if (payload.length > 0) {
      const { error: upErr } = await supabase.from('venue_usps').upsert(payload)
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
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold text-sage-900 flex items-center gap-2">
          <Sparkles className="w-6 h-6 text-sage-600" />
          {venueName ? `${venueName} · What makes us different` : 'Venue USPs'}
        </h1>
        <p className="text-sm text-sage-600 mt-1">
          Short statements Sage weaves into inquiry and client replies. Keep
          each one punchy — 8–15 words. Reorder by dragging or editing in
          place; the order here is the order Sage cycles through.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-sage-500 italic">Loading…</p>
      ) : (
        <div className="space-y-3">
          {usps.length === 0 && (
            <p className="text-sm text-sage-500 italic">
              No USPs yet. Add one to start shaping Sage's voice.
            </p>
          )}
          {usps.map((u, i) => (
            <div
              key={u.id ?? `new-${i}`}
              className="flex items-start gap-2 bg-white border border-sage-200 rounded-lg p-3"
            >
              <span className="text-xs font-mono text-sage-400 pt-2 w-6 text-right shrink-0">
                {i + 1}
              </span>
              <textarea
                value={u.usp_text}
                onChange={(e) => updateRow(i, { usp_text: e.target.value })}
                rows={2}
                placeholder="e.g. Historic 1906 estate on 200 acres of Virginia hills — every couple gets the whole property."
                className="flex-1 px-3 py-2 border border-sage-200 rounded text-sm"
              />
              <label className="flex items-center gap-1 text-xs text-sage-700 pt-2 shrink-0">
                <input
                  type="checkbox"
                  checked={u.is_active}
                  onChange={(e) => updateRow(i, { is_active: e.target.checked })}
                />
                Active
              </label>
              <button
                type="button"
                onClick={() => removeRow(i)}
                className="p-2 text-rose-600 hover:bg-rose-50 rounded"
                title="Remove this USP"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addRow}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm text-sage-700 border border-sage-200 rounded-lg hover:bg-sage-50"
          >
            <Plus className="w-4 h-4" /> Add USP
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
          {saving ? 'Saving…' : 'Save USPs'}
        </button>
        {saved && <span className="text-sm text-sage-600">Saved.</span>}
        {error && <span className="text-sm text-rose-600">{error}</span>}
      </div>
    </div>
  )
}
