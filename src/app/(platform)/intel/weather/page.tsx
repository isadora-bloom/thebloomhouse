'use client'

/**
 * /intel/weather — TIER 6 (2026-05-14).
 *
 * Coordinator-facing weather page. The plumbing (Open-Meteo cron,
 * weather_data, weather × cancellation correlation) already exists; this
 * page surfaces the join: which upcoming tours + weddings are on
 * bad-weather days, plus the latest weather-correlation insight if any.
 *
 * Three sections:
 *   1. 14-day forecast strip
 *   2. Upcoming tours/weddings at risk
 *   3. Latest weather-cancellation insight (if any)
 */

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import {
  Cloud,
  CloudRain,
  CloudSnow,
  Sun,
  Wind,
  AlertTriangle,
  Calendar,
  Sparkles,
  Loader2,
} from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { WhyThisCard } from '@/components/ui/why-this-card'

interface ForecastDay {
  date: string
  high_temp: number | null
  low_temp: number | null
  precipitation: number | null
  conditions: string | null
  weather_score: number
  risk_band: 'good' | 'fair' | 'poor' | 'severe'
}

interface UpcomingTourRow {
  tour_id: string
  scheduled_at: string
  date: string
  couple_display_name: string | null
  wedding_id: string | null
  weather: ForecastDay | null
}

interface UpcomingWeddingRow {
  wedding_id: string
  wedding_date: string
  display_name: string | null
  booking_value: number | null
  weather: ForecastDay | null
}

interface WeatherInsight {
  id: string
  title: string
  body: string | null
  generated_at: string
}

interface Overlay {
  venue_id: string
  generated_at: string
  forecast: ForecastDay[]
  upcoming_tours: UpcomingTourRow[]
  upcoming_weddings: UpcomingWeddingRow[]
  latest_insight: WeatherInsight | null
  data_gated: boolean
  data_gated_reason: string | null
}

const RISK_COLORS: Record<ForecastDay['risk_band'], string> = {
  good: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  fair: 'bg-sage-50 text-sage-700 border-sage-200',
  poor: 'bg-amber-50 text-amber-800 border-amber-200',
  severe: 'bg-rose-50 text-rose-700 border-rose-200',
}

const RISK_LABEL: Record<ForecastDay['risk_band'], string> = {
  good: 'Good',
  fair: 'Fair',
  poor: 'Bad',
  severe: 'Severe',
}

function conditionIcon(conditions: string | null) {
  if (!conditions) return Cloud
  const c = conditions.toLowerCase()
  if (c.includes('snow')) return CloudSnow
  if (c.includes('rain') || c.includes('drizzle') || c.includes('shower')) return CloudRain
  if (c.includes('clear')) return Sun
  if (c.includes('thunder') || c.includes('storm')) return Wind
  return Cloud
}

function dayLabel(dateStr: string): { weekday: string; day: string; month: string } {
  const d = new Date(`${dateStr}T12:00:00Z`)
  return {
    weekday: d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
    day: String(d.getUTCDate()),
    month: d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }),
  }
}

function formatTemp(n: number | null): string {
  if (n === null) return '—'
  return `${Math.round(n)}°`
}

function formatBookingValue(cents: number | null): string {
  if (cents === null) return '—'
  const dollars = cents / 100
  if (dollars >= 1000) return `$${(dollars / 1000).toFixed(1)}k`
  return `$${Math.round(dollars)}`
}

