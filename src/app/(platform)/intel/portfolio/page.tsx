'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import { useRouter } from 'next/navigation'
import {
  Building2,
  TrendingUp,
  CalendarCheck,
  DollarSign,
  AlertCircle,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

function getSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VenueRow {
  id: string
  name: string
  status: string
  state: string | null
}

interface WeddingRow {
  id: string
  venue_id: string
  status: string
  booking_value: number | null
  created_at: string
}

interface VenueHealthRow {
  venue_id: string
  overall_score: number
}

interface VenueCardData {
  id: string
  name: string
  status: string
  healthScore: number
  inquiriesThisMonth: number
  bookingsThisMonth: number
  revenueThisMonth: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt$(v: number): string {
  return `$${Math.round(v).toLocaleString()}`
}

function healthColor(score: number): string {
  if (score > 70) return 'text-emerald-500'
  if (score > 40) return 'text-amber-500'
  return 'text-red-500'
}

function healthBg(score: number): string {
  if (score > 70) return 'bg-emerald-50 border-emerald-200'
  if (score > 40) return 'bg-amber-50 border-amber-200'
  return 'bg-red-50 border-red-200'
}

function statusBadge(status: string): string {
  switch (status) {
    case 'active':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200'
    case 'onboarding':
      return 'bg-blue-50 text-blue-700 border-blue-200'
    case 'paused':
      return 'bg-amber-50 text-amber-700 border-amber-200'
    case 'churned':
      return 'bg-red-50 text-red-700 border-red-200'
    default:
      return 'bg-sage-50 text-sage-700 border-sage-200'
  }
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function VenueCardSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="animate-pulse space-y-4">
        <div className="flex items-center justify-between">
          <div className="h-5 w-36 bg-sage-100 rounded" />
          <div className="w-14 h-14 bg-sage-100 rounded-full" />
        </div>
        <div className="h-4 w-20 bg-sage-50 rounded" />
        <div className="grid grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-12 bg-sage-50 rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Health Score Ring
// ---------------------------------------------------------------------------

function HealthRing({ score, size = 56 }: { score: number; size?: number }) {
  const radius = (size - 8) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (score / 100) * circumference
  const color = healthColor(score)

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#E8E4DF"
          strokeWidth={4}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={4}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className={color}
        />
      </svg>
      <span className={`absolute inset-0 flex items-center justify-center text-sm font-bold ${color}`}>
        {score}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default function PortfolioOverviewPage() {
  const router = useRouter()
  const [venues, setVenues] = useState<VenueRow[]>([])
  const [weddings, setWeddings] = useState<WeddingRow[]>([])
  const [healthMap, setHealthMap] = useState<Map<string, number>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    const supabase = getSupabase()
    try {
      const [venueRes, weddingRes, healthRes] = await Promise.all([
        supabase.from('venues').select('id, name, status, state'),
        supabase.from('weddings').select('id, venue_id, status, booking_value, created_at'),
        supabase.from('venue_health').select('venue_id, overall_score').order('created_at', { ascending: false }),
      ])
      if (venueRes.error) throw venueRes.error
      if (weddingRes.error) throw weddingRes.error

      setVenues((venueRes.data ?? []) as VenueRow[])
      setWeddings((weddingRes.data ?? []) as WeddingRow[])

      // Build map using latest health score per venue
      const hMap = new Map<string, number>()
      for (const h of (healthRes.data ?? []) as VenueHealthRow[]) {
        if (!hMap.has(h.venue_id)) {
          hMap.set(h.venue_id, h.overall_score)
        }
      }
      setHealthMap(hMap)
      setError(null)
    } catch (err) {
      console.error('Failed to fetch portfolio data:', err)
      setError('Failed to load portfolio data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Filter weddings to this month
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

  const venueCards: VenueCardData[] = useMemo(() => {
    return venues.map((v) => {
      const vw = weddings.filter(
        (w) => w.venue_id === v.id && w.created_at >= monthStart
      )
      const bookings = vw.filter((w) =>
        ['contracted', 'completed'].includes(w.status)
      )
      return {
        id: v.id,
        name: v.name,
        status: v.status,
        healthScore: healthMap.get(v.id) ?? 50,
        inquiriesThisMonth: vw.length,
        bookingsThisMonth: bookings.length,
        revenueThisMonth: bookings.reduce((s, w) => s + (w.booking_value ?? 0), 0),
      }
    })
  }, [venues, weddings, healthMap, monthStart])

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
          Portfolio Overview
        </h1>
        <p className="text-sage-600">
          All venues at a glance. Click any card to view that venue&apos;s dashboard.
        </p>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={() => { setError(null); setLoading(true); fetchData() }}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Venue Grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {Array.from({ length: 6 }).map((_, i) => (
            <VenueCardSkeleton key={i} />
          ))}
        </div>
      ) : venueCards.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <Building2 className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
            No venues found
          </h3>
          <p className="text-sm text-sage-600 max-w-md mx-auto">
            Venues will appear here once onboarded.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {venueCards.map((vc) => (
            <button
              key={vc.id}
              onClick={() => router.push('/intel/dashboard')}
              className={`bg-surface border rounded-xl p-6 shadow-sm hover:shadow-md transition-all text-left ${
                vc.healthScore > 70
                  ? 'border-emerald-200 hover:border-emerald-300'
                  : vc.healthScore > 40
                    ? 'border-amber-200 hover:border-amber-300'
                    : 'border-red-200 hover:border-red-300'
              }`}
            >
              {/* Top row */}
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="font-heading text-base font-semibold text-sage-900 mb-1">
                    {vc.name}
                  </h3>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider border ${statusBadge(vc.status)}`}>
                    {vc.status}
                  </span>
                </div>
                <HealthRing score={vc.healthScore} />
              </div>

              {/* Metrics */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-warm-white rounded-lg p-3 border border-sage-100">
                  <div className="flex items-center gap-1 mb-1">
                    <TrendingUp className="w-3 h-3 text-teal-500" />
                    <span className="text-[10px] text-sage-500">Inquiries</span>
                  </div>
                  <p className="text-lg font-bold text-sage-900 tabular-nums">
                    {vc.inquiriesThisMonth}
                  </p>
                </div>
                <div className="bg-warm-white rounded-lg p-3 border border-sage-100">
                  <div className="flex items-center gap-1 mb-1">
                    <CalendarCheck className="w-3 h-3 text-gold-500" />
                    <span className="text-[10px] text-sage-500">Bookings</span>
                  </div>
                  <p className="text-lg font-bold text-sage-900 tabular-nums">
                    {vc.bookingsThisMonth}
                  </p>
                </div>
                <div className="bg-warm-white rounded-lg p-3 border border-sage-100">
                  <div className="flex items-center gap-1 mb-1">
                    <DollarSign className="w-3 h-3 text-sage-500" />
                    <span className="text-[10px] text-sage-500">Revenue</span>
                  </div>
                  <p className="text-lg font-bold text-sage-900 tabular-nums">
                    {fmt$(vc.revenueThisMonth)}
                  </p>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
