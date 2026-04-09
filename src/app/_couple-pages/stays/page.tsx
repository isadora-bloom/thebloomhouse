'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import {
  Home,
  MapPin,
  ExternalLink,
  Search,
  DollarSign,
  Star,
  Building2,
  Trees,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// TODO: Get from auth session — venueId used for fetching venue-level data
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Accommodation {
  id: string
  name: string
  type: 'hotel' | 'airbnb' | 'vrbo' | 'boutique' | 'inn' | null
  address: string | null
  website_url: string | null
  price_per_night: number | null
  distance_miles: number | null
  description: string | null
  is_recommended: boolean
  sort_order: number | null
}

type TypeFilter = 'all' | 'hotel' | 'airbnb' | 'vrbo' | 'boutique' | 'inn'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function typeConfig(type: string | null) {
  switch (type) {
    case 'hotel':
      return { label: 'Hotel', icon: Building2, className: 'bg-blue-50 text-blue-700 border-blue-200' }
    case 'airbnb':
      return { label: 'Vacation Rental', icon: Home, className: 'bg-rose-50 text-rose-700 border-rose-200' }
    case 'vrbo':
      return { label: 'Vacation Rental', icon: Home, className: 'bg-indigo-50 text-indigo-700 border-indigo-200' }
    case 'boutique':
      return { label: 'Boutique', icon: Star, className: 'bg-purple-50 text-purple-700 border-purple-200' }
    case 'inn':
      return { label: 'B&B / Inn', icon: Trees, className: 'bg-green-50 text-green-700 border-green-200' }
    default:
      return { label: 'Lodging', icon: Home, className: 'bg-gray-50 text-gray-600 border-gray-200' }
  }
}

function formatPrice(price: number | null): string {
  if (!price) return ''
  return `$${Math.round(price)}/night`
}

function formatDistance(miles: number | null): string {
  if (!miles) return ''
  return `${miles < 1 ? '< 1' : miles.toFixed(1)} mi away`
}

const TYPE_FILTERS: { key: TypeFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'hotel', label: 'Hotels' },
  { key: 'airbnb', label: 'Vacation Rentals' },
  { key: 'boutique', label: 'Boutique' },
  { key: 'inn', label: 'B&B / Inn' },
]

// ---------------------------------------------------------------------------
// Nearby Stays Page
// ---------------------------------------------------------------------------

export default function NearbyStaysPage() {
  const { venueId, loading: contextLoading } = useCoupleContext()
  const [accommodations, setAccommodations] = useState<Accommodation[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')

  const supabase = createClient()

  // ---- Fetch ----
  const fetchAccommodations = useCallback(async () => {
    const { data, error } = await supabase
      .from('accommodations')
      .select('*')
      .eq('venue_id', venueId)
      .eq('is_recommended', true)
      .order('sort_order', { ascending: true, nullsFirst: false })
      .order('distance_miles', { ascending: true, nullsFirst: false })

    if (!error && data) {
      setAccommodations(data as Accommodation[])
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchAccommodations()
  }, [fetchAccommodations])

  // ---- Filtered ----
  const filtered = accommodations.filter((a) => {
    if (typeFilter !== 'all') {
      if (typeFilter === 'airbnb') {
        if (a.type !== 'airbnb' && a.type !== 'vrbo') return false
      } else if (a.type !== typeFilter) {
        return false
      }
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      return (
        a.name.toLowerCase().includes(q) ||
        (a.description || '').toLowerCase().includes(q) ||
        (a.address || '').toLowerCase().includes(q)
      )
    }
    return true
  })

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1
          className="text-3xl font-bold mb-1"
          style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
        >
          Nearby Stays
        </h1>
        <p className="text-gray-500 text-sm">
          Recommended lodging near your venue for you and your guests.
        </p>
      </div>

      {/* Disclaimer */}
      <div className="bg-amber-50 border border-amber-100 rounded-xl p-4">
        <p className="text-xs text-amber-700">
          These are suggestions from your venue. Please verify availability and pricing directly with each property, as rates and availability may change.
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex flex-wrap gap-2">
          {TYPE_FILTERS.map((tf) => (
            <button
              key={tf.key}
              onClick={() => setTypeFilter(tf.key)}
              className={cn(
                'px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
                typeFilter === tf.key
                  ? 'text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              )}
              style={typeFilter === tf.key ? { backgroundColor: 'var(--couple-primary)' } : undefined}
            >
              {tf.label}
            </button>
          ))}
        </div>

        <div className="relative sm:ml-auto">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search stays..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-lg text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:border-transparent w-full sm:w-56"
            style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
          />
        </div>
      </div>

      {/* Stays List */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-32 bg-gray-100 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <Home className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--couple-primary)', opacity: 0.3 }} />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            {searchQuery || typeFilter !== 'all'
              ? 'No matching stays'
              : 'No stays listed yet'}
          </h3>
          <p className="text-gray-500 text-sm">
            {searchQuery || typeFilter !== 'all'
              ? 'Try adjusting your filters.'
              : 'Your venue has not added any lodging recommendations yet.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((stay) => {
            const config = typeConfig(stay.type)
            const TypeIcon = config.icon

            return (
              <div
                key={stay.id}
                className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 hover:shadow-md transition-shadow"
              >
                <div className="flex flex-col sm:flex-row sm:items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <h3 className="font-semibold text-gray-800">{stay.name}</h3>
                      <span className={cn(
                        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border',
                        config.className
                      )}>
                        <TypeIcon className="w-3 h-3" />
                        {config.label}
                      </span>
                    </div>

                    {stay.description && (
                      <p className="text-sm text-gray-600 mb-2">{stay.description}</p>
                    )}

                    <div className="flex items-center gap-4 flex-wrap text-xs text-gray-500">
                      {stay.address && (
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="w-3 h-3" />
                          {stay.address}
                        </span>
                      )}
                      {stay.distance_miles !== null && (
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="w-3 h-3" />
                          {formatDistance(stay.distance_miles)}
                        </span>
                      )}
                      {stay.price_per_night !== null && (
                        <span className="inline-flex items-center gap-1 font-medium text-gray-700">
                          <DollarSign className="w-3 h-3" />
                          {formatPrice(stay.price_per_night)}
                        </span>
                      )}
                    </div>
                  </div>

                  {stay.website_url && (
                    <a
                      href={stay.website_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border transition-colors hover:shadow-sm shrink-0"
                      style={{
                        color: 'var(--couple-primary)',
                        borderColor: 'var(--couple-primary)',
                      }}
                    >
                      <ExternalLink className="w-4 h-4" />
                      View / Book
                    </a>
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
