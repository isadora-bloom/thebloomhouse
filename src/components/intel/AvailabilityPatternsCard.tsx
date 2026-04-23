'use client'

import { useEffect, useMemo, useState } from 'react'
import { CalendarRange, Sparkles } from 'lucide-react'
import { VenueChip } from '@/components/intel/venue-chip'
import { useScope } from '@/lib/hooks/use-scope'

// ---------------------------------------------------------------------------
// Types (mirror the API response shape)
// ---------------------------------------------------------------------------

interface MonthlyFillRate {
  month: string
  totalSlots: number
  booked: number
  fillRatePct: number
}

interface AvailabilityPatternsRow {
  venueId: string
  venueName: string
  next12Months: MonthlyFillRate[]
  saturdaysNext12Months: MonthlyFillRate[]
  topInsight: string | null
}

interface AvailabilityPatternsApiResponse {
  rows: AvailabilityPatternsRow[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMonthLabel(month: string): string {
  const [year, m] = month.split('-').map(Number)
  if (!year || !m) return month
  return new Date(year, m - 1, 1).toLocaleString('en-US', { month: 'short' })
}

// ---------------------------------------------------------------------------
// Per-venue 12-month chart
// ---------------------------------------------------------------------------

function MonthlyFillChart({
  allDays,
  saturdays,
}: {
  allDays: MonthlyFillRate[]
  saturdays: MonthlyFillRate[]
}) {
  // Build a unified set of months (union of both arrays) sorted by key.
  const months = useMemo(() => {
    const keys = new Set<string>()
    for (const r of allDays) keys.add(r.month)
    for (const r of saturdays) keys.add(r.month)
    return Array.from(keys).sort()
  }, [allDays, saturdays])

  const allByMonth = useMemo(() => {
    const m = new Map<string, MonthlyFillRate>()
    for (const r of allDays) m.set(r.month, r)
    return m
  }, [allDays])

  const satByMonth = useMemo(() => {
    const m = new Map<string, MonthlyFillRate>()
    for (const r of saturdays) m.set(r.month, r)
    return m
  }, [saturdays])

  if (months.length === 0) {
    return (
      <p className="text-sm text-sage-500 italic">
        No availability data yet. Coordinators manage dates in Settings &gt; Availability.
      </p>
    )
  }

  return (
    <div>
      <div className="flex items-end gap-1.5 h-32">
        {months.map((month) => {
          const all = allByMonth.get(month)
          const sat = satByMonth.get(month)
          const allPct = all?.fillRatePct ?? 0
          const satPct = sat?.fillRatePct ?? 0
          const hasData = (all?.totalSlots ?? 0) > 0 || (sat?.totalSlots ?? 0) > 0

          return (
            <div key={month} className="flex-1 flex flex-col items-center gap-1">
              <div className="relative w-full h-full flex items-end">
                {/* All-days bar (background) */}
                <div
                  className="w-full rounded-t bg-sage-200"
                  style={{ height: `${Math.max(allPct, hasData ? 2 : 0)}%` }}
                  title={`${formatMonthLabel(month)}: ${Math.round(allPct)}% filled (all days)`}
                />
                {/* Saturday overlay bar */}
                {sat && sat.totalSlots > 0 && (
                  <div
                    className="absolute bottom-0 left-1/2 -translate-x-1/2 w-2/3 rounded-t bg-sage-500"
                    style={{ height: `${Math.max(satPct, 2)}%` }}
                    title={`${formatMonthLabel(month)} Saturdays: ${Math.round(satPct)}% filled`}
                  />
                )}
              </div>
              <span className="text-[10px] text-sage-500">
                {formatMonthLabel(month)}
              </span>
            </div>
          )
        })}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 mt-3 text-[11px] text-sage-600">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-sage-200" />
          All days
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-sage-500" />
          Saturdays
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Per-venue block (one section when multi-venue)
// ---------------------------------------------------------------------------

function VenuePatternBlock({
  row,
  showChip,
}: {
  row: AvailabilityPatternsRow
  showChip: boolean
}) {
  const hasAnyData =
    (row.next12Months ?? []).some((m) => m.totalSlots > 0) ||
    (row.saturdaysNext12Months ?? []).some((m) => m.totalSlots > 0)

  return (
    <div className="space-y-3">
      {showChip && (
        <div>
          <VenueChip venueName={row.venueName} size="sm" />
        </div>
      )}

      {row.topInsight && (
        <div className="rounded-lg border border-sage-200 bg-sage-50 p-3 flex items-start gap-2">
          <Sparkles className="w-4 h-4 text-sage-600 shrink-0 mt-0.5" />
          <p className="text-sm text-sage-800 leading-relaxed">{row.topInsight}</p>
        </div>
      )}

      {hasAnyData ? (
        <MonthlyFillChart
          allDays={row.next12Months ?? []}
          saturdays={row.saturdaysNext12Months ?? []}
        />
      ) : (
        <p className="text-sm text-sage-500 italic">
          No availability data yet. Coordinators manage dates in Settings &gt; Availability.
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main card
// ---------------------------------------------------------------------------

export function AvailabilityPatternsCard() {
  const scope = useScope()
  const [rows, setRows] = useState<AvailabilityPatternsRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (scope.loading) return

    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams()
        if (scope.level === 'group' && scope.groupId) {
          params.set('group_id', scope.groupId)
        } else if (scope.level === 'company' && scope.orgId) {
          params.set('org_id', scope.orgId)
        } else if (scope.venueId) {
          params.set('venue_id', scope.venueId)
        }

        const qs = params.toString()
        const url = `/api/intel/availability-patterns${qs ? `?${qs}` : ''}`
        const res = await fetch(url)
        if (!res.ok) {
          // Plan-gated or auth — stay silent rather than shout at the user.
          if (res.status === 401 || res.status === 402 || res.status === 403) {
            if (!cancelled) {
              setRows([])
              setLoading(false)
            }
            return
          }
          throw new Error(`Request failed: ${res.status}`)
        }
        const json = (await res.json()) as AvailabilityPatternsApiResponse
        if (cancelled) return
        setRows(json.rows ?? [])
      } catch (err) {
        console.error('[AvailabilityPatternsCard] load error:', err)
        if (!cancelled) setError('Failed to load availability patterns')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [scope.loading, scope.level, scope.venueId, scope.groupId, scope.orgId])

  const isMultiVenue = scope.level !== 'venue'
  const hasData =
    rows.length > 0 &&
    rows.some(
      (r) =>
        (r.next12Months ?? []).some((m) => m.totalSlots > 0) ||
        (r.saturdaysNext12Months ?? []).some((m) => m.totalSlots > 0)
    )

  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        <CalendarRange className="w-5 h-5 text-sage-600" />
        <h2 className="font-heading text-lg font-semibold text-sage-900">
          Availability Patterns
        </h2>
      </div>

      {loading ? (
        <div className="h-32 bg-sage-50 rounded animate-pulse" />
      ) : error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : rows.length === 0 || !hasData ? (
        <p className="text-sm text-sage-500 italic">
          No availability data yet. Coordinators manage dates in Settings &gt; Availability.
        </p>
      ) : (
        <div className="space-y-6">
          {rows.map((row) => (
            <VenuePatternBlock
              key={row.venueId}
              row={row}
              showChip={isMultiVenue}
            />
          ))}
        </div>
      )}
    </div>
  )
}
