'use client'

/**
 * /intel/weather — Weather Intelligence (TIER 6 + TIER 6+).
 *
 * Reframed 2026-05-14 from "tour-risk forecast" to "pricing + planning
 * + expectation-setting + anomaly explanation". The 14-day forecast
 * + at-risk tour list is preserved at the bottom because it still has
 * value, but the page now leads with:
 *
 *   1. Month profile — typical conditions at this venue per month with
 *      decade trend deltas. Pricing + couple-conversation answers.
 *   2. Notable past weather + ops impact — explains why prior months
 *      under-performed or over-performed. Useful for budget reviews
 *      and projecting future periods.
 *   3. 14-day forecast — operational view (existing TIER 6 content).
 *
 * History is opt-in: operators click "Refresh history" once to pull
 * the 20-year Open-Meteo archive into climate_norms + anomaly_events.
 * Annual refresh is enough; climate norms do not move overnight.
 */

import { useEffect, useState, useCallback, useMemo } from 'react'
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
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Snowflake,
  Thermometer,
  Droplets,
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

interface ClimateHourCell {
  hour_local: number
  recent_temp_avg_f: number | null
  recent_temp_p10_f: number | null
  recent_temp_p90_f: number | null
  recent_precip_prob_pct: number | null
  prior_temp_avg_f: number | null
  prior_precip_prob_pct: number | null
}

interface ClimateMonthProfile {
  month_num: number
  month_label: string
  hours: ClimateHourCell[]
  daytime_temp_avg_f: number | null
  daytime_precip_prob_pct: number | null
  daytime_temp_delta_f: number | null
  daytime_precip_prob_delta_pct: number | null
  recent_window_start: string | null
  recent_window_end: string | null
  prior_window_start: string | null
  prior_window_end: string | null
  refreshed_at: string | null
}

interface AnomalyEvent {
  id: string
  event_type: string
  start_date: string
  end_date: string
  duration_days: number
  severity: 'moderate' | 'severe' | 'extreme'
  description: string
  min_temp_f: number | null
  max_temp_f: number | null
  total_precip_in: number | null
  total_snow_in: number | null
  inquiries_during: number | null
  inquiries_typical: number | null
  tours_during: number | null
  tours_typical: number | null
}

