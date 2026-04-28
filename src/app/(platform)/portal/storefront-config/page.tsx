'use client'

/**
 * Portal → Storefront
 *
 * Coordinator editor for `storefront` — the curated shopping picks
 * (linens, attire, stationery, gifts) that surface on the couple
 * portal /picks page. Each row pairs a product card (image, name,
 * description) with an affiliate link the venue earns from.
 *
 * The audit on 2026-04-28 found this table seed-only with no
 * coordinator UI. New venues' /picks page rendered the empty state.
 *
 * pick_type CHECK constraint (migration 014):
 *   'Best Save' | 'Best Splurge' | 'Best Practical' |
 *   'Spring/Summer' | 'Fall/Winter' | 'Best Custom'
 */

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { ShoppingBag, Plus, Trash2, Loader2, Save, Eye, EyeOff } from 'lucide-react'

interface Pick {
  id: string
  venue_id: string
  pick_name: string
  category: string
  product_type: string | null
  description: string | null
  color_options: string | null
  affiliate_link: string | null
  image_url: string | null
  pick_type: string | null
  is_active: boolean
  sort_order: number
  created_at: string
}

const PICK_TYPES = [
  'Best Save',
  'Best Splurge',
  'Best Practical',
  'Spring/Summer',
  'Fall/Winter',
  'Best Custom',
]

const CATEGORY_HINTS = ['Attire', 'Stationery', 'Gifts', 'Linens', 'Florals', 'Decor', 'Beauty', 'Other']

