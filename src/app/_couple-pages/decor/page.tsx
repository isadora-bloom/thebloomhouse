'use client'

// Feature: configurable via venue_config.feature_flags
// Table: decor_inventory

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Palette,
  Plus,
  X,
  Edit2,
  Trash2,
  Package,
  ChevronDown,
  ChevronUp,
  Store,
  Home,
  Building2,
  Wrench,
  ArrowRightLeft,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// TODO: Get from auth session
const WEDDING_ID = '44444444-4444-4444-4444-444444000109'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DecorSpace = 'ceremony' | 'reception' | 'tables' | 'entrance' | 'outdoor' | 'restrooms' | 'other'
type DecorSource = 'venue_provided' | 'personal' | 'vendor' | 'diy'
type LeavingAction = 'stays_at_venue' | 'goes_home' | 'vendor_picks_up' | 'donate' | 'trash'

interface DecorItem {
  id: string
  item_name: string
  space: DecorSpace
  quantity: number
  source: DecorSource
  vendor_name: string | null
  leaving_action: LeavingAction | null
  notes: string | null
  sort_order: number
}

interface DecorFormData {
  item_name: string
  space: DecorSpace
  quantity: string
  source: DecorSource
  vendor_name: string
  leaving_action: string
  notes: string
}

const SPACES: { key: DecorSpace; label: string }[] = [
  { key: 'ceremony', label: 'Ceremony' },
  { key: 'reception', label: 'Reception' },
  { key: 'tables', label: 'Tables' },
  { key: 'entrance', label: 'Entrance' },
  { key: 'outdoor', label: 'Outdoor' },
  { key: 'restrooms', label: 'Restrooms' },
  { key: 'other', label: 'Other' },
]

const SOURCES: { key: DecorSource; label: string; icon: typeof Store }[] = [
  { key: 'venue_provided', label: 'Venue Provided', icon: Building2 },
  { key: 'personal', label: 'Personal', icon: Home },
  { key: 'vendor', label: 'Vendor', icon: Store },
  { key: 'diy', label: 'DIY', icon: Wrench },
]

const LEAVING_ACTIONS: { key: LeavingAction; label: string }[] = [
  { key: 'stays_at_venue', label: 'Stays at Venue' },
  { key: 'goes_home', label: 'Goes Home' },
  { key: 'vendor_picks_up', label: 'Vendor Picks Up' },
  { key: 'donate', label: 'Donate' },
  { key: 'trash', label: 'Dispose' },
]

