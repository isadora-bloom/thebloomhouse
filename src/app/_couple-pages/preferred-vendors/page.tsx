'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import {
  Store,
  Star,
  Mail,
  Phone,
  ExternalLink,
  Link2,
  ChevronDown,
  ChevronUp,
  Search,
} from 'lucide-react'

// TODO: Get from auth session / couple context
const WEDDING_ID = 'ab000000-0000-0000-0000-000000000001'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

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
  bio: string | null
  instagram_url: string | null
  facebook_url: string | null
  pricing_info: string | null
  special_offer: string | null
  offer_expires_at: string | null
  portfolio_photos: string[] | null
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

function VendorCard({ vendor }: { vendor: VendorRecommendation }) {
  const [expanded, setExpanded] = useState(false)
  const typeConfig = getTypeConfig(vendor.vendor_type)

  const photos = vendor.portfolio_photos ?? []
  const hasExpandableContent =
    (vendor.bio && vendor.bio !== vendor.description) ||
    vendor.instagram_url ||
    vendor.facebook_url ||
    photos.length > 1

  const isOfferActive =
    vendor.special_offer &&
    (!vendor.offer_expires_at || new Date(vendor.offer_expires_at) >= new Date())

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden transition-all">
      {/* Photo strip — first portfolio photo */}
      {photos.length > 0 && (
        <div className="h-40 w-full overflow-hidden bg-gray-50">
          <img
            src={photos[0]}
            alt={`${vendor.vendor_name} portfolio`}
            className="w-full h-full object-cover"
          />
        </div>
      )}

      <div className="p-5">
        {/* Header row */}
        <div className="flex items-start gap-3 mb-2">
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
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              <span
                className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold text-white"
                style={{ backgroundColor: typeConfig.color }}
              >
                {typeConfig.label}
              </span>
              {vendor.is_preferred && (
                <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[10px] font-semibold text-white"
                  style={{ backgroundColor: '#7D8471' }}
                >
                  <Star className="w-2.5 h-2.5" />
                  Preferred
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Bio / Description */}
        {(vendor.bio || vendor.description) && (
          <p className={cn(
            'text-sm text-gray-600 leading-relaxed mb-3',
            !expanded && 'line-clamp-2'
          )}>
            {vendor.bio || vendor.description}
          </p>
        )}

        {/* Special offer highlight */}
        {isOfferActive && (
          <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-50 border border-amber-100 mb-3">
            <span className="text-amber-600 shrink-0">&#9733;</span>
            <p className="text-sm text-amber-800 font-medium">{vendor.special_offer}</p>
          </div>
        )}

        {/* Contact line */}
        <div className="flex items-center gap-3 flex-wrap mb-2">
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
        </div>

        {/* Website link */}
        {vendor.website_url && (
          <a
            href={vendor.website_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-medium mb-2 transition-colors"
            style={{ color: 'var(--couple-secondary)' }}
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Website
          </a>
        )}

        {/* Pricing info */}
        {vendor.pricing_info && (
          <p className="text-sm italic text-gray-500 mb-2">{vendor.pricing_info}</p>
        )}

        {/* Expanded section */}
        {expanded && hasExpandableContent && (
          <div className="mt-4 pt-4 border-t border-gray-100 space-y-4">
            {/* Full bio if different from description shown */}
            {vendor.bio && vendor.description && vendor.bio !== vendor.description && (
              <div>
                <p className="text-xs text-gray-400 font-medium uppercase mb-1">About</p>
                <p className="text-sm text-gray-600 leading-relaxed">{vendor.bio}</p>
              </div>
            )}

            {/* Social links */}
            {(vendor.instagram_url || vendor.facebook_url) && (
              <div className="flex items-center gap-3">
                {vendor.instagram_url && (
                  <a
                    href={vendor.instagram_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-pink-600 hover:text-pink-700 transition-colors"
                  >
                    <Link2 className="w-4 h-4" />
                    Instagram
                  </a>
                )}
                {vendor.facebook_url && (
                  <a
                    href={vendor.facebook_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors"
                  >
                    <Link2 className="w-4 h-4" />
                    Facebook
                  </a>
                )}
              </div>
            )}

            {/* Photo gallery grid */}
            {photos.length > 1 && (
              <div>
                <p className="text-xs text-gray-400 font-medium uppercase mb-2">Portfolio</p>
                <div className="grid grid-cols-3 gap-2">
                  {photos.slice(1).map((photo, idx) => (
                    <div
                      key={idx}
                      className="aspect-square rounded-lg overflow-hidden bg-gray-50"
                    >
                      <img
                        src={photo}
                        alt={`${vendor.vendor_name} portfolio ${idx + 2}`}
                        className="w-full h-full object-cover"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Expand/collapse toggle */}
        {hasExpandableContent && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-gray-400 hover:text-gray-600 transition-colors"
          >
            {expanded ? (
              <>
                Less <ChevronUp className="w-3.5 h-3.5" />
              </>
            ) : (
              <>
                More <ChevronDown className="w-3.5 h-3.5" />
              </>
            )}
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PreferredVendorsPage() {
  const [vendors, setVendors] = useState<VendorRecommendation[]>([])
  const [loading, setLoading] = useState(true)
  const [activeType, setActiveType] = useState<string>('all')

  const supabase = createClient()

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

  // ---- Derived data ----
  const vendorTypes = Array.from(new Set(vendors.map((v) => v.vendor_type))).sort()

  const filteredVendors = vendors.filter((v) => {
    if (activeType !== 'all' && v.vendor_type !== activeType) return false
    return true
  })

  // Group by type, sorted alphabetically within each group
  const groupedVendors: Record<string, VendorRecommendation[]> = {}
  for (const v of filteredVendors) {
    const type = v.vendor_type
    if (!groupedVendors[type]) groupedVendors[type] = []
    groupedVendors[type].push(v)
  }
  // Sort within each group alphabetically
  for (const type of Object.keys(groupedVendors)) {
    groupedVendors[type].sort((a, b) => a.vendor_name.localeCompare(b.vendor_name))
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Store className="w-6 h-6" style={{ color: 'var(--couple-primary)' }} />
          <h1
            className="text-3xl font-bold"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Preferred Vendors
          </h1>
        </div>
        <p className="text-gray-500 text-sm">
          Trusted vendors recommended by your venue
        </p>
      </div>

      {/* Category Filter — horizontal scrollable pills */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          onClick={() => setActiveType('all')}
          className={cn(
            'px-3 py-1.5 text-xs font-medium rounded-full transition-colors',
            activeType === 'all'
              ? 'text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          )}
          style={activeType === 'all' ? { backgroundColor: '#7D8471' } : undefined}
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
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-full transition-colors',
                isActive
                  ? 'text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              )}
              style={isActive ? { backgroundColor: config.color } : undefined}
            >
              {config.label} ({count})
            </button>
          )
        })}
      </div>

      {/* Vendor Cards */}
      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-40 bg-gray-100 rounded-xl animate-pulse" />
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
            No vendor recommendations available yet
          </h3>
          <p className="text-gray-500 text-sm">
            Your venue will add recommended vendors here soon.
          </p>
        </div>
      ) : activeType !== 'all' ? (
        /* Flat grid when filtered by specific type */
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filteredVendors.map((vendor) => (
            <VendorCard key={vendor.id} vendor={vendor} />
          ))}
        </div>
      ) : (
        /* Grouped by type */
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
                      <VendorCard key={vendor.id} vendor={vendor} />
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