interface Overlay {
  venue_id: string
  generated_at: string
  forecast: ForecastDay[]
  upcoming_tours: UpcomingTourRow[]
  upcoming_weddings: UpcomingWeddingRow[]
  latest_insight: WeatherInsight | null
  climate_months: ClimateMonthProfile[]
  anomaly_events: AnomalyEvent[]
  history_available: boolean
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

const EVENT_ICONS: Record<string, typeof Sun> = {
  cold_snap: Snowflake,
  heat_wave: Thermometer,
  wet_stretch: CloudRain,
  severe_storm: Wind,
  snow_event: CloudSnow,
  warm_month: TrendingUp,
  cool_month: TrendingDown,
  wet_month: Droplets,
  dry_month: Sun,
}

const EVENT_TONE: Record<string, string> = {
  cold_snap: 'bg-sky-50 text-sky-800 border-sky-200',
  heat_wave: 'bg-orange-50 text-orange-800 border-orange-200',
  wet_stretch: 'bg-indigo-50 text-indigo-800 border-indigo-200',
  severe_storm: 'bg-rose-50 text-rose-800 border-rose-200',
  snow_event: 'bg-sky-50 text-sky-800 border-sky-200',
  warm_month: 'bg-amber-50 text-amber-800 border-amber-200',
  cool_month: 'bg-sky-50 text-sky-800 border-sky-200',
  wet_month: 'bg-indigo-50 text-indigo-800 border-indigo-200',
  dry_month: 'bg-emerald-50 text-emerald-800 border-emerald-200',
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

function monthYearLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`)
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
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

function impactLabel(during: number | null, typical: number | null): { label: string; tone: string } | null {
  if (during === null || typical === null) return null
  if (typical === 0 && during === 0) return { label: '0 vs typical 0', tone: 'text-sage-500' }
  if (typical === 0) return { label: `${during} (no typical baseline yet)`, tone: 'text-sage-700' }
  const delta = during - typical
  const pct = Math.round((delta / typical) * 100)
  const tone = delta < 0 ? 'text-rose-700' : delta > 0 ? 'text-emerald-700' : 'text-sage-700'
  const sign = delta > 0 ? '+' : ''
  return {
    label: `${during} vs typical ${typical} (${sign}${pct}%)`,
    tone,
  }
}

export default function WeatherPage() {
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedMonth, setSelectedMonth] = useState<number>(() => new Date().getMonth() + 1)

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

  const refreshHistory = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      const res = await fetch('/api/intel/weather/refresh-history', { method: 'POST' })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error(json.error ?? `HTTP ${res.status}`)
      }
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }, [load])

  useEffect(() => {
    void load()
  }, [load])

  const currentMonthProfile = useMemo(
    () => overlay?.climate_months.find((m) => m.month_num === selectedMonth) ?? null,
    [overlay, selectedMonth],
  )

  const monthAnomalies = useMemo(() => {
    if (!overlay) return []
    return overlay.anomaly_events.filter(
      (e) => parseInt(e.start_date.slice(5, 7), 10) === selectedMonth,
    )
  }, [overlay, selectedMonth])

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-sage-500 p-6">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading weather…
      </div>
    )
  }

  if (error && !overlay) {
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
        : 'No weather data available for this venue yet.'
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

  return (
    <div className="space-y-8 max-w-6xl">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold text-sage-900">
            Weather Intelligence
          </h1>
          <p className="text-sm text-sage-600 mt-1 max-w-2xl">
            Plan pricing, set couple expectations, and explain why a slow stretch
            was slow. The page combines decade-scale typical conditions, notable
            past weather with operational impact, and the 14-day operational
            forecast in one surface.
          </p>
        </div>
        <button
          onClick={() => void refreshHistory()}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md border border-sage-200 bg-warm-white hover:bg-sage-50 disabled:opacity-50"
        >
          {refreshing ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <RefreshCw className="w-3 h-3" />
          )}
          {overlay.history_available ? 'Refresh history' : 'Pull 20 years of history'}
        </button>
      </header>

      {error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </div>
      ) : null}

      {/* ============================================================ */}
      {/* Section 1 — Monthly climate profile + trend                  */}
      {/* ============================================================ */}
      <section className="bg-surface border border-border rounded-xl shadow-sm p-5">
        <div className="flex items-baseline justify-between gap-3 mb-4 flex-wrap">
          <h2 className="font-heading text-base font-semibold text-sage-900 flex items-center gap-2">
            <Calendar className="w-4 h-4 text-sage-500" />
            Typical conditions by month
          </h2>
          <div className="flex items-center gap-1 flex-wrap">
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
              const label = new Date(2000, m - 1, 1).toLocaleString('en-US', { month: 'short' })
              const active = m === selectedMonth
              return (
                <button
                  key={m}
                  onClick={() => setSelectedMonth(m)}
                  className={`text-xs px-2 py-1 rounded ${
                    active
                      ? 'bg-sage-700 text-white'
                      : 'bg-warm-white text-sage-700 border border-border hover:bg-sage-50'
                  }`}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>

        {!overlay.history_available ? (
          <EmptyState
            icon={Calendar}
            title="History not pulled yet"
            subtitle="Click Pull 20 years of history above to fetch the venue's climate record from the Open-Meteo archive. The page builds a per-month profile with decade-over-decade trend deltas. Takes about a minute."
            action={{
              label: refreshing ? 'Refreshing…' : 'Pull 20 years of history',
              onClick: () => void refreshHistory(),
            }}
          />
        ) : !currentMonthProfile ? (
          <EmptyState
            icon={Calendar}
            text={`No climate data for ${new Date(2000, selectedMonth - 1, 1).toLocaleString('en-US', { month: 'long' })} yet.`}
            variant="dashed"
          />
        ) : (
          <MonthProfilePanel profile={currentMonthProfile} />
        )}
      </section>

      {/* ============================================================ */}
      {/* Section 2 — Anomalies for selected month                     */}
      {/* ============================================================ */}
      {overlay.history_available ? (
        <section className="bg-surface border border-border rounded-xl shadow-sm p-5">
          <h2 className="font-heading text-base font-semibold text-sage-900 mb-1 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-rose-500" />
            Notable past weather in{' '}
            {new Date(2000, selectedMonth - 1, 1).toLocaleString('en-US', { month: 'long' })}
          </h2>
          <p className="text-xs text-sage-500 mb-4">
            What happened, what it meant for your pipeline that month. Use to
            explain anomalies and to project what a similar pattern would mean
            this year.
          </p>
          {monthAnomalies.length === 0 ? (
            <EmptyState
              icon={Sun}
              text={`No notable weather events recorded for ${new Date(2000, selectedMonth - 1, 1).toLocaleString('en-US', { month: 'long' })} in the last 20 years. Steady month.`}
              variant="dashed"
            />
          ) : (
            <ul className="space-y-2">
              {monthAnomalies.map((e) => (
                <AnomalyEventRow key={e.id} event={e} />
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {/* ============================================================ */}
      {/* Section 3 — All notable past weather (recency-sorted)         */}
      {/* ============================================================ */}
      {overlay.history_available && overlay.anomaly_events.length > 0 ? (
        <section className="bg-surface border border-border rounded-xl shadow-sm p-5">
          <h2 className="font-heading text-base font-semibold text-sage-900 mb-3 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-sage-500" />
            All notable weather (most recent first)
          </h2>
          <ul className="space-y-2">
            {overlay.anomaly_events.slice(0, 12).map((e) => (
              <AnomalyEventRow key={e.id} event={e} />
            ))}
          </ul>
          {overlay.anomaly_events.length > 12 ? (
            <p className="text-xs text-sage-500 mt-3">
              {overlay.anomaly_events.length - 12} more events recorded. Switch
              months above to drill in.
            </p>
          ) : null}
        </section>
      ) : null}

      {/* ============================================================ */}
      {/* Section 4 — 14-day forecast (operational, demoted)           */}
      {/* ============================================================ */}
      <section className="bg-surface border border-border rounded-xl shadow-sm p-5">
        <h2 className="font-heading text-base font-semibold text-sage-900 mb-1 flex items-center gap-2">
          <Calendar className="w-4 h-4 text-sage-500" />
          14-day forecast
        </h2>
        <p className="text-xs text-sage-500 mb-4">
          Operational view: which days in the next two weeks need rain plans,
          shuttle changes, or a heads-up call.
        </p>
        {overlay.forecast.length === 0 ? (
          <EmptyState
            icon={Cloud}
            text="No forecast loaded yet. The nightly cron will pull 14 days from Open-Meteo on its next run."
            variant="dashed"
          />
        ) : (
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
        )}

        {riskyTours.length > 0 ? (
          <div className="mt-5">
            <h3 className="text-sm font-medium text-sage-900 mb-2 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-gold-500" />
              {riskyTours.length} upcoming tour{riskyTours.length === 1 ? '' : 's'} on bad-weather days
            </h3>
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
          </div>
        ) : null}
      </section>

      {/* Latest correlation insight, if any */}
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
            reasoning="When tour cancellations or no-shows correlate with bad-weather days at this venue, a deterministic detector emits a structured signal and a Sonnet narrator describes it in coordinator voice. The bar is 1.5x baseline cancellation in a bad-weather bucket with a minimum tour sample."
            source="weather-cancellation.ts"
          />
        </section>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------
// Month profile panel — 24-hour strip + headline trend stats
// ---------------------------------------------------------------------

function MonthProfilePanel({ profile }: { profile: ClimateMonthProfile }) {
  const hours = profile.hours
  const recentTemps = hours.map((h) => h.recent_temp_avg_f).filter((v): v is number => v !== null)
  const minT = Math.min(...recentTemps)
  const maxT = Math.max(...recentTemps)
  const range = Math.max(1, maxT - minT)

  function hourLabel(h: number): string {
    if (h === 0) return '12a'
    if (h < 12) return `${h}a`
    if (h === 12) return '12p'
    return `${h - 12}p`
  }

  return (
    <div className="space-y-4">
      {/* Headline trend chips */}
      <div className="flex flex-wrap items-center gap-2">
        <Headline
          label="Daytime typical"
          value={
            profile.daytime_temp_avg_f !== null
              ? `${Math.round(profile.daytime_temp_avg_f)}°F`
              : '—'
          }
        />
        <Headline
          label="Rain chance"
          value={
            profile.daytime_precip_prob_pct !== null
              ? `${Math.round(profile.daytime_precip_prob_pct)}%`
              : '—'
          }
        />
        <TrendChip
          label="Temp vs prior decade"
          delta={profile.daytime_temp_delta_f}
          unit="°F"
          higherIsWarmer
        />
        <TrendChip
          label="Rain vs prior decade"
          delta={profile.daytime_precip_prob_delta_pct}
          unit=" pts"
        />
      </div>

      {/* 24-hour profile */}
      <div className="overflow-x-auto">
        <div className="min-w-[640px] grid grid-cols-[repeat(24,minmax(0,1fr))] gap-px text-center text-[10px]">
          {hours.map((h) => {
            const t = h.recent_temp_avg_f
            const pct = t === null ? 0 : ((t - minT) / range) * 100
            const heatTone =
              t === null
                ? 'bg-sage-50 text-sage-400'
                : t >= 75
                  ? 'bg-amber-100 text-amber-900'
                  : t >= 60
                    ? 'bg-emerald-100 text-emerald-900'
                    : t >= 40
                      ? 'bg-sky-100 text-sky-900'
                      : 'bg-indigo-100 text-indigo-900'
            return (
              <div
                key={h.hour_local}
                className={`rounded py-1 ${heatTone}`}
                title={`${hourLabel(h.hour_local)}: ${
                  t !== null ? `${Math.round(t)}°F` : 'no data'
                }, ${h.recent_precip_prob_pct !== null ? `${Math.round(h.recent_precip_prob_pct)}% rain` : ''}`}
              >
                <div className="font-medium">{hourLabel(h.hour_local)}</div>
                <div className="font-semibold">
                  {t !== null ? `${Math.round(t)}°` : '—'}
                </div>
                <div className="opacity-70">
                  {h.recent_precip_prob_pct !== null
                    ? `${Math.round(h.recent_precip_prob_pct)}%`
                    : ''}
                </div>
                <div
                  className="mt-0.5 h-0.5 bg-current opacity-30"
                  style={{ width: `${pct}%`, marginInline: 'auto' }}
                />
              </div>
            )
          })}
        </div>
      </div>

      <WhyThisCard
        title="How we compute this"
        reasoning={`Each cell is the average over a 10-year window for this hour at this venue. Hover the cell for typical temperature plus the historical % of days in that hour with rain on the ground. Trend chips compare ${profile.recent_window_start?.slice(0, 4)}-${profile.recent_window_end?.slice(0, 4)} (recent decade) against ${profile.prior_window_start?.slice(0, 4)}-${profile.prior_window_end?.slice(0, 4)} (prior decade) so you can see direction of travel.`}
        source="weather-climate-norms.ts"
      />
    </div>
  )
}

function Headline({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-warm-white px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-sage-500">{label}</div>
      <div className="text-lg font-semibold text-sage-900">{value}</div>
    </div>
  )
}

function TrendChip({
  label,
  delta,
  unit,
  higherIsWarmer = false,
}: {
  label: string
  delta: number | null
  unit: string
  higherIsWarmer?: boolean
}) {
  if (delta === null || Math.abs(delta) < 0.1) {
    return (
      <div className="rounded-lg border border-border bg-warm-white px-3 py-2">
        <div className="text-[10px] uppercase tracking-wide text-sage-500">{label}</div>
        <div className="text-sm font-medium text-sage-700">Flat</div>
      </div>
    )
  }
  const up = delta > 0
  const Icon = up ? TrendingUp : TrendingDown
  const tone = higherIsWarmer
    ? up
      ? 'text-amber-700'
      : 'text-sky-700'
    : up
      ? 'text-indigo-700'
      : 'text-emerald-700'
  const sign = up ? '+' : ''
  return (
    <div className="rounded-lg border border-border bg-warm-white px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-sage-500">{label}</div>
      <div className={`text-sm font-medium ${tone} inline-flex items-center gap-1`}>
        <Icon className="w-3.5 h-3.5" />
        {sign}
        {delta.toFixed(1)}
        {unit}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// Anomaly event row
// ---------------------------------------------------------------------

function AnomalyEventRow({ event }: { event: AnomalyEvent }) {
  const Icon = EVENT_ICONS[event.event_type] ?? Cloud
  const tone = EVENT_TONE[event.event_type] ?? 'bg-warm-white border-border text-sage-700'
  const inq = impactLabel(event.inquiries_during, event.inquiries_typical)
  const tours = impactLabel(event.tours_during, event.tours_typical)

  return (
    <li className={`rounded-lg border px-3 py-3 ${tone}`}>
      <div className="flex items-start gap-3">
        <Icon className="w-4 h-4 flex-shrink-0 mt-0.5 opacity-80" />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2 flex-wrap">
            <p className="text-sm font-medium">{event.description}</p>
            <span className="text-xs uppercase tracking-wide opacity-70">
              {event.severity}
            </span>
          </div>
          <p className="text-xs opacity-80 mt-0.5">
            {event.start_date === event.end_date
              ? monthYearLabel(event.start_date)
              : `${monthYearLabel(event.start_date)}`}{' '}
            · {event.duration_days} day{event.duration_days === 1 ? '' : 's'}
          </p>
          {(inq || tours) && (
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1 text-xs">
              {inq && (
                <div>
                  <span className="opacity-70">Inquiries during: </span>
                  <span className={`font-medium ${inq.tone}`}>{inq.label}</span>
                </div>
              )}
              {tours && (
                <div>
                  <span className="opacity-70">Tours during: </span>
                  <span className={`font-medium ${tours.tone}`}>{tours.label}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  )
}