export default function WeatherPage() {
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/intel/weather')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setOverlay(json.overlay)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-sage-500 p-6">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading weather…
      </div>
    )
  }

  if (error) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Could not load weather"
        subtitle={error}
        action={{ label: 'Retry', onClick: () => void load() }}
      />
    )
  }

  if (!overlay || overlay.data_gated) {
    const reason =
      overlay?.data_gated_reason === 'no_venue_coordinates'
        ? "Add the venue's latitude and longitude in venue settings to unlock weather intelligence."
        : "The forecast cron has not populated this venue yet. The next nightly run will pull 14 days from Open-Meteo."
    return (
      <EmptyState
        icon={Cloud}
        title="Weather not available yet"
        subtitle={reason}
        action={
          overlay?.data_gated_reason === 'no_venue_coordinates'
            ? { label: 'Open venue settings', href: '/settings/venue-info' }
            : undefined
        }
      />
    )
  }

  const riskyTours = overlay.upcoming_tours.filter(
    (t) => t.weather && (t.weather.risk_band === 'poor' || t.weather.risk_band === 'severe'),
  )
  const riskyWeddings = overlay.upcoming_weddings.filter(
    (w) => w.weather && (w.weather.risk_band === 'poor' || w.weather.risk_band === 'severe'),
  )

  return (
    <div className="space-y-8 max-w-6xl">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold text-sage-900">
            Weather Intelligence
          </h1>
          <p className="text-sm text-sage-600 mt-1">
            14-day forecast laid over your tour + wedding pipeline. Bad-weather
            days surface so you can reach out about rain plans, shuttle changes,
            or rescheduling before the day arrives.
          </p>
        </div>
        <p className="text-xs text-sage-500 mt-2">
          Updated {new Date(overlay.generated_at).toLocaleString()}
        </p>
      </header>

      {/* 14-day forecast strip */}
      <section className="bg-surface border border-border rounded-xl shadow-sm p-5">
        <h2 className="font-heading text-base font-semibold text-sage-900 mb-4 flex items-center gap-2">
          <Calendar className="w-4 h-4 text-sage-500" />
          14-day forecast
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-2">
          {overlay.forecast.map((day) => {
            const Icon = conditionIcon(day.conditions)
            const label = dayLabel(day.date)
            return (
              <div
                key={day.date}
                className={`rounded-lg border px-2 py-3 text-center ${RISK_COLORS[day.risk_band]}`}
              >
                <div className="text-[11px] uppercase tracking-wide opacity-70">
                  {label.weekday}
                </div>
                <div className="text-lg font-semibold leading-tight">{label.day}</div>
                <div className="text-[10px] opacity-70 mb-1">{label.month}</div>
                <Icon className="w-5 h-5 mx-auto mb-1 opacity-80" />
                <div className="text-xs font-medium">
                  {formatTemp(day.high_temp)} / {formatTemp(day.low_temp)}
                </div>
                {day.precipitation && day.precipitation > 0 ? (
                  <div className="text-[10px] opacity-70 mt-0.5">
                    {day.precipitation.toFixed(2)}″
                  </div>
                ) : null}
                <div className="text-[10px] uppercase tracking-wide mt-1 opacity-80">
                  {RISK_LABEL[day.risk_band]}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {/* Tours at risk */}
      <section className="bg-surface border border-border rounded-xl shadow-sm p-5">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h2 className="font-heading text-base font-semibold text-sage-900 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-gold-500" />
            Tours at weather risk
            <span className="text-xs font-normal text-sage-500">
              ({riskyTours.length} of {overlay.upcoming_tours.length})
            </span>
          </h2>
        </div>
        {overlay.upcoming_tours.length === 0 ? (
          <EmptyState
            icon={Calendar}
            text="No tours scheduled in the next 14 days."
            variant="dashed"
          />
        ) : riskyTours.length === 0 ? (
          <EmptyState
            icon={Sun}
            text="Every upcoming tour falls on a Good or Fair day."
            variant="dashed"
          />
        ) : (
          <ul className="space-y-2">
            {riskyTours.map((t) => {
              const Icon = conditionIcon(t.weather?.conditions ?? null)
              const day = dayLabel(t.date)
              const tourTime = new Date(t.scheduled_at).toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
              })
              return (
                <li
                  key={t.tour_id}
                  className={`rounded-lg border px-3 py-2 flex items-center gap-3 ${
                    t.weather ? RISK_COLORS[t.weather.risk_band] : 'border-border bg-warm-white'
                  }`}
                >
                  <Icon className="w-4 h-4 flex-shrink-0 opacity-80" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-sage-900">
                      {t.couple_display_name ?? 'Unnamed couple'}
                    </div>
                    <div className="text-xs text-sage-600">
                      {day.weekday} {day.month} {day.day} · {tourTime} ·{' '}
                      {t.weather?.conditions ?? 'No forecast'}
                    </div>
                  </div>
                  {t.wedding_id ? (
                    <Link
                      href={`/intel/clients/${t.wedding_id}`}
                      className="text-xs font-medium hover:underline"
                    >
                      View lead
                    </Link>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* Weddings at risk */}
      {overlay.upcoming_weddings.length > 0 ? (
        <section className="bg-surface border border-border rounded-xl shadow-sm p-5">
          <h2 className="font-heading text-base font-semibold text-sage-900 mb-4 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-rose-500" />
            Weddings in forecast window
            <span className="text-xs font-normal text-sage-500">
              ({riskyWeddings.length} at risk of {overlay.upcoming_weddings.length})
            </span>
          </h2>
          <ul className="space-y-2">
            {overlay.upcoming_weddings.map((w) => {
              const Icon = conditionIcon(w.weather?.conditions ?? null)
              const day = dayLabel(w.wedding_date)
              return (
                <li
                  key={w.wedding_id}
                  className={`rounded-lg border px-3 py-2 flex items-center gap-3 ${
                    w.weather ? RISK_COLORS[w.weather.risk_band] : 'border-border bg-warm-white'
                  }`}
                >
                  <Icon className="w-4 h-4 flex-shrink-0 opacity-80" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-sage-900">
                      {w.display_name ?? 'Unnamed wedding'}
                    </div>
                    <div className="text-xs text-sage-600">
                      {day.weekday} {day.month} {day.day} ·{' '}
                      {w.weather?.conditions ?? 'No forecast'} · {formatBookingValue(w.booking_value)}
                    </div>
                  </div>
                  <Link
                    href={`/intel/clients/${w.wedding_id}`}
                    className="text-xs font-medium hover:underline"
                  >
                    View
                  </Link>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      {/* Correlation insight */}
      {overlay.latest_insight ? (
        <section className="bg-surface border border-border rounded-xl shadow-sm p-5">
          <h2 className="font-heading text-base font-semibold text-sage-900 mb-3 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-sage-500" />
            What we have learned at this venue
          </h2>
          <div className="rounded-lg border border-sage-100 bg-warm-white p-4">
            <p className="text-sm font-medium text-sage-900">
              {overlay.latest_insight.title}
            </p>
            {overlay.latest_insight.body ? (
              <p className="text-sm text-sage-700 mt-1.5 leading-relaxed">
                {overlay.latest_insight.body}
              </p>
            ) : null}
            <p className="text-xs text-sage-500 mt-2">
              Generated {new Date(overlay.latest_insight.generated_at).toLocaleDateString()}
            </p>
          </div>
          <WhyThisCard
            className="mt-3"
            title="Why this surfaces"
            reasoning="When tour cancellations or no-shows correlate with bad-weather days, the weather × cancellation correlator writes a deterministic insight, then a Sonnet narrator describes it in coordinator voice. The bar is 1.5x baseline cancellation in a bad-weather bucket with at least the minimum tour sample."
            source="weather-cancellation.ts"
          />
        </section>
      ) : null}
    </div>
  )
}
