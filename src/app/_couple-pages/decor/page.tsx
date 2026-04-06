'use client'

// Feature: configurable via venue_config.feature_flags
// Table: decor_inventory

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import {
  Palette,
  Plus,
  Trash2,
  ChevronDown,
  ChevronUp,
  Check,
  X,
} from 'lucide-react'

// TODO: Get from auth session
const WEDDING_ID = 'ab000000-0000-0000-0000-000000000001'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Preset spaces
// ---------------------------------------------------------------------------

const PRESET_SPACES = [
  'Round Guest Tables',
  'Long/Rectangular Guest Tables',
  'Head Table',
  'Sweetheart Table',
  'Cocktail Tables',
  'Ceremony Space',
  'Card & Gift Table',
  'Cake Table',
  'Dessert Table',
  'Bar Area',
  'Favor Table',
  'Memorial Table',
  'Photo Booth',
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DecorItem {
  id: string
  space_name: string
  item_name: string
  source: string
  goes_home_with: string
  leaving_it: boolean
  notes: string | null
  sort_order: number
}

interface ItemFormData {
  item_name: string
  source: string
  goes_home_with: string
  leaving_it: boolean
  notes: string
}

const EMPTY_ITEM: ItemFormData = {
  item_name: '',
  source: '',
  goes_home_with: '',
  leaving_it: false,
  notes: '',
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DecorInventoryPage() {
  const [items, setItems] = useState<DecorItem[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedSpaces, setExpandedSpaces] = useState<Set<string>>(new Set())
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [deleteSpaceConfirm, setDeleteSpaceConfirm] = useState<string | null>(null)

  // Venue-configured spaces (loaded from venue_config.feature_flags.decor_config)
  const [venueSpaces, setVenueSpaces] = useState<string[]>(PRESET_SPACES)

  // Add space state
  const [showSpacePicker, setShowSpacePicker] = useState(false)
  const [customSpaceName, setCustomSpaceName] = useState('')

  // Inline add-item form: which space is being added to
  const [addingToSpace, setAddingToSpace] = useState<string | null>(null)
  const [itemForm, setItemForm] = useState<ItemFormData>(EMPTY_ITEM)

  // Debounced auto-save
  const debounceRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const supabase = createClient()

  // ---- Fetch ----
  const fetchItems = useCallback(async () => {
    const [itemsRes, configRes] = await Promise.all([
      supabase
        .from('decor_inventory')
        .select('*')
        .eq('wedding_id', WEDDING_ID)
        .order('space_name')
        .order('sort_order', { ascending: true }),
      supabase
        .from('venue_config')
        .select('feature_flags')
        .eq('venue_id', VENUE_ID)
        .maybeSingle(),
    ])

    // Load venue-configured spaces if available
    if (configRes.data) {
      const flags = (configRes.data.feature_flags ?? {}) as Record<string, unknown>
      const decorConfig = flags.decor_config as Record<string, unknown> | undefined
      if (decorConfig?.venue_spaces && Array.isArray(decorConfig.venue_spaces) && (decorConfig.venue_spaces as string[]).length > 0) {
        setVenueSpaces(decorConfig.venue_spaces as string[])
      }
    }

    if (!itemsRes.error && itemsRes.data) {
      setItems(itemsRes.data as DecorItem[])
      // Auto-expand all spaces that have items
      const spaces = new Set((itemsRes.data as DecorItem[]).map((i) => i.space_name))
      setExpandedSpaces(spaces)
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchItems()
  }, [fetchItems])

  // ---- Group by space ----
  const spaces = useMemo(() => {
    const grouped: Record<string, DecorItem[]> = {}
    for (const item of items) {
      if (!grouped[item.space_name]) grouped[item.space_name] = []
      grouped[item.space_name].push(item)
    }
    return grouped
  }, [items])

  const spaceNames = useMemo(() => Object.keys(spaces).sort(), [spaces])
  const usedSpaces = new Set(spaceNames)

  // ---- Toggle space ----
  function toggleSpace(name: string) {
    const next = new Set(expandedSpaces)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    setExpandedSpaces(next)
  }

  // ---- Add space ----
  function addPresetSpace(name: string) {
    // Just expand it and start adding an item
    const next = new Set(expandedSpaces)
    next.add(name)
    setExpandedSpaces(next)

    // If space doesn't exist yet, we need at least one item to create it
    // Open the add-item form for this space
    setAddingToSpace(name)
    setItemForm(EMPTY_ITEM)
    setShowSpacePicker(false)
  }

  function addCustomSpace() {
    const name = customSpaceName.trim()
    if (!name) return
    addPresetSpace(name)
    setCustomSpaceName('')
  }

  // ---- Delete space ----
  async function handleDeleteSpace(spaceName: string) {
    const spaceItems = spaces[spaceName] || []
    for (const item of spaceItems) {
      await supabase.from('decor_inventory').delete().eq('id', item.id)
    }
    setDeleteSpaceConfirm(null)
    fetchItems()
  }

  // ---- Add item ----
  async function handleAddItem(spaceName: string) {
    if (!itemForm.item_name.trim()) return

    const payload = {
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      space_name: spaceName,
      item_name: itemForm.item_name.trim(),
      source: itemForm.source.trim() || null,
      goes_home_with: itemForm.leaving_it ? null : (itemForm.goes_home_with.trim() || null),
      leaving_it: itemForm.leaving_it,
      notes: itemForm.notes.trim() || null,
      sort_order: (spaces[spaceName]?.length || 0),
    }

    await supabase.from('decor_inventory').insert(payload)
    setAddingToSpace(null)
    setItemForm(EMPTY_ITEM)
    fetchItems()
  }

  // ---- Debounced field save ----
  function debouncedSave(itemId: string, field: string, value: string | boolean | null) {
    if (debounceRef.current[itemId]) clearTimeout(debounceRef.current[itemId])

    debounceRef.current[itemId] = setTimeout(async () => {
      await supabase
        .from('decor_inventory')
        .update({ [field]: value })
        .eq('id', itemId)
      delete debounceRef.current[itemId]
    }, 400)
  }

  function updateItemLocal(itemId: string, field: string, value: string | boolean | null) {
    setItems((prev) =>
      prev.map((item) => (item.id === itemId ? { ...item, [field]: value } : item)),
    )
    debouncedSave(itemId, field, value)
  }

  // ---- Delete item ----
  async function handleDeleteItem(id: string) {
    await supabase.from('decor_inventory').delete().eq('id', id)
    setDeleteConfirm(null)
    fetchItems()
  }

  // ---- Loading ----
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
          <p className="text-gray-500 text-sm">
            Track all decor items by space. Know what goes where, who brings it, and who takes it home.
          </p>
        </div>
        <button
          onClick={() => setShowSpacePicker(!showSpacePicker)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
          style={{ backgroundColor: 'var(--couple-primary)' }}
        >
          <Plus className="w-4 h-4" />
          Add Space
        </button>
      </div>

      {/* Space picker */}
      {showSpacePicker && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-4">
          <h3
            className="text-sm font-semibold"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Choose a Space
          </h3>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {venueSpaces.map((name) => {
              const used = usedSpaces.has(name)
              return (
                <button
                  key={name}
                  onClick={() => !used && addPresetSpace(name)}
                  disabled={used}
                  className={cn(
                    'px-3 py-2.5 rounded-lg text-xs font-medium border transition-colors text-left',
                    used
                      ? 'bg-gray-50 text-gray-300 border-gray-100 cursor-not-allowed'
                      : 'text-gray-700 border-gray-200 hover:border-gray-400 bg-white hover:bg-gray-50',
                  )}
                >
                  {name}
                  {used && ' (added)'}
                </button>
              )
            })}
          </div>

          {/* Custom space */}
          <div className="flex items-center gap-2 pt-2 border-t border-gray-100">
            <input
              type="text"
              value={customSpaceName}
              onChange={(e) => setCustomSpaceName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addCustomSpace()}
              placeholder="Other space name..."
              className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
              style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
            />
            <button
              onClick={addCustomSpace}
              disabled={!customSpaceName.trim()}
              className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              style={{ backgroundColor: 'var(--couple-primary)' }}
            >
              Add
            </button>
          </div>

          <button
            onClick={() => setShowSpacePicker(false)}
            className="text-xs text-gray-400 hover:text-gray-600"
          >
            Close
          </button>
        </div>
      )}

      {/* Stats */}
      {items.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
            <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
              {spaceNames.length}
            </p>
            <p className="text-xs text-gray-500 font-medium">Spaces</p>
          </div>
          <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
            <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
              {items.length}
            </p>
            <p className="text-xs text-gray-500 font-medium">Items</p>
          </div>
          <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
            <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
              {items.filter((i) => i.leaving_it).length}
            </p>
            <p className="text-xs text-gray-500 font-medium">Leaving Behind</p>
          </div>
        </div>
      )}

      {/* Empty state */}
      {spaceNames.length === 0 && !showSpacePicker && (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <Palette
            className="w-12 h-12 mx-auto mb-4"
            style={{ color: 'var(--couple-primary)', opacity: 0.3 }}
          />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            No decor spaces yet
          </h3>
          <p className="text-gray-500 text-sm mb-4">
            Add spaces like "Head Table" or "Ceremony Space", then list decor items inside each.
          </p>
          <button
            onClick={() => setShowSpacePicker(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
            style={{ backgroundColor: 'var(--couple-primary)' }}
          >
            <Plus className="w-4 h-4" />
            Add First Space
          </button>
        </div>
      )}

      {/* Space sections */}
      {spaceNames.length > 0 && (
        <div className="space-y-3">
          {spaceNames.map((spaceName) => {
            const spaceItems = spaces[spaceName] || []
            const isExpanded = expandedSpaces.has(spaceName)
            const isDeletingSpace = deleteSpaceConfirm === spaceName

            return (
              <div
                key={spaceName}
                className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden"
              >
                {/* Space header */}
                <div className="flex items-center justify-between">
                  <button
                    onClick={() => toggleSpace(spaceName)}
                    className="flex-1 flex items-center gap-2 p-4 hover:bg-gray-50/50 transition-colors text-left"
                  >
                    <h3 className="font-semibold text-gray-800 text-sm">{spaceName}</h3>
                    <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                      {spaceItems.length} item{spaceItems.length !== 1 ? 's' : ''}
                    </span>
                    {isExpanded ? (
                      <ChevronUp className="w-4 h-4 text-gray-400 ml-auto" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-gray-400 ml-auto" />
                    )}
                  </button>

                  {/* Delete space */}
                  <div className="pr-3">
                    {isDeletingSpace ? (
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] text-red-500 mr-1">Delete all?</span>
                        <button
                          onClick={() => handleDeleteSpace(spaceName)}
                          className="p-1 rounded text-red-500 hover:bg-red-50"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setDeleteSpaceConfirm(null)}
                          className="p-1 rounded text-gray-400 hover:bg-gray-100"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setDeleteSpaceConfirm(spaceName)}
                        className="p-1.5 rounded text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                        title="Delete space and all items"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Expanded content */}
                {isExpanded && (
                  <div className="border-t border-gray-100">
                    {/* Column headers */}
                    {spaceItems.length > 0 && (
                      <div className="grid grid-cols-12 gap-2 px-4 py-2 bg-gray-50 text-[10px] font-medium text-gray-400 uppercase tracking-wider">
                        <div className="col-span-3">Item</div>
                        <div className="col-span-2">Source</div>
                        <div className="col-span-2">Goes Home With</div>
                        <div className="col-span-1 text-center">Leave</div>
                        <div className="col-span-3">Notes</div>
                        <div className="col-span-1" />
                      </div>
                    )}

                    {/* Item rows */}
                    <div className="divide-y divide-gray-50">
                      {spaceItems.map((item) => {
                        const isItemDeleting = deleteConfirm === item.id

                        return (
                          <div
                            key={item.id}
                            className="grid grid-cols-12 gap-2 px-4 py-2.5 items-center group hover:bg-gray-50/50 transition-colors"
                          >
                            {/* Item name */}
                            <div className="col-span-3">
                              <input
                                type="text"
                                defaultValue={item.item_name}
                                onBlur={(e) => {
                                  const v = e.target.value.trim()
                                  if (v && v !== item.item_name) updateItemLocal(item.id, 'item_name', v)
                                }}
                                className="w-full text-sm text-gray-800 font-medium bg-transparent border-0 border-b border-transparent hover:border-gray-200 focus:border-gray-300 focus:outline-none px-0 py-0.5 transition-colors"
                              />
                            </div>

                            {/* Source */}
                            <div className="col-span-2">
                              <input
                                type="text"
                                defaultValue={item.source || ''}
                                onBlur={(e) => {
                                  const v = e.target.value.trim() || null
                                  if (v !== (item.source || null)) updateItemLocal(item.id, 'source', v)
                                }}
                                placeholder="Source"
                                className="w-full text-xs text-gray-600 bg-transparent border-0 border-b border-transparent hover:border-gray-200 focus:border-gray-300 focus:outline-none px-0 py-0.5 placeholder:text-gray-300 transition-colors"
                              />
                            </div>

                            {/* Goes home with */}
                            <div className="col-span-2">
                              {item.leaving_it ? (
                                <span className="text-xs text-gray-300">&mdash;</span>
                              ) : (
                                <input
                                  type="text"
                                  defaultValue={item.goes_home_with || ''}
                                  onBlur={(e) => {
                                    const v = e.target.value.trim() || null
                                    if (v !== (item.goes_home_with || null))
                                      updateItemLocal(item.id, 'goes_home_with', v)
                                  }}
                                  placeholder="Who takes it?"
                                  className="w-full text-xs text-gray-600 bg-transparent border-0 border-b border-transparent hover:border-gray-200 focus:border-gray-300 focus:outline-none px-0 py-0.5 placeholder:text-gray-300 transition-colors"
                                />
                              )}
                            </div>

                            {/* Leaving it checkbox */}
                            <div className="col-span-1 flex justify-center">
                              <input
                                type="checkbox"
                                checked={item.leaving_it}
                                onChange={(e) => {
                                  const checked = e.target.checked
                                  updateItemLocal(item.id, 'leaving_it', checked)
                                  if (checked) {
                                    updateItemLocal(item.id, 'goes_home_with', null)
                                  }
                                }}
                                className="w-4 h-4 rounded border-gray-300 cursor-pointer"
                                style={{ accentColor: 'var(--couple-primary)' }}
                                title="Leaving it behind"
                              />
                            </div>

                            {/* Notes */}
                            <div className="col-span-3">
                              <input
                                type="text"
                                defaultValue={item.notes || ''}
                                onBlur={(e) => {
                                  const v = e.target.value.trim() || null
                                  if (v !== (item.notes || null)) updateItemLocal(item.id, 'notes', v)
                                }}
                                placeholder="Notes"
                                className="w-full text-xs text-gray-500 italic bg-transparent border-0 border-b border-transparent hover:border-gray-200 focus:border-gray-300 focus:outline-none px-0 py-0.5 placeholder:text-gray-300 placeholder:not-italic transition-colors"
                              />
                            </div>

                            {/* Delete */}
                            <div className="col-span-1 flex justify-end">
                              {isItemDeleting ? (
                                <div className="flex items-center gap-0.5">
                                  <button
                                    onClick={() => handleDeleteItem(item.id)}
                                    className="p-1 rounded text-red-500 hover:bg-red-50"
                                  >
                                    <Check className="w-3 h-3" />
                                  </button>
                                  <button
                                    onClick={() => setDeleteConfirm(null)}
                                    className="p-1 rounded text-gray-400 hover:bg-gray-100"
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => setDeleteConfirm(item.id)}
                                  className="p-1 rounded text-gray-300 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all"
                                  title="Delete item"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>

                    {/* Inline add item form */}
                    {addingToSpace === spaceName ? (
                      <div className="p-4 bg-gray-50/80 border-t border-gray-100 space-y-3">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">
                              Item Description *
                            </label>
                            <input
                              type="text"
                              value={itemForm.item_name}
                              onChange={(e) => setItemForm({ ...itemForm, item_name: e.target.value })}
                              placeholder="e.g. 10 pillar candles"
                              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                              style={
                                { '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties
                              }
                              autoFocus
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">
                              Source
                            </label>
                            <input
                              type="text"
                              value={itemForm.source}
                              onChange={(e) => setItemForm({ ...itemForm, source: e.target.value })}
                              placeholder="Where is it coming from?"
                              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                              style={
                                { '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties
                              }
                            />
                          </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">
                              Goes Home With
                            </label>
                            <input
                              type="text"
                              value={itemForm.goes_home_with}
                              onChange={(e) =>
                                setItemForm({ ...itemForm, goes_home_with: e.target.value })
                              }
                              disabled={itemForm.leaving_it}
                              placeholder={
                                itemForm.leaving_it ? 'Leaving behind' : 'Who takes it home?'
                              }
                              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent disabled:bg-gray-100 disabled:text-gray-400"
                              style={
                                { '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties
                              }
                            />
                          </div>
                          <div className="flex items-end pb-1">
                            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={itemForm.leaving_it}
                                onChange={(e) =>
                                  setItemForm({
                                    ...itemForm,
                                    leaving_it: e.target.checked,
                                    goes_home_with: e.target.checked ? '' : itemForm.goes_home_with,
                                  })
                                }
                                className="w-4 h-4 rounded border-gray-300"
                                style={{ accentColor: 'var(--couple-primary)' }}
                              />
                              Leaving it behind
                            </label>
                          </div>
                        </div>

                        <div>
                          <label className="block text-xs font-medium text-gray-500 mb-1">
                            Notes
                          </label>
                          <input
                            type="text"
                            value={itemForm.notes}
                            onChange={(e) => setItemForm({ ...itemForm, notes: e.target.value })}
                            placeholder="Setup notes, fragile, etc."
                            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                            style={
                              { '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties
                            }
                          />
                        </div>

                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => {
                              setAddingToSpace(null)
                              setItemForm(EMPTY_ITEM)
                            }}
                            className="px-3 py-1.5 text-sm font-medium text-gray-500 hover:text-gray-700"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={() => handleAddItem(spaceName)}
                            disabled={!itemForm.item_name.trim()}
                            className="px-4 py-1.5 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                            style={{ backgroundColor: 'var(--couple-primary)' }}
                          >
                            Add Item
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="p-3 bg-gray-50/50 border-t border-gray-100">
                        <button
                          onClick={() => {
                            setAddingToSpace(spaceName)
                            setItemForm(EMPTY_ITEM)
                          }}
                          className="text-xs font-medium flex items-center gap-1 hover:opacity-80 transition-opacity"
                          style={{ color: 'var(--couple-primary)' }}
                        >
                          <Plus className="w-3 h-3" />
                          Add item to {spaceName}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Also show add-item form for spaces that don't exist yet but are being created */}
      {addingToSpace && !usedSpaces.has(addingToSpace) && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="p-4 flex items-center gap-2">
            <h3 className="font-semibold text-gray-800 text-sm">{addingToSpace}</h3>
            <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
              new space
            </span>
          </div>
          <div className="p-4 bg-gray-50/80 border-t border-gray-100 space-y-3">
            <p className="text-xs text-gray-500">
              Add your first item to create this space.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Item Description *
                </label>
                <input
                  type="text"
                  value={itemForm.item_name}
                  onChange={(e) => setItemForm({ ...itemForm, item_name: e.target.value })}
                  placeholder="e.g. 10 pillar candles"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Source</label>
                <input
                  type="text"
                  value={itemForm.source}
                  onChange={(e) => setItemForm({ ...itemForm, source: e.target.value })}
                  placeholder="Where is it coming from?"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Goes Home With
                </label>
                <input
                  type="text"
                  value={itemForm.goes_home_with}
                  onChange={(e) => setItemForm({ ...itemForm, goes_home_with: e.target.value })}
                  disabled={itemForm.leaving_it}
                  placeholder={itemForm.leaving_it ? 'Leaving behind' : 'Who takes it home?'}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent disabled:bg-gray-100 disabled:text-gray-400"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                />
              </div>
              <div className="flex items-end pb-1">
                <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={itemForm.leaving_it}
                    onChange={(e) =>
                      setItemForm({
                        ...itemForm,
                        leaving_it: e.target.checked,
                        goes_home_with: e.target.checked ? '' : itemForm.goes_home_with,
                      })
                    }
                    className="w-4 h-4 rounded border-gray-300"
                    style={{ accentColor: 'var(--couple-primary)' }}
                  />
                  Leaving it behind
                </label>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Notes</label>
              <input
                type="text"
                value={itemForm.notes}
                onChange={(e) => setItemForm({ ...itemForm, notes: e.target.value })}
                placeholder="Setup notes, fragile, etc."
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
              />
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setAddingToSpace(null)
                  setItemForm(EMPTY_ITEM)
                }}
                className="px-3 py-1.5 text-sm font-medium text-gray-500 hover:text-gray-700"
              >
                Cancel
              </button>
              <button
                onClick={() => handleAddItem(addingToSpace)}
                disabled={!itemForm.item_name.trim()}
                className="px-4 py-1.5 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                Add Item
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
