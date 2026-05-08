'use client'

/**
 * /intel/insights/weather-tours — Tier-D #183.
 *
 * Joins tours.weather_at_tour (populated by the per-tour weather stamp
 * cron) with tours.outcome to surface how weather correlates with tour
 * conversion. Self-populates as the cron runs over the next 14 days +
 * backfills 7 days of completed tours.
 *
 * Three buckets: clear (no precip + temp_f_high in comfortable range),
 * cold (low temps), wet (precip > 0). Renders count + booked rate per
 * bucket. Statistical significance (Fisher's exact / chi-sq) deferred —
 * raw counts are useful enough at small N.
 */

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { Cloud, CloudRain, Sun, Snowflake, Loader2, ArrowLeft } from 'lucide-react'
import Link from 'next/link'

interface TourRow {
  id: string
  outcome: string | null
  weather_at_tour: {
    temp_f_high: number | null
    temp_f_low: number | null
    precip_mm: number | null
    conditions: string | null
  } | null
}

interface Bucket {
  key: 'clear' | 'wet' | 'cold' | 'unknown'
  label: string
  Icon: typeof Sun
  count: number
  booked: number
  lost: number
  pending: number
}

function bucketize(t: TourRow): Bucket['key'] {
  const w = t.weather_at_tour
  if (!w) return 'unknown'
  const precip = w.precip_mm ?? 0
  const high = w.temp_f_high ?? null
  if (precip > 0.5) return 'wet'
  if (high != null && high < 40) return 'cold'
  return 'clear'
}

const BUCKET_LABEL: Record<Bucket['key'], { label: string; Icon: typeof Sun }> = {
  clear: { label: 'Clear / mild', Icon: Sun },
  wet: { label: 'Wet (rain or snow)', Icon: CloudRain },
  cold: { label: 'Cold (under 40°F)', Icon: Snowflake },
  unknown: { label: 'Weather unknown', Icon: Cloud },
}

export default function WeatherToursPage() {
  const venueId = useVenueId()
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [buckets, setBuckets] = useState<Bucket[]>([])
  const [totalTours, setTotalTours] = useState(0)

  useEffect(() => {
    if (!venueId) return
    let cancelled = false
    ;(async () => {
      try {
        const supabase = createClient()
        const { data, error } = await supabase
          .from('tours')
          .select('id, outcome, weather_at_tour')
          .eq('venue_id', venueId)
          .not('outcome', 'is', null)
          .limit(1000)
        if (error) throw error
        if (cancelled) return

        const rows = (data ?? []) as TourRow[]
        setTotalTours(rows.length)

        const acc = new Map<Bucket['key'], Bucket>()
        const init = (k: Bucket['key']): Bucket => ({
          key: k,
          label: BUCKET_LABEL[k].label,
          Icon: BUCKET_LABEL[k].Icon,
          count: 0,
          booked: 0,
          lost: 0,
          pending: 0,
        })
        for (const r of rows) {
          const k = bucketize(r)
          const b = acc.get(k) ?? init(k)
          b.count += 1
          const o = (r.outcome ?? '').toLowerCase()
          if (o === 'booked') b.booked += 1
          else if (o === 'lost' || o === 'cancelled' || o === 'no_show') b.lost += 1
          else b.pending += 1
          acc.set(k, b)
        }
        const ordered: Bucket[] = (['clear', 'wet', 'cold', 'unknown'] as const)
          .map((k) => acc.get(k))
          .filter((b): b is Bucket => Boolean(b))
        setBuckets(ordered)
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [venueId])

  if (loading) {
    return (
      <div className="flex items-center justify-center p-16">
        <Loader2 className="w-6 h-6 animate-spin text-sage-400" />
      </div>
    )
  }

  if (err) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <div className="p-4 bg-rose-50 border border-rose-200 rounded-lg text-sm text-rose-700">
          Could not load tour weather data: {err}
        </div>
      </div>
    )
  }

  const stamped = buckets.filter((b) => b.key !== 'unknown').reduce((s, b) => s + b.count, 0)
  const stampedPct = totalTours > 0 ? Math.round((stamped / totalTours) * 100) : 0

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/intel/insights" className="p-2 rounded-lg hover:bg-sage-50 text-sage-500 hover:text-sage-800">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div>
          <h1 className="text-2xl font-serif text-sage-900">Weather × tour outcomes</h1>
          <p className="text-sm text-sage-500 mt-0.5">
            How weather conditions on the tour day correlate with the tour's outcome.
          </p>
        </div>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
        Coverage: {stamped} of {totalTours} completed tours ({stampedPct}%) have weather data. The cron stamps new tours daily and backfills 7 days of completed tours; older tours stay unstamped.
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {buckets.map((b) => {
          const bookedRate = b.count > 0 ? Math.round((b.booked / b.count) * 100) : 0
          const lostRate = b.count > 0 ? Math.round((b.lost / b.count) * 100) : 0
          const Icon = b.Icon
          return (
            <div key={b.key} className="bg-surface border border-border rounded-xl p-5 space-y-3">
              <div className="flex items-center gap-3">
                <Icon className="w-5 h-5 text-teal-600" />
                <h3 className="text-base font-semibold text-sage-800">{b.label}</h3>
              </div>
              <p className="text-3xl font-light text-sage-900">{b.count}</p>
              <p className="text-xs text-sage-500">tours</p>
              {b.count > 0 && (
                <div className="space-y-1.5 pt-3 border-t border-border">
                  <div className="flex justify-between text-sm">
                    <span className="text-sage-600">Booked</span>
                    <span className="text-sage-900 font-medium">{b.booked} ({bookedRate}%)</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-sage-600">Lost</span>
                    <span className="text-sage-900 font-medium">{b.lost} ({lostRate}%)</span>
                  </div>
                  {b.pending > 0 && (
                    <div className="flex justify-between text-sm">
                      <span className="text-sage-500">Pending</span>
                      <span className="text-sage-700">{b.pending}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {totalTours === 0 && (
        <div className="p-8 text-center text-sage-500">
          No completed tours yet for this venue.
        </div>
      )}

      <div className="text-xs text-sage-400 pt-4 border-t border-border">
        Statistical significance (Fisher's exact / chi-sq) at this venue's tour count is generally too low to act on; treat the rates as directional. Cross-venue rollups give better N. See /intel/portfolio for portfolio-level views.
      </div>
    </div>
  )
}