const EMPTY_FORM: DecorFormData = {
  item_name: '',
  space: 'ceremony',
  quantity: '1',
  source: 'personal',
  vendor_name: '',
  leaving_action: '',
  notes: '',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sourceLabel(source: DecorSource): string {
  return SOURCES.find((s) => s.key === source)?.label || source
}

function sourceBadge(source: DecorSource): { bg: string; text: string } {
  const styles: Record<DecorSource, { bg: string; text: string }> = {
    venue_provided: { bg: 'bg-emerald-50 border-emerald-200', text: 'text-emerald-700' },
    personal: { bg: 'bg-blue-50 border-blue-200', text: 'text-blue-700' },
    vendor: { bg: 'bg-purple-50 border-purple-200', text: 'text-purple-700' },
    diy: { bg: 'bg-amber-50 border-amber-200', text: 'text-amber-700' },
  }
  return styles[source] || { bg: 'bg-gray-50 border-gray-200', text: 'text-gray-700' }
}

function spaceLabel(space: DecorSpace): string {
  return SPACES.find((s) => s.key === space)?.label || space
}

function leavingLabel(action: LeavingAction | null): string {
  if (!action) return '--'
  return LEAVING_ACTIONS.find((a) => a.key === action)?.label || action
}

// ---------------------------------------------------------------------------
// Decor Inventory Page
// ---------------------------------------------------------------------------

export default function DecorInventoryPage() {
  const [items, setItems] = useState<DecorItem[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<DecorFormData>(EMPTY_FORM)
  const [expandedSpaces, setExpandedSpaces] = useState<Set<string>>(new Set(SPACES.map((s) => s.key)))

  const supabase = createClient()

  // ---- Fetch ----
  const fetchItems = useCallback(async () => {
    const { data, error } = await supabase
      .from('decor_inventory')
      .select('*')
      .eq('wedding_id', WEDDING_ID)
      .order('space')
      .order('sort_order', { ascending: true })

    if (!error && data) {
      setItems(data as DecorItem[])
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchItems()
  }, [fetchItems])

  // ---- Group by space ----
  const itemsBySpace = useMemo(() => {
    const grouped: Record<string, DecorItem[]> = {}
    for (const item of items) {
      if (!grouped[item.space]) grouped[item.space] = []
      grouped[item.space].push(item)
    }
    return grouped
  }, [items])

  // ---- Source summary ----
  const sourceSummary = useMemo(() => {
    const summary: Record<DecorSource, number> = {
      venue_provided: 0,
      personal: 0,
      vendor: 0,
      diy: 0,
    }
    for (const item of items) {
      summary[item.source] += item.quantity
    }
    return summary
  }, [items])

  // ---- Toggle space ----
  function toggleSpace(space: string) {
    const next = new Set(expandedSpaces)
    if (next.has(space)) next.delete(space)
    else next.add(space)
    setExpandedSpaces(next)
  }

  // ---- Modal helpers ----
  function openAdd(space?: DecorSpace) {
    setForm({ ...EMPTY_FORM, space: space || 'ceremony' })
    setEditingId(null)
    setShowModal(true)
  }

  function openEdit(item: DecorItem) {
    setForm({
      item_name: item.item_name,
      space: item.space,
      quantity: item.quantity.toString(),
      source: item.source,
      vendor_name: item.vendor_name || '',
      leaving_action: item.leaving_action || '',
      notes: item.notes || '',
    })
    setEditingId(item.id)
    setShowModal(true)
  }

  async function handleSave() {
    if (!form.item_name.trim()) return

    const payload = {
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      item_name: form.item_name.trim(),
      space: form.space,
      quantity: parseInt(form.quantity) || 1,
      source: form.source,
      vendor_name: form.source === 'vendor' ? form.vendor_name.trim() || null : null,
      leaving_action: form.leaving_action || null,
      notes: form.notes.trim() || null,
    }

    if (editingId) {
      await supabase.from('decor_inventory').update(payload).eq('id', editingId)
    } else {
      await supabase.from('decor_inventory').insert({
        ...payload,
        sort_order: items.length,
      })
    }

    setShowModal(false)
    setEditingId(null)
    fetchItems()
  }

  async function handleDelete(id: string) {
    if (!confirm('Remove this item from your decor inventory?')) return
    await supabase.from('decor_inventory').delete().eq('id', id)
    fetchItems()
  }

  if (loading) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="h-8 w-48 bg-gray-200 rounded" />
        <div className="h-24 bg-gray-100 rounded-xl" />
        <div className="h-48 bg-gray-100 rounded-xl" />
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
            Decor Inventory
          </h1>
          <p className="text-gray-500 text-sm">Track all decor items by space, source, and leaving instructions.</p>
        </div>
        <button
          onClick={() => openAdd()}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
          style={{ backgroundColor: 'var(--couple-primary)' }}
        >
          <Plus className="w-4 h-4" />
          Add Item
        </button>
      </div>

      {/* Source summary */}
      {items.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {SOURCES.map((src) => {
            const SourceIcon = src.icon
            const badge = sourceBadge(src.key)
            return (
              <div key={src.key} className={`rounded-xl p-4 border text-center ${badge.bg}`}>
                <SourceIcon className={`w-5 h-5 mx-auto mb-2 ${badge.text}`} />
                <p className={`text-2xl font-bold tabular-nums ${badge.text}`}>{sourceSummary[src.key]}</p>
                <p className={`text-xs font-medium ${badge.text} opacity-80`}>{src.label}</p>
              </div>
            )
          })}
        </div>
      )}

      {/* Items by space */}
      {items.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <Palette className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--couple-primary)', opacity: 0.3 }} />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            No decor items yet
          </h3>
          <p className="text-gray-500 text-sm mb-4">Start tracking your decor by adding items to each space.</p>
          <button
            onClick={() => openAdd()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
            style={{ backgroundColor: 'var(--couple-primary)' }}
          >
            <Plus className="w-4 h-4" />
            Add First Item
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {SPACES.map((space) => {
            const spaceItems = itemsBySpace[space.key] || []
            if (spaceItems.length === 0 && !expandedSpaces.has(space.key)) return null

            return (
              <div key={space.key} className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
                <button
                  onClick={() => toggleSpace(space.key)}
                  className="w-full flex items-center justify-between p-4 hover:bg-gray-50/50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-gray-800 text-sm">{space.label}</h3>
                    <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                      {spaceItems.length} item{spaceItems.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  {expandedSpaces.has(space.key) ? (
                    <ChevronUp className="w-4 h-4 text-gray-400" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-gray-400" />
                  )}
                </button>

                {expandedSpaces.has(space.key) && (
                  <div className="border-t border-gray-100">
                    {spaceItems.length === 0 ? (
                      <div className="p-4 text-center">
                        <p className="text-xs text-gray-400">No items in this space.</p>
                      </div>
                    ) : (
                      <div className="divide-y divide-gray-50">
                        {spaceItems.map((item) => {
                          const badge = sourceBadge(item.source)
                          return (
                            <div key={item.id} className="px-4 py-3 group hover:bg-gray-50/50 transition-colors">
                              <div className="flex items-start justify-between gap-3">
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="font-medium text-sm text-gray-800">{item.item_name}</span>
                                    <span className="text-xs text-gray-400">x{item.quantity}</span>
                                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${badge.bg} ${badge.text}`}>
                                      {sourceLabel(item.source)}
                                    </span>
                                    {item.vendor_name && (
                                      <span className="text-xs text-gray-400">{item.vendor_name}</span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-3 mt-1">
                                    {item.leaving_action && (
                                      <span className="text-xs text-gray-400 flex items-center gap-1">
                                        <ArrowRightLeft className="w-3 h-3" />
                                        {leavingLabel(item.leaving_action)}
                                      </span>
                                    )}
                                    {item.notes && (
                                      <span className="text-xs text-gray-400 italic truncate max-w-[300px]">
                                        {item.notes}
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                                  <button
                                    onClick={() => openEdit(item)}
                                    className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                                  >
                                    <Edit2 className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    onClick={() => handleDelete(item.id)}
                                    className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}

                    <div className="p-3 bg-gray-50/50 border-t border-gray-100">
                      <button
                        onClick={() => openAdd(space.key)}
                        className="text-xs font-medium flex items-center gap-1 hover:opacity-80 transition-opacity"
                        style={{ color: 'var(--couple-primary)' }}
                      >
                        <Plus className="w-3 h-3" />
                        Add to {space.label}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Leaving Instructions Summary */}
      {items.filter((i) => i.leaving_action).length > 0 && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
          <h2
            className="text-sm font-semibold mb-3 flex items-center gap-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            <ArrowRightLeft className="w-4 h-4" />
            End-of-Night Summary
          </h2>
          <div className="space-y-2">
            {LEAVING_ACTIONS.map((action) => {
              const actionItems = items.filter((i) => i.leaving_action === action.key)
              if (actionItems.length === 0) return null
              return (
                <div key={action.key} className="flex items-start gap-2">
                  <span className="text-xs font-medium text-gray-500 w-32 shrink-0">{action.label}:</span>
                  <div className="flex flex-wrap gap-1">
                    {actionItems.map((item) => (
                      <span key={item.id} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                        {item.item_name} {item.quantity > 1 ? `(x${item.quantity})` : ''}
                      </span>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
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
                {editingId ? 'Edit Item' : 'Add Decor Item'}
              </h2>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Item Name</label>
                <input
                  type="text"
                  value={form.item_name}
                  onChange={(e) => setForm({ ...form, item_name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="e.g., Pillar Candles"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Space</label>
                  <select
                    value={form.space}
                    onChange={(e) => setForm({ ...form, space: e.target.value as DecorSpace })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  >
                    {SPACES.map((s) => (
                      <option key={s.key} value={s.key}>{s.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Quantity</label>
                  <input
                    type="number"
                    value={form.quantity}
                    onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                    min={1}
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Source</label>
                <div className="grid grid-cols-2 gap-2">
                  {SOURCES.map((src) => {
                    const SrcIcon = src.icon
                    return (
                      <button
                        key={src.key}
                        onClick={() => setForm({ ...form, source: src.key })}
                        className={cn(
                          'flex items-center gap-2 p-2.5 rounded-lg border text-xs font-medium transition-colors',
                          form.source === src.key
                            ? 'text-white border-transparent'
                            : 'text-gray-600 border-gray-200 hover:border-gray-300 bg-white'
                        )}
                        style={form.source === src.key ? { backgroundColor: 'var(--couple-primary)' } : undefined}
                      >
                        <SrcIcon className="w-4 h-4" />
                        {src.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              {form.source === 'vendor' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Vendor Name</label>
                  <input
                    type="text"
                    value={form.vendor_name}
                    onChange={(e) => setForm({ ...form, vendor_name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                    placeholder="e.g., Blooms by Sarah"
                  />
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  <ArrowRightLeft className="w-3.5 h-3.5 inline mr-1" />
                  End-of-Night Plan
                </label>
                <select
                  value={form.leaving_action}
                  onChange={(e) => setForm({ ...form, leaving_action: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                >
                  <option value="">Not decided</option>
                  {LEAVING_ACTIONS.map((a) => (
                    <option key={a.key} value={a.key}>{a.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent resize-none"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  rows={2}
                  placeholder="Setup instructions, fragile handling, etc."
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
                disabled={!form.item_name.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                {editingId ? 'Save Changes' : 'Add Item'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
