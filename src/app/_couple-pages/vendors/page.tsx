'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Store,
  ExternalLink,
  Mail,
  Phone,
  Star,
  Check,
  Search,
} from 'lucide-react'

// TODO: Get from auth session / couple context
const WEDDING_ID = '44444444-4444-4444-4444-444444000109'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

const BOOKED_STORAGE_KEY = `bloom_booked_vendors_${WEDDING_ID}`

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VendorRecommendation {
  id: string
  venue_id: string
  vendor_name: string
  vendor_type: string
  contact_email: string | null
  contact_phone: string | null
  website_url: string | null
  description: string | null
  logo_url: string | null
  is_preferred: boolean
  sort_order: number | null
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VENDOR_TYPE_CONFIG: Record<string, { label: string; color: string }> = {
  caterer: { label: 'Caterer', color: '#2D8A4E' },
  photographer: { label: 'Photographer', color: '#5D7A7A' },
  videographer: { label: 'Videographer', color: '#7D8471' },
  florist: { label: 'Florist', color: '#B8908A' },
  dj: { label: 'DJ / Music', color: '#A6894A' },
  band: { label: 'Band', color: '#8B6914' },
  officiant: { label: 'Officiant', color: '#6B7280' },
  planner: { label: 'Planner', color: '#3B82F6' },
  baker: { label: 'Cake / Bakery', color: '#D97706' },
  rentals: { label: 'Rentals / Decor', color: '#7C3AED' },
  hair_makeup: { label: 'Hair & Makeup', color: '#EC4899' },
  transportation: { label: 'Transportation', color: '#0891B2' },
  lighting: { label: 'Lighting', color: '#F59E0B' },
  stationery: { label: 'Stationery', color: '#6366F1' },
  other: { label: 'Other', color: '#9CA3AF' },
}

function getTypeConfig(type: string) {
  return VENDOR_TYPE_CONFIG[type] || VENDOR_TYPE_CONFIG.other
}

// ---------------------------------------------------------------------------
// VendorCard
// ---------------------------------------------------------------------------

function VendorCard({
  vendor,
  isBooked,
  onToggleBooked,
}: {
  vendor: VendorRecommendation
  isBooked: boolean
  onToggleBooked: () => void
}) {
  const typeConfig = getTypeConfig(vendor.vendor_type)

  return (
    <div className={`bg-white rounded-xl shadow-sm border transition-all ${
      isBooked ? 'border-green-300 ring-1 ring-green-200' : 'border-gray-100'
    }`}>
      <div className="p-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-start gap-3 min-w-0">
            {vendor.logo_url ? (
              <img
                src={vendor.logo_url}
                alt={vendor.vendor_name}
                className="w-10 h-10 rounded-lg object-cover shrink-0"
              />
            ) : (
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
                style={{ backgroundColor: typeConfig.color + '15' }}
              >
                <Store className="w-5 h-5" style={{ color: typeConfig.color }} />
              </div>
            )}
            <div className="min-w-0">
              <h3
                className="text-base font-semibold truncate"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                {vendor.vendor_name}
              </h3>
              <div className="flex items-center gap-2 mt-0.5">
                <span
                  className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold text-white"
                  style={{ backgroundColor: typeConfig.color }}
                >
                  {typeConfig.label}
                </span>
                {vendor.is_preferred && (
                  <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700">
                    <Star className="w-2.5 h-2.5" />
                    Preferred
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Booked toggle */}
          <button
            onClick={onToggleBooked}
            className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              isBooked
                ? 'bg-green-100 text-green-700 hover:bg-green-200'
                : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
            }`}
          >
            {isBooked && <Check className="w-3 h-3" />}
            {isBooked ? 'Booked' : 'Mark Booked'}
          </button>
        </div>

        {/* Description */}
        {vendor.description && (
          <p className="text-sm text-gray-600 leading-relaxed mb-4">
            {vendor.description}
          </p>
        )}

        {/* Contact links */}
        <div className="flex items-center gap-3 flex-wrap">
          {vendor.contact_email && (
            <a
              href={`mailto:${vendor.contact_email}`}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 transition-colors"
            >
              <Mail className="w-3.5 h-3.5" />
              {vendor.contact_email}
            </a>
          )}
          {vendor.contact_phone && (
            <a
              href={`tel:${vendor.contact_phone}`}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 transition-colors"
            >
              <Phone className="w-3.5 h-3.5" />
              {vendor.contact_phone}
            </a>
          )}
          {vendor.website_url && (
            <a
              href={vendor.website_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium transition-colors"
              style={{ color: 'var(--couple-secondary)' }}
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Website
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function VendorsPage() {
  const [vendors, setVendors] = useState<VendorRecommendation[]>([])
  const [loading, setLoading] = useState(true)
  const [bookedIds, setBookedIds] = useState<Set<string>>(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [activeType, setActiveType] = useState<string>('all')

  const supabase = createClient()

  // ---- Load booked state from localStorage ----
  useEffect(() => {
    try {
      const stored = localStorage.getItem(BOOKED_STORAGE_KEY)
      if (stored) {
        setBookedIds(new Set(JSON.parse(stored)))
      }
    } catch {
      // Ignore parse errors
    }
  }, [])

  // ---- Fetch vendors ----
  const fetchVendors = useCallback(async () => {
    const { data, error } = await supabase
      .from('vendor_recommendations')
      .select('*')
      .eq('venue_id', VENUE_ID)
      .order('sort_order', { ascending: true })
      .order('vendor_name', { ascending: true })

    if (!error && data) {
      setVendors(data as VendorRecommendation[])
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchVendors()
  }, [fetchVendors])

  // ---- Toggle booked ----
  function toggleBooked(id: string) {
    setBookedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      // Persist to localStorage
      try {
        localStorage.setItem(BOOKED_STORAGE_KEY, JSON.stringify([...next]))
      } catch {
        // Ignore storage errors
      }
      return next
    })
  }

  // ---- Derived data ----
  const vendorTypes = Array.from(new Set(vendors.map((v) => v.vendor_type))).sort()

  const filteredVendors = vendors.filter((v) => {
    if (activeType !== 'all' && v.vendor_type !== activeType) return false
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      return (
        v.vendor_name.toLowerCase().includes(q) ||
        (v.description?.toLowerCase().includes(q) ?? false) ||
        getTypeConfig(v.vendor_type).label.toLowerCase().includes(q)
      )
    }
    return true
  })

  // Group by type
  const groupedVendors: Record<string, VendorRecommendation[]> = {}
  for (const v of filteredVendors) {
    const type = v.vendor_type
    if (!groupedVendors[type]) groupedVendors[type] = []
    groupedVendors[type].push(v)
  }

  const bookedCount = vendors.filter((v) => bookedIds.has(v.id)).length

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1
            className="text-3xl font-bold mb-1"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Vendor Directory
          </h1>
          <p className="text-gray-500 text-sm">
            {vendors.length} recommended vendor{vendors.length !== 1 ? 's' : ''}
            {bookedCount > 0 && (
              <span className="text-green-600 font-medium"> &middot; {bookedCount} booked</span>
            )}
          </p>
        </div>
      </div>

      {/* Search + Type filter */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        {/* Type pills */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => setActiveType('all')}
            className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${
              activeType === 'all'
                ? 'text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
            style={activeType === 'all' ? { backgroundColor: 'var(--couple-primary)' } : undefined}
          >
            All ({vendors.length})
          </button>
          {vendorTypes.map((type) => {
            const config = getTypeConfig(type)
            const count = vendors.filter((v) => v.vendor_type === type).length
            const isActive = activeType === type

            return (
              <button
                key={type}
                onClick={() => setActiveType(type)}
                className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${
                  isActive
                    ? 'text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
                style={isActive ? { backgroundColor: config.color } : undefined}
              >
                {config.label} ({count})
              </button>
            )
          })}
        </div>

        {/* Search */}
        <div className="relative sm:ml-auto">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search vendors..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-lg text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:border-transparent w-full sm:w-64 bg-white"
            style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
          />
        </div>
      </div>

      {/* Vendors grouped by type */}
      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-32 bg-gray-100 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : filteredVendors.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <Store
            className="w-12 h-12 mx-auto mb-4"
            style={{ color: 'var(--couple-primary)', opacity: 0.3 }}
          />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            {searchQuery ? 'No matching vendors' : 'No vendors yet'}
          </h3>
          <p className="text-gray-500 text-sm">
            {searchQuery
              ? `No vendors match "${searchQuery}". Try a different search.`
              : 'Your venue will add recommended vendors here soon.'}
          </p>
        </div>
      ) : activeType !== 'all' ? (
        // Flat list when filtered by type
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filteredVendors.map((vendor) => (
            <VendorCard
              key={vendor.id}
              vendor={vendor}
              isBooked={bookedIds.has(vendor.id)}
              onToggleBooked={() => toggleBooked(vendor.id)}
            />
          ))}
        </div>
      ) : (
        // Grouped by type
        <div className="space-y-8">
          {Object.entries(groupedVendors)
            .sort((a, b) => {
              const aLabel = getTypeConfig(a[0]).label
              const bLabel = getTypeConfig(b[0]).label
              return aLabel.localeCompare(bLabel)
            })
            .map(([type, typeVendors]) => {
              const config = getTypeConfig(type)
              return (
                <section key={type}>
                  <div className="flex items-center gap-2 mb-4">
                    <div
                      className="w-3 h-3 rounded-full"
                      style={{ backgroundColor: config.color }}
                    />
                    <h2
                      className="text-xl font-semibold"
                      style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
                    >
                      {config.label}
                    </h2>
                    <span className="text-xs text-gray-400 font-medium">
                      ({typeVendors.length})
                    </span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {typeVendors.map((vendor) => (
                      <VendorCard
                        key={vendor.id}
                        vendor={vendor}
                        isBooked={bookedIds.has(vendor.id)}
                        onToggleBooked={() => toggleBooked(vendor.id)}
                      />
                    ))}
                  </div>
                </section>
              )
            })}
        </div>
      )}
    </div>
  )
}
