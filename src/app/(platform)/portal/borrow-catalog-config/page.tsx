'use client'

/**
 * Portal → Borrow Catalog
 *
 * Coordinator editor for `borrow_catalog` — the venue's owned decor
 * inventory (arbors, votives, hurricanes, cake stands, etc.) that
 * couples can claim for their wedding from /venue-inventory in the
 * couple portal.
 *
 * The audit on 2026-04-28 found this table seed-only with no
 * coordinator UI. New venues' /venue-inventory page rendered empty.
 *
 * category CHECK constraint (migration 009):
 *   'arbor' | 'candelabra' | 'votive' | 'hurricane' | 'cake_stand'
 *   | 'card_box' | 'table_numbers' | 'signs' | 'vases' | 'runners'
 *   | 'florals' | 'other'
 */

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { Box, Plus, Trash2, Loader2, Save, Eye, EyeOff } from 'lucide-react'

interface CatalogItem {
  id: string
  venue_id: string
  item_name: string
  category: string
  description: string | null
  image_url: string | null
  quantity_available: number
  is_active: boolean
  created_at: string
}

const CATEGORIES = [
  'arbor',
  'candelabra',
  'votive',
  'hurricane',
  'cake_stand',
  'card_box',
  'table_numbers',
  'signs',
  'vases',
  'runners',
  'florals',
  'other',
] as const

function formatCategory(c: string): string {
  return c.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
}

