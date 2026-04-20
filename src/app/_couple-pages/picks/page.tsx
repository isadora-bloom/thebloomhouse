'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import { cn } from '@/lib/utils'
import {
  Sparkles,
  Search,
  ExternalLink,
  Package,
} from 'lucide-react'

// TODO: Get from auth session / couple context
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StorefrontPick {
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
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type PickTypeKey = 'Best Save' | 'Best Splurge' | 'Best Practical' | 'Spring/Summer' | 'Fall/Winter' | 'Best Custom'

const PICK_TYPE_CONFIG: Record<PickTypeKey, { emoji: string; label: string; bgClass: string; textClass: string }> = {
  'Best Save': { emoji: '\uD83D\uDC9A', label: 'Best Save', bgClass: 'bg-green-100', textClass: 'text-green-800' },
  'Best Splurge': { emoji: '\u2728', label: 'Best Splurge', bgClass: 'bg-purple-100', textClass: 'text-purple-800' },
  'Best Practical': { emoji: '\uD83D\uDCA1', label: 'Best Practical', bgClass: 'bg-blue-100', textClass: 'text-blue-800' },
  'Spring/Summer': { emoji: '\uD83C\uDF38', label: 'Spring/Summer', bgClass: 'bg-rose-100', textClass: 'text-rose-800' },
  'Fall/Winter': { emoji: '\uD83C\uDF42', label: 'Fall/Winter', bgClass: 'bg-amber-100', textClass: 'text-amber-800' },
  'Best Custom': { emoji: '\uD83C\uDFA8', label: 'Best Custom', bgClass: 'bg-teal-100', textClass: 'text-teal-800' },
}

const PICK_TYPE_KEYS: PickTypeKey[] = [
  'Best Save',
  'Best Splurge',
  'Best Practical',
  'Spring/Summer',
  'Fall/Winter',
  'Best Custom',
]

function getPickTypeConfig(type: string | null) {
  if (!type) return null
  return PICK_TYPE_CONFIG[type as PickTypeKey] ?? null
}

// ---------------------------------------------------------------------------
// PickCard
// ---------------------------------------------------------------------------

function PickCard({ pick }: { pick: StorefrontPick }) {
  const typeConfig = getPickTypeConfig(pick.pick_type)

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden transition-all hover:shadow-md">
      {/* Image area */}
      <div className="relative aspect-square bg-gray-50 p-2">
        {pick.image_url ? (
          <img
            src={pick.image_url}
            alt={pick.pick_name}
            className="w-full h-full object-contain"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Package className="w-12 h-12 text-gray-300" />
          </div>
        )}

        {/* Pick type badge overlay */}
        {typeConfig && (
          <span
            className={cn(
              'absolute top-2 left-2 inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-semibold',
              typeConfig.bgClass,
              typeConfig.textClass
            )}
          >
            {typeConfig.emoji} {typeConfig.label}
          </span>
        )}
      </div>

      {/* Body */}
      <div className="p-4 flex flex-col flex-1">
        <h3
          className="text-sm font-medium mb-1 truncate"
          style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
        >
          {pick.pick_name}
        </h3>

        {/* Category badge */}
        {pick.category && (
          <span className="inline-flex self-start items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500 mb-1.5">
            {pick.category}
          </span>
        )}

        {pick.description && (
          <p className="text-sm text-gray-500 line-clamp-2 mb-2 leading-relaxed">
            {pick.description}
          </p>
        )}

        {pick.color_options && (
          <p className="text-xs italic text-gray-400 mb-3">
            Colors: {pick.color_options}
          </p>
        )}

        {/* Spacer to push button to bottom */}
        <div className="mt-auto" />

        {pick.affiliate_link && (
          <a
            href={pick.affiliate_link}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-1.5 w-full px-3 py-2 rounded-lg text-xs font-medium text-white transition-colors hover:opacity-90 mt-2"
            style={{ backgroundColor: '#A6894A' }}
          >
            Shop
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PicksPage() {
  const { venueId, weddingId, loading: contextLoading } = useCoupleContext()
  const [picks, setPicks] = useState<StorefrontPick[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState<string>('all')
  const [activePickType, setActivePickType] = useState<string>('all')

  const supabase = createClient()

  // ---- Fetch picks ----
  const fetchPicks = useCallback(async () => {
    if (!venueId) return
    const { data, error } = await supabase
      .from('storefront')
      .select('*')
      .eq('venue_id', venueId)
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('pick_name', { ascending: true })

    if (!error && data) {
      setPicks(data as StorefrontPick[])
    }
    setLoading(false)
  }, [supabase, venueId])

  // BUG-04A: wait for venueId before firing fetch.
  useEffect(() => {
    if (!venueId) return
    fetchPicks()
  }, [venueId, fetchPicks])

  // ---- Derived data ----
  const categories = Array.from(new Set(picks.map((p) => p.category))).sort()

  const filteredPicks = picks.filter((p) => {
    // Category filter
    if (activeCategory !== 'all' && p.category !== activeCategory) return false

    // Pick type filter
    if (activePickType !== 'all' && p.pick_type !== activePickType) return false

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      return (
        p.pick_name.toLowerCase().includes(q) ||
        (p.product_type?.toLowerCase().includes(q) ?? false) ||
        (p.description?.toLowerCase().includes(q) ?? false)
      )
    }

    return true
  })

  // Group by product_type
  const groupedPicks: Record<string, StorefrontPick[]> = {}
  for (const p of filteredPicks) {
    const group = p.product_type || 'Other'
    if (!groupedPicks[group]) groupedPicks[group] = []
    groupedPicks[group].push(p)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Sparkles className="w-6 h-6" style={{ color: '#A6894A' }} />
          <h1
            className="text-3xl font-bold"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Venue Picks
          </h1>
        </div>
        <p className="text-gray-500 text-sm">
          Curated products hand-picked by your venue
        </p>
      </div>

      {/* Search Bar */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          type="text"
          placeholder="Search picks..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9 pr-4 py-2.5 text-sm border border-gray-200 rounded-lg text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:border-transparent w-full bg-white"
          style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
        />
      </div>

      {/* Category Tabs — horizontal scrollable */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
        <button
          onClick={() => setActiveCategory('all')}
          className={cn(
            'px-3 py-1.5 text-xs font-medium rounded-full transition-colors whitespace-nowrap',
            activeCategory === 'all'
              ? 'text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          )}
          style={activeCategory === 'all' ? { backgroundColor: '#7D8471' } : undefined}
        >
          All
        </button>
        {categories.map((cat) => {
          const isActive = activeCategory === cat
          return (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-full transition-colors whitespace-nowrap',
                isActive
                  ? 'text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              )}
              style={isActive ? { backgroundColor: '#7D8471' } : undefined}
            >
              {cat}
            </button>
          )
        })}
      </div>

      {/* Pick Type Filter Pills */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
        <button
          onClick={() => setActivePickType('all')}
          className={cn(
            'px-3 py-1.5 text-xs font-medium rounded-full transition-colors whitespace-nowrap',
            activePickType === 'all'
              ? 'text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          )}
          style={activePickType === 'all' ? { backgroundColor: '#A6894A' } : undefined}
        >
          All
        </button>
        {PICK_TYPE_KEYS.map((type) => {
          const config = PICK_TYPE_CONFIG[type]
          const isActive = activePickType === type
          return (
            <button
              key={type}
              onClick={() => setActivePickType(type)}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-full transition-colors whitespace-nowrap',
                isActive
                  ? cn(config.bgClass, config.textClass)
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              )}
            >
              {config.emoji} {config.label}
            </button>
          )
        })}
      </div>

      {/* Results count */}
      {!loading && filteredPicks.length > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-gray-400">
            Showing {filteredPicks.length} of {picks.length} pick{picks.length !== 1 ? 's' : ''}
            {activeCategory !== 'all' && (
              <span> in <span className="font-medium text-gray-500">{activeCategory}</span></span>
            )}
            {activePickType !== 'all' && (
              <span> tagged <span className="font-medium text-gray-500">{activePickType}</span></span>
            )}
          </p>
          {(activeCategory !== 'all' || activePickType !== 'all' || searchQuery.trim()) && (
            <button
              onClick={() => {
                setActiveCategory('all')
                setActivePickType('all')
                setSearchQuery('')
              }}
              className="text-xs font-medium text-gray-400 hover:text-gray-600 transition-colors"
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      {/* Product Grid */}
      {loading ? (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="aspect-square bg-gray-100 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : filteredPicks.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <Sparkles
            className="w-12 h-12 mx-auto mb-4"
            style={{ color: '#A6894A', opacity: 0.3 }}
          />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            No picks match your filters
          </h3>
          <p className="text-gray-500 text-sm">
            Try adjusting your search or filter criteria.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {Object.entries(groupedPicks)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([productType, typePicks]) => (
              <section key={productType}>
                <div className="flex items-center gap-2 mb-4">
                  <div className="h-px flex-1 bg-gray-200" />
                  <h2
                    className="text-sm font-semibold uppercase tracking-wider text-gray-400 px-2"
                  >
                    {productType}
                  </h2>
                  <div className="h-px flex-1 bg-gray-200" />
                </div>

                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  {typePicks.map((pick) => (
                    <PickCard key={pick.id} pick={pick} />
                  ))}
                </div>
              </section>
            ))}
        </div>
      )}

      {/* Footer — affiliate disclaimer */}
      {filteredPicks.length > 0 && filteredPicks.some((p) => p.affiliate_link) && (
        <p className="text-center text-[11px] text-gray-400 pt-4 border-t border-gray-100">
          Some links may be affiliate links. Your venue may earn a small commission at no extra cost to you.
        </p>
      )}
    </div>
  )
}
