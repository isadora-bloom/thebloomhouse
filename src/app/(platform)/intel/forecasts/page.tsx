'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import {
  TrendingUp,
  DollarSign,
  CalendarCheck,
  ArrowRight,
} from 'lucide-react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts'

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

interface WeddingRow {
  id: string
  status: string
  booking_value: number | null
  event_date: string | null
  created_at: string
}

interface QuarterForecast {
  label: string
  contracted: number
  held: number
  pipeline: number
  total: number
}

// Pipeline weights
const WEIGHTS: Record<string, number> = {
  contracted: 1.0,
  completed: 1.0,
  held: 0.7,
  toured: 0.55,
  inquiry: 0.3,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt$(v: number): string {
  return `$${Math.round(v).toLocaleString()}`
}

function getQuarterLabel(year: number, q: number): string {
  return `Q${q} ${year}`
}

function getQuarterRange(year: number, q: number): { start: string; end: string } {
  const startMonth = (q - 1) * 3
  const start = new Date(year, startMonth, 1)
  const end = new Date(year, startMonth + 3, 0)
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  }
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function ForecastCardSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
      <div className="animate-pulse space-y-3">
        <div className="h-4 w-16 bg-sage-100 rounded" />
        <div className="h-7 w-24 bg-sage-100 rounded" />
        <div className="space-y-2">
          <div className="h-3 w-32 bg-sage-50 rounded" />
          <div className="h-3 w-28 bg-sage-50 rounded" />
          <div className="h-3 w-24 bg-sage-50 rounded" />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default function ForecastsPage() {
  const [weddings, setWeddings] = useState<WeddingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    const supabase = getSupabase()
    try {
      const { data, error: err } = await supabase
        .from('weddings')
        .select('id, status, booking_value, event_date, created_at')
      if (err) throw err
      setWeddings((data ?? []) as WeddingRow[])
      setError(null)
    } catch (err) {
      console.error('Failed to fetch forecast data:', err)
      setError('Failed to load forecast data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Build 8-quarter forecast (current + next 7)
  const forecasts: QuarterForecast[] = useMemo(() => {
    const now = new Date()
    const currentQ = Math.ceil((now.getMonth() + 1) / 3)
    const currentYear = now.getFullYear()

    const quarters: QuarterForecast[] = []

    for (let i = 0; i < 8; i++) {
      const q = ((currentQ - 1 + i) % 4) + 1
      const y = currentYear + Math.floor((currentQ - 1 + i) / 4)
      const label = getQuarterLabel(y, q)
      const { start, end } = getQuarterRange(y, q)

      const qWeddings = weddings.filter((w) => {
        const d = w.event_date ?? w.created_at
        return d >= start && d <= end
      })

      let contracted = 0
      let held = 0
      let pipeline = 0

      for (const w of qWeddings) {
        const val = w.booking_value ?? 0
        const weight = WEIGHTS[w.status] ?? 0.3
        if (['contracted', 'completed'].includes(w.status)) {
          contracted += val
        } else if (w.status === 'held') {
          held += val * weight
        } else {
          pipeline += val * weight
        }
      }

      quarters.push({
        label,
        contracted,
        held,
        pipeline,
        total: contracted + held + pipeline,
      })
    }

    return quarters
  }, [weddings])

  // Total forecast
  const totalForecast = forecasts.reduce((s, f) => s + f.total, 0)
  const totalContracted = forecasts.reduce((s, f) => s + f.contracted, 0)

  // Confidence: ratio of contracted to total
  const confidence =
    totalForecast > 0 ? Math.round((totalContracted / totalForecast) * 100) : 0

  // YoY comparison
  const thisYearRevenue = weddings
    .filter((w) => {
      const d = w.event_date ?? w.created_at
      return d.startsWith(String(new Date().getFullYear())) && ['contracted', 'completed'].includes(w.status)
    })
    .reduce((s, w) => s + (w.booking_value ?? 0), 0)

  const lastYearRevenue = weddings
    .filter((w) => {
      const d = w.event_date ?? w.created_at
      return d.startsWith(String(new Date().getFullYear() - 1)) && ['contracted', 'completed'].includes(w.status)
    })
    .reduce((s, w) => s + (w.booking_value ?? 0), 0)

  const yoyChange = lastYearRevenue > 0 ? ((thisYearRevenue - lastYearRevenue) / lastYearRevenue) * 100 : 0

  // Chart data
  const chartData = forecasts.map((f) => ({
    name: f.label,
    contracted: Math.round(f.contracted),
    held: Math.round(f.held),
    pipeline: Math.round(f.pipeline),
  }))

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
          Revenue Forecasts
        </h1>
        <p className="text-sage-600">
          Projected revenue by quarter with pipeline weighting.
        </p>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <TrendingUp className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Summary row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => <ForecastCardSkeleton key={i} />)
        ) : (
          <>
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <DollarSign className="w-4 h-4 text-sage-500" />
                <span className="text-sm font-medium text-sage-600">Total 8-Quarter Forecast</span>
              </div>
              <p className="text-2xl font-bold text-sage-900">{fmt$(totalForecast)}</p>
              <p className="text-xs text-sage-500 mt-1">Confidence: {confidence}%</p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <CalendarCheck className="w-4 h-4 text-emerald-500" />
                <span className="text-sm font-medium text-sage-600">Contracted Revenue</span>
              </div>
              <p className="text-2xl font-bold text-emerald-700">{fmt$(totalContracted)}</p>
              <p className="text-xs text-sage-500 mt-1">100% weighted</p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <TrendingUp className="w-4 h-4 text-teal-500" />
                <span className="text-sm font-medium text-sage-600">YoY Change</span>
              </div>
              <p className={`text-2xl font-bold ${yoyChange >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                {yoyChange >= 0 ? '+' : ''}{yoyChange.toFixed(1)}%
              </p>
              <p className="text-xs text-sage-500 mt-1">
                {fmt$(thisYearRevenue)} vs {fmt$(lastYearRevenue)} last year
              </p>
            </div>
          </>
        )}
      </div>

      {/* Pipeline weights legend */}
      <div className="bg-warm-white border border-sage-100 rounded-xl p-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-2">Pipeline Weights</p>
        <div className="flex flex-wrap gap-4 text-xs text-sage-600">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500" /> Contracted = 100%</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" /> Held = 70%</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-teal-500" /> Toured = 55%</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-sage-400" /> Inquiry = 30%</span>
        </div>
      </div>

      {/* Quarter forecast cards */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => <ForecastCardSkeleton key={i} />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {forecasts.map((f) => (
            <div key={f.label} className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <h3 className="font-heading text-sm font-semibold text-sage-900 mb-3">{f.label}</h3>
              <p className="text-xl font-bold text-sage-900 mb-3 tabular-nums">{fmt$(f.total)}</p>
              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-500" /> Contracted
                  </span>
                  <span className="font-medium text-sage-800 tabular-nums">{fmt$(f.contracted)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-amber-500" /> Held
                  </span>
                  <span className="font-medium text-sage-800 tabular-nums">{fmt$(f.held)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-sage-400" /> Pipeline
                  </span>
                  <span className="font-medium text-sage-800 tabular-nums">{fmt$(f.pipeline)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Stacked bar chart */}
      {!loading && (
        <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
          <h2 className="font-heading text-lg font-semibold text-sage-900 mb-4">
            Forecast Overview
          </h2>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E8E4DF" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#6A7060' }} tickLine={false} axisLine={false} />
                <YAxis
                  tick={{ fontSize: 11, fill: '#6A7060' }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                />
                <Tooltip
                  formatter={(v) => { const n = Number(v) || 0; return [fmt$(n)]; }}
                  contentStyle={{ backgroundColor: '#FFF', border: '1px solid #E8E4DF', borderRadius: '8px', fontSize: '13px' }}
                />
                <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '8px' }} />
                <Bar dataKey="contracted" name="Contracted" stackId="a" fill="#10B981" radius={[0, 0, 0, 0]} />
                <Bar dataKey="held" name="Held" stackId="a" fill="#F59E0B" radius={[0, 0, 0, 0]} />
                <Bar dataKey="pipeline" name="Pipeline" stackId="a" fill="#9CA3AF" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  )
}