export default function BorrowCatalogConfigPage() {
  const venueId = useVenueId()
  const [items, setItems] = useState<CatalogItem[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [nameDraft, setNameDraft] = useState('')
  const [categoryDraft, setCategoryDraft] = useState<string>('arbor')
  const [descDraft, setDescDraft] = useState('')
  const [imageDraft, setImageDraft] = useState('')
  const [qtyDraft, setQtyDraft] = useState(1)

  const load = useCallback(async () => {
    if (!venueId) return
    setLoading(true)
    const supabase = createClient()
    const { data, error: err } = await supabase
      .from('borrow_catalog')
      .select('*')
      .eq('venue_id', venueId)
      .order('category', { ascending: true })
      .order('item_name', { ascending: true })
    if (err) setError(err.message)
    else setItems((data ?? []) as CatalogItem[])
    setLoading(false)
  }, [venueId])

  useEffect(() => { load() }, [load])

  async function addItem() {
    if (!venueId || !nameDraft.trim()) {
      setError('Item name is required.')
      return
    }
    setSaving(true)
    setError(null)
    const supabase = createClient()
    const { error: insErr } = await supabase.from('borrow_catalog').insert({
      venue_id: venueId,
      item_name: nameDraft.trim(),
      category: categoryDraft,
      description: descDraft.trim() || null,
      image_url: imageDraft.trim() || null,
      quantity_available: qtyDraft,
      is_active: true,
    })
    if (insErr) {
      setError(insErr.message)
    } else {
      setNameDraft('')
      setDescDraft('')
      setImageDraft('')
      setQtyDraft(1)
      await load()
    }
    setSaving(false)
  }

  async function updateField(id: string, patch: Partial<CatalogItem>) {
    const supabase = createClient()
    const { error: updErr } = await supabase
      .from('borrow_catalog')
      .update(patch)
      .eq('id', id)
    if (updErr) {
      setError(updErr.message)
      return
    }
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)))
  }

  async function deleteItem(id: string) {
    if (!confirm('Delete this catalog item? Existing couple selections will keep their reference but new couples will not see it.')) return
    const supabase = createClient()
    const { error: delErr } = await supabase.from('borrow_catalog').delete().eq('id', id)
    if (delErr) setError(delErr.message)
    else setItems((prev) => prev.filter((i) => i.id !== id))
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center gap-2 text-sm text-sage-600">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading catalog…
      </div>
    )
  }

  // Group by category for display
  const byCategory = items.reduce<Record<string, CatalogItem[]>>((acc, it) => {
    (acc[it.category] = acc[it.category] ?? []).push(it)
    return acc
  }, {})

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-bold text-sage-900 flex items-center gap-2">
          <Box className="w-6 h-6 text-sage-600" />
          Couple Portal Borrow Catalog
        </h1>
        <p className="text-sm text-sage-600 mt-1">
          Decor and structural items the venue owns that couples can claim for
          their day. Couples browse and select on{' '}
          <code className="text-xs bg-sage-50 px-1.5 py-0.5 rounded">/venue-inventory</code>;
          their selections land in <code className="text-xs bg-sage-50 px-1.5 py-0.5 rounded">borrow_selections</code>.
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
          <Plus className="w-4 h-4" /> Add an item
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <input
            placeholder="Item name (e.g. Wooden Ceremony Arch)"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            className="border border-border rounded px-3 py-2 text-sm sm:col-span-2"
          />
          <select
            value={categoryDraft}
            onChange={(e) => setCategoryDraft(e.target.value)}
            className="border border-border rounded px-3 py-2 text-sm"
          >
            {CATEGORIES.map((c) => <option key={c} value={c}>{formatCategory(c)}</option>)}
          </select>
          <input
            placeholder="Image URL (optional)"
            value={imageDraft}
            onChange={(e) => setImageDraft(e.target.value)}
            className="border border-border rounded px-3 py-2 text-sm sm:col-span-2"
          />
          <label className="flex items-center gap-2 text-sm text-sage-700 border border-border rounded px-3 py-2">
            <span>Qty</span>
            <input
              type="number"
              min={0}
              value={qtyDraft}
              onChange={(e) => setQtyDraft(Number(e.target.value) || 0)}
              className="flex-1 outline-none"
            />
          </label>
          <textarea
            placeholder="Description (dimensions, condition, color)"
            value={descDraft}
            onChange={(e) => setDescDraft(e.target.value)}
            rows={2}
            className="border border-border rounded px-3 py-2 text-sm sm:col-span-3"
          />
        </div>
        <button
          onClick={addItem}
          disabled={saving || !nameDraft.trim()}
          className="px-4 py-2 bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white rounded-lg text-sm font-medium inline-flex items-center gap-1.5"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
          Add
        </button>
      </div>

      {/* List grouped by category */}
      {items.length === 0 ? (
        <div className="bg-sage-50 border border-border rounded-lg p-6 text-center text-sm text-sage-500">
          Catalog is empty. Add the first item above and couples will see it on /venue-inventory.
        </div>
      ) : (
        Object.entries(byCategory).map(([cat, list]) => (
          <div key={cat} className="space-y-2">
            <h3 className="text-sm font-semibold text-sage-700 uppercase tracking-wide">
              {formatCategory(cat)} <span className="text-sage-400 font-normal">· {list.length}</span>
            </h3>
            <div className="space-y-2">
              {list.map((it) => (
                <div
                  key={it.id}
                  className={`bg-surface border border-border rounded-lg p-4 flex items-start gap-3 ${
                    !it.is_active ? 'opacity-60' : ''
                  }`}
                >
                  {it.image_url && (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={it.image_url}
                      alt={it.item_name}
                      className="w-14 h-14 rounded object-cover bg-sage-50 shrink-0"
                    />
                  )}
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <input
                        value={it.item_name}
                        onChange={(e) => setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, item_name: e.target.value } : x)))}
                        onBlur={(e) => updateField(it.id, { item_name: e.target.value.trim() })}
                        className="font-medium text-sage-900 bg-transparent border-b border-transparent hover:border-sage-200 focus:border-sage-500 focus:outline-none flex-1"
                      />
                      <select
                        value={it.category}
                        onChange={(e) => updateField(it.id, { category: e.target.value })}
                        className="text-xs border border-border rounded px-2 py-0.5"
                      >
                        {CATEGORIES.map((c) => <option key={c} value={c}>{formatCategory(c)}</option>)}
                      </select>
                      <label className="flex items-center gap-1 text-xs text-sage-500">
                        <span>Qty</span>
                        <input
                          type="number"
                          min={0}
                          value={it.quantity_available}
                          onChange={(e) => setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, quantity_available: Number(e.target.value) } : x)))}
                          onBlur={(e) => updateField(it.id, { quantity_available: Number(e.target.value) || 0 })}
                          className="w-14 border border-border rounded px-2 py-0.5"
                        />
                      </label>
                    </div>
                    <textarea
                      value={it.description ?? ''}
                      placeholder="(no description)"
                      rows={2}
                      onChange={(e) => setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, description: e.target.value } : x)))}
                      onBlur={(e) => updateField(it.id, { description: e.target.value.trim() || null })}
                      className="text-sm text-sage-600 bg-transparent border-b border-transparent hover:border-sage-200 focus:border-sage-500 focus:outline-none w-full resize-none"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5 shrink-0">
                    <button
                      onClick={() => updateField(it.id, { is_active: !it.is_active })}
                      title={it.is_active ? 'Hide' : 'Show'}
                      className="p-1.5 text-sage-500 hover:text-sage-900 hover:bg-sage-50 rounded"
                    >
                      {it.is_active ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={() => deleteItem(it.id)}
                      title="Delete"
                      className="p-1.5 text-red-500 hover:text-red-700 hover:bg-red-50 rounded"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      <div className="text-xs text-sage-500 italic flex items-center gap-1">
        <Save className="w-3 h-3" />
        Changes save when you click off a field.
      </div>
    </div>
  )
}