export default function StorefrontConfigPage() {
  const venueId = useVenueId()
  const [picks, setPicks] = useState<Pick[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [nameDraft, setNameDraft] = useState('')
  const [categoryDraft, setCategoryDraft] = useState('Attire')
  const [pickTypeDraft, setPickTypeDraft] = useState<string>('')
  const [linkDraft, setLinkDraft] = useState('')
  const [descDraft, setDescDraft] = useState('')
  const [imageDraft, setImageDraft] = useState('')

  const load = useCallback(async () => {
    if (!venueId) return
    setLoading(true)
    const supabase = createClient()
    const { data, error: err } = await supabase
      .from('storefront')
      .select('*')
      .eq('venue_id', venueId)
      .order('sort_order', { ascending: true })
      .order('pick_name', { ascending: true })
    if (err) setError(err.message)
    else setPicks((data ?? []) as Pick[])
    setLoading(false)
  }, [venueId])

  useEffect(() => { load() }, [load])

  async function addPick() {
    if (!venueId || !nameDraft.trim() || !categoryDraft.trim()) {
      setError('Pick name and category are required.')
      return
    }
    setSaving(true)
    setError(null)
    const supabase = createClient()
    const nextSort = picks.length === 0 ? 0 : Math.max(...picks.map((p) => p.sort_order)) + 1
    const { error: insErr } = await supabase.from('storefront').insert({
      venue_id: venueId,
      pick_name: nameDraft.trim(),
      category: categoryDraft.trim(),
      pick_type: pickTypeDraft || null,
      affiliate_link: linkDraft.trim() || null,
      description: descDraft.trim() || null,
      image_url: imageDraft.trim() || null,
      sort_order: nextSort,
      is_active: true,
    })
    if (insErr) {
      setError(insErr.message)
    } else {
      setNameDraft('')
      setLinkDraft('')
      setDescDraft('')
      setImageDraft('')
      setPickTypeDraft('')
      await load()
    }
    setSaving(false)
  }

  async function updateField(id: string, patch: Partial<Pick>) {
    const supabase = createClient()
    const { error: updErr } = await supabase.from('storefront').update(patch).eq('id', id)
    if (updErr) {
      setError(updErr.message)
      return
    }
    setPicks((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }

  async function deletePick(id: string) {
    if (!confirm('Delete this pick? It will disappear from the couple /picks page.')) return
    const supabase = createClient()
    const { error: delErr } = await supabase.from('storefront').delete().eq('id', id)
    if (delErr) setError(delErr.message)
    else setPicks((prev) => prev.filter((p) => p.id !== id))
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center gap-2 text-sm text-sage-600">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading storefront…
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-bold text-sage-900 flex items-center gap-2">
          <ShoppingBag className="w-6 h-6 text-sage-600" />
          Couple Portal Picks
        </h1>
        <p className="text-sm text-sage-600 mt-1">
          Curate product recommendations couples see on{' '}
          <code className="text-xs bg-sage-50 px-1.5 py-0.5 rounded">/picks</code> —
          attire, stationery, gifts, linens. Affiliate links are optional but earn
          the venue commission when used.
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Add form */}
      <div className="bg-surface border border-border rounded-xl p-5 space-y-3">
        <h2 className="font-medium text-sage-900 flex items-center gap-2">
          <Plus className="w-4 h-4" /> Add a pick
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input
            placeholder="Pick name (e.g. The Black Tux)"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            className="border border-border rounded px-3 py-2 text-sm"
          />
          <select
            value={categoryDraft}
            onChange={(e) => setCategoryDraft(e.target.value)}
            className="border border-border rounded px-3 py-2 text-sm"
          >
            {CATEGORY_HINTS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select
            value={pickTypeDraft}
            onChange={(e) => setPickTypeDraft(e.target.value)}
            className="border border-border rounded px-3 py-2 text-sm"
          >
            <option value="">— pick type (optional) —</option>
            {PICK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input
            placeholder="Affiliate URL (optional)"
            value={linkDraft}
            onChange={(e) => setLinkDraft(e.target.value)}
            className="border border-border rounded px-3 py-2 text-sm"
          />
          <input
            placeholder="Image URL (optional)"
            value={imageDraft}
            onChange={(e) => setImageDraft(e.target.value)}
            className="border border-border rounded px-3 py-2 text-sm sm:col-span-2"
          />
          <textarea
            placeholder="Description / why this pick (optional)"
            value={descDraft}
            onChange={(e) => setDescDraft(e.target.value)}
            rows={2}
            className="border border-border rounded px-3 py-2 text-sm sm:col-span-2"
          />
        </div>
        <button
          onClick={addPick}
          disabled={saving || !nameDraft.trim()}
          className="px-4 py-2 bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white rounded-lg text-sm font-medium inline-flex items-center gap-1.5"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
          Add
        </button>
      </div>

      {/* List */}
      <div className="space-y-2">
        {picks.length === 0 ? (
          <div className="bg-sage-50 border border-border rounded-lg p-6 text-center text-sm text-sage-500">
            No picks yet. Add one above to populate the couple /picks page.
          </div>
        ) : (
          picks.map((p) => (
            <div
              key={p.id}
              className={`bg-surface border border-border rounded-lg p-4 flex items-start gap-3 ${
                !p.is_active ? 'opacity-60' : ''
              }`}
            >
              {p.image_url && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={p.image_url}
                  alt={p.pick_name}
                  className="w-14 h-14 rounded object-cover bg-sage-50 shrink-0"
                />
              )}
              <div className="flex-1 min-w-0 space-y-1.5">
                <div className="flex items-center gap-2">
                  <input
                    value={p.pick_name}
                    onChange={(e) => setPicks((prev) => prev.map((x) => (x.id === p.id ? { ...x, pick_name: e.target.value } : x)))}
                    onBlur={(e) => updateField(p.id, { pick_name: e.target.value.trim() })}
                    className="font-medium text-sage-900 bg-transparent border-b border-transparent hover:border-sage-200 focus:border-sage-500 focus:outline-none flex-1"
                  />
                  <select
                    value={p.category}
                    onChange={(e) => updateField(p.id, { category: e.target.value })}
                    className="text-xs border border-border rounded px-2 py-0.5"
                  >
                    {CATEGORY_HINTS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <select
                    value={p.pick_type ?? ''}
                    onChange={(e) => updateField(p.id, { pick_type: e.target.value || null })}
                    className="text-xs border border-border rounded px-2 py-0.5"
                  >
                    <option value="">—</option>
                    {PICK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                {p.affiliate_link !== null && (
                  <input
                    value={p.affiliate_link ?? ''}
                    placeholder="(no affiliate link)"
                    onChange={(e) => setPicks((prev) => prev.map((x) => (x.id === p.id ? { ...x, affiliate_link: e.target.value } : x)))}
                    onBlur={(e) => updateField(p.id, { affiliate_link: e.target.value.trim() || null })}
                    className="text-xs text-sage-500 font-mono bg-transparent border-b border-transparent hover:border-sage-200 focus:border-sage-500 focus:outline-none w-full"
                  />
                )}
                <textarea
                  value={p.description ?? ''}
                  placeholder="(no description)"
                  rows={2}
                  onChange={(e) => setPicks((prev) => prev.map((x) => (x.id === p.id ? { ...x, description: e.target.value } : x)))}
                  onBlur={(e) => updateField(p.id, { description: e.target.value.trim() || null })}
                  className="text-sm text-sage-600 bg-transparent border-b border-transparent hover:border-sage-200 focus:border-sage-500 focus:outline-none w-full resize-none"
                />
                <div className="flex items-center gap-3 text-xs text-sage-500">
                  <label className="flex items-center gap-1">
                    <span>Order</span>
                    <input
                      type="number"
                      value={p.sort_order}
                      onChange={(e) => setPicks((prev) => prev.map((x) => (x.id === p.id ? { ...x, sort_order: Number(e.target.value) } : x)))}
                      onBlur={(e) => updateField(p.id, { sort_order: Number(e.target.value) || 0 })}
                      className="w-14 border border-border rounded px-2 py-0.5"
                    />
                  </label>
                </div>
              </div>
              <div className="flex flex-col gap-1.5 shrink-0">
                <button
                  onClick={() => updateField(p.id, { is_active: !p.is_active })}
                  title={p.is_active ? 'Hide' : 'Show'}
                  className="p-1.5 text-sage-500 hover:text-sage-900 hover:bg-sage-50 rounded"
                >
                  {p.is_active ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                </button>
                <button
                  onClick={() => deletePick(p.id)}
                  title="Delete"
                  className="p-1.5 text-red-500 hover:text-red-700 hover:bg-red-50 rounded"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="text-xs text-sage-500 italic flex items-center gap-1">
        <Save className="w-3 h-3" />
        Changes save when you click off a field.
      </div>
    </div>
  )
}
