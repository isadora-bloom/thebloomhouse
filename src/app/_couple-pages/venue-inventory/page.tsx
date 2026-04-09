'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import {
  Package,
  Plus,
  Minus,
  Search,
  ShoppingBag,
  Check,
  X,
  Edit2,
  MessageSquare,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// TODO: Get from auth session
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CatalogItem {
  id: string
  item_name: string
  category: string | null
  description: string | null
  image_url: string | null
  quantity_available: number
  is_active: boolean
}

interface Selection {
  id: string
  catalog_item_id: string
  quantity: number
  notes: string | null
}

const CATEGORY_LABELS: Record<string, string> = {
  arbor: 'Arbor',
  candelabra: 'Candelabra',
  votive: 'Votive',
  hurricane: 'Hurricane',
  cake_stand: 'Cake Stand',
  card_box: 'Card Box',
  table_numbers: 'Table Numbers',
  signs: 'Signs',
  vases: 'Vases',
  runners: 'Runners',
  florals: 'Florals',
  other: 'Other',
}

type CategoryFilter = 'all' | string

// ---------------------------------------------------------------------------
// Venue Inventory Page
// ---------------------------------------------------------------------------

export default function VenueInventoryPage() {
  const { venueId, weddingId, loading: contextLoading } = useCoupleContext()
  const [catalog, setCatalog] = useState<CatalogItem[]>([])
  const [selections, setSelections] = useState<Selection[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all')
  const [showMySelections, setShowMySelections] = useState(false)
  const [editingNotes, setEditingNotes] = useState<string | null>(null)
  const [noteText, setNoteText] = useState('')

  const supabase = createClient()

  // ---- Fetch ----
  const fetchData = useCallback(async () => {
    const [catalogRes, selectionsRes] = await Promise.all([
      supabase
        .from('borrow_catalog')
        .select('*')
        .eq('venue_id', venueId)
        .eq('is_active', true)
        .order('category', { ascending: true })
        .order('item_name', { ascending: true }),
      supabase
        .from('borrow_selections')
        .select('*')
        .eq('wedding_id', weddingId),
    ])

    if (!catalogRes.error && catalogRes.data) {
      setCatalog(catalogRes.data as CatalogItem[])
    }
    if (!selectionsRes.error && selectionsRes.data) {
      setSelections(selectionsRes.data as Selection[])
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ---- Helpers ----
  function getSelection(catalogItemId: string): Selection | undefined {
    return selections.find((s) => s.catalog_item_id === catalogItemId)
  }

  const categories = [...new Set(catalog.map((c) => c.category).filter(Boolean))] as string[]

  const filtered = catalog.filter((item) => {
    if (categoryFilter !== 'all' && item.category !== categoryFilter) return false
    if (showMySelections && !getSelection(item.id)) return false
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      return (
        item.item_name.toLowerCase().includes(q) ||
        (item.description || '').toLowerCase().includes(q)
      )
    }
    return true
  })

  const selectedItems = catalog.filter((item) => getSelection(item.id))

  // ---- Add / Remove ----
  async function addToSelections(catalogItemId: string) {
    await supabase.from('borrow_selections').insert({
      venue_id: venueId,
      wedding_id: weddingId,
      catalog_item_id: catalogItemId,
      quantity: 1,
    })
    fetchData()
  }

  async function updateQuantity(selectionId: string, newQty: number) {
    if (newQty <= 0) {
      await supabase.from('borrow_selections').delete().eq('id', selectionId)
    } else {
      await supabase.from('borrow_selections').update({ quantity: newQty }).eq('id', selectionId)
    }
    fetchData()
  }

  async function removeSelection(selectionId: string) {
    await supabase.from('borrow_selections').delete().eq('id', selectionId)
    fetchData()
  }

  async function saveNotes(selectionId: string) {
    await supabase.from('borrow_selections').update({ notes: noteText.trim() || null }).eq('id', selectionId)
    setEditingNotes(null)
    fetchData()
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
            Venue Inventory
          </h1>
          <p className="text-gray-500 text-sm">
            Browse items available from your venue. Add what you need to your selections.
          </p>
        </div>
        <button
          onClick={() => setShowMySelections(!showMySelections)}
          className={cn(
            'inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border transition-colors',
            showMySelections
              ? 'text-white border-transparent'
              : 'text-gray-600 border-gray-200 hover:bg-gray-50'
          )}
          style={showMySelections ? { backgroundColor: 'var(--couple-primary)' } : undefined}
        >
          <ShoppingBag className="w-4 h-4" />
          My Selections ({selections.length})
        </button>
      </div>

      {/* My Selections Summary (if they have some) */}
      {selectedItems.length > 0 && !showMySelections && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <h3 className="text-sm font-medium text-gray-700 mb-2">Your Selections</h3>
          <div className="flex flex-wrap gap-2">
            {selectedItems.map((item) => {
              const sel = getSelection(item.id)
              return (
                <span
                  key={item.id}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border"
                  style={{
                    backgroundColor: 'color-mix(in srgb, var(--couple-primary) 10%, transparent)',
                    borderColor: 'color-mix(in srgb, var(--couple-primary) 30%, transparent)',
                    color: 'var(--couple-primary)',
                  }}
                >
                  <Check className="w-3 h-3" />
                  {item.item_name}
                  {sel && sel.quantity > 1 && ` (${sel.quantity})`}
                </span>
              )
            })}
          </div>
        </div>
      )}

      {/* Search + Category Filter */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search inventory..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-lg text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:border-transparent w-full"
            style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setCategoryFilter('all')}
            className={cn(
              'px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
              categoryFilter === 'all'
                ? 'text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            )}
            style={categoryFilter === 'all' ? { backgroundColor: 'var(--couple-primary)' } : undefined}
          >
            All
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategoryFilter(cat)}
              className={cn(
                'px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
                categoryFilter === cat
                  ? 'text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              )}
              style={categoryFilter === cat ? { backgroundColor: 'var(--couple-primary)' } : undefined}
            >
              {CATEGORY_LABELS[cat] || cat}
            </button>
          ))}
        </div>
      </div>

      {/* Catalog Grid */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="h-48 bg-gray-100 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <Package className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--couple-primary)', opacity: 0.3 }} />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            {showMySelections
              ? 'No selections yet'
              : searchQuery || categoryFilter !== 'all'
                ? 'No matching items'
                : 'No inventory available'}
          </h3>
          <p className="text-gray-500 text-sm">
            {showMySelections
              ? 'Browse the inventory and add items you need.'
              : searchQuery || categoryFilter !== 'all'
                ? 'Try adjusting your search or filters.'
                : 'Your venue has not added any inventory items yet.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((item) => {
            const sel = getSelection(item.id)
            const isSelected = !!sel

            return (
              <div
                key={item.id}
                className={cn(
                  'bg-white rounded-xl border shadow-sm overflow-hidden hover:shadow-md transition-shadow',
                  isSelected ? 'border-2' : 'border-gray-100'
                )}
                style={isSelected ? { borderColor: 'var(--couple-primary)' } : undefined}
              >
                {/* Image */}
                {item.image_url ? (
                  <div className="h-36 overflow-hidden">
                    <img
                      src={item.image_url}
                      alt={item.item_name}
                      className="w-full h-full object-cover"
                    />
                  </div>
                ) : (
                  <div className="h-24 bg-gray-50 flex items-center justify-center">
                    <Package className="w-8 h-8 text-gray-300" />
                  </div>
                )}

                <div className="p-4">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <h3 className="font-medium text-gray-800 text-sm">{item.item_name}</h3>
                    {item.category && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-500 shrink-0">
                        {CATEGORY_LABELS[item.category] || item.category}
                      </span>
                    )}
                  </div>

                  {item.description && (
                    <p className="text-xs text-gray-500 mb-3 line-clamp-2">{item.description}</p>
                  )}

                  <div className="text-[10px] text-gray-400 mb-3">
                    {item.quantity_available} available
                  </div>

                  {/* Selection controls */}
                  {isSelected && sel ? (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => updateQuantity(sel.id, sel.quantity - 1)}
                          className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50"
                        >
                          <Minus className="w-3.5 h-3.5" />
                        </button>
                        <span className="text-sm font-medium text-gray-800 w-8 text-center tabular-nums">
                          {sel.quantity}
                        </span>
                        <button
                          onClick={() => updateQuantity(sel.id, sel.quantity + 1)}
                          disabled={sel.quantity >= item.quantity_available}
                          className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-30"
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => removeSelection(sel.id)}
                          className="ml-auto p-1.5 rounded-lg text-red-400 hover:text-red-600 hover:bg-red-50"
                          title="Remove from selections"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {/* Notes */}
                      {editingNotes === sel.id ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={noteText}
                            onChange={(e) => setNoteText(e.target.value)}
                            className="flex-1 px-2 py-1 border border-gray-200 rounded text-xs focus:outline-none focus:ring-1"
                            style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                            placeholder="Add a note..."
                            autoFocus
                          />
                          <button
                            onClick={() => saveNotes(sel.id)}
                            className="p-1 rounded text-xs font-medium"
                            style={{ color: 'var(--couple-primary)' }}
                          >
                            Save
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => { setEditingNotes(sel.id); setNoteText(sel.notes || '') }}
                          className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600"
                        >
                          <MessageSquare className="w-3 h-3" />
                          {sel.notes || 'Add note'}
                        </button>
                      )}
                    </div>
                  ) : (
                    <button
                      onClick={() => addToSelections(item.id)}
                      className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium border transition-colors hover:shadow-sm"
                      style={{
                        color: 'var(--couple-primary)',
                        borderColor: 'var(--couple-primary)',
                      }}
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add to My Selections
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
