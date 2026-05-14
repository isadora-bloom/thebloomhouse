'use client'

/**
 * /intel/agencies — Wave 6E. Marketing-agency tracker list.
 *
 * Lists every agency in the venue's scope with a quick ROI snapshot
 * (90-day window). Click-through to per-agency detail. Create new
 * agency via the "+ New agency" button.
 *
 * The big-picture goal: answer "is Hawthorn paying off?" at a glance.
 * The TBH Report PDF generator (separate module) reads the same data.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Plus,
  Loader2,
  Briefcase,
  ExternalLink,
  AlertTriangle,
} from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'

interface AgencyListRow {
  id: string
  orgId: string | null
  venueId: string | null
  name: string
  website: string | null
  contactName: string | null
  contactEmail: string | null
  contactPhone: string | null
  defaultMonthlyRetainerCents: number | null
  performanceFeePct: number | null
  services: string[]
  notes: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

interface ROIRow {
  agencyId: string
  agencyName: string
  totalSpendCents: number
  firstTouchLeads: number
  firstTouchTours: number
  firstTouchBookings: number
  bookedRevenueCents: number
  costPerBookingCents: number | null
  costPerLeadCents: number | null
}

function formatDollars(cents: number | null): string {
  if (cents === null || !Number.isFinite(cents)) return '—'
  const dollars = cents / 100
  if (dollars >= 1000) {
    return `$${(dollars / 1000).toFixed(1)}k`
  }
  return `$${dollars.toFixed(0)}`
}

export default function AgenciesListPage() {
  const [agencies, setAgencies] = useState<AgencyListRow[]>([])
  const [roiByAgency, setRoiByAgency] = useState<Map<string, ROIRow>>(new Map())
  const [loading, setLoading] = useState(true)
  const [roiLoading, setRoiLoading] = useState(false)

  const loadAgencies = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await fetch('/api/intel/agencies')
      if (!resp.ok) {
        setAgencies([])
        return
      }
      const j = (await resp.json()) as { agencies: AgencyListRow[] }
      setAgencies(j.agencies ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  const loadRois = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return
    setRoiLoading(true)
    try {
      const responses = await Promise.all(
        ids.map((id) =>
          fetch(`/api/intel/agencies/${id}/roi?window=90`)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null),
        ),
      )
      const map = new Map<string, ROIRow>()
      responses.forEach((r, i) => {
        if (r?.summary) {
          map.set(ids[i], r.summary as ROIRow)
        }
      })
      setRoiByAgency(map)
    } finally {
      setRoiLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadAgencies()
  }, [loadAgencies])

  useEffect(() => {
    if (agencies.length > 0) {
      void loadRois(agencies.map((a) => a.id))
    }
  }, [agencies, loadRois])

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-serif text-2xl text-[var(--bh-ink)]">
            Marketing agencies
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--bh-muted)]">
            Track the firms managing your marketing spend. Bloom answers
            the question their reports cannot: did this agency drive
            actual bookings, and at what real cost per booking.
          </p>
        </div>
        <Link
          href="/intel/agencies/new"
          className="inline-flex items-center gap-2 rounded-md bg-[var(--bh-sage-700)] px-4 py-2 text-sm text-white hover:opacity-90"
        >
          <Plus className="h-4 w-4" /> New agency
        </Link>
      </div>

      {/* Honesty banner */}
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div>
            <p className="font-medium">Attribution coverage matters.</p>
            <p className="mt-1 text-amber-800">
              These numbers reflect first-touch attribution Bloom can see
              today. Cross-device journeys, organic-Instagram discovery,
              and brand-vs-non-brand search splits need the pixel and
              optional Google Ads OAuth (coming soon). Until those land,
              treat agency-attributed leads as a lower bound, not the
              full picture.
            </p>
          </div>
        </div>
      </div>

      {/* List */}
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--bh-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading agencies…
        </div>
      ) : agencies.length === 0 ? (
        <EmptyState
          icon={Briefcase}
          title="No agencies tracked yet"
          subtitle="Add the firm or firms managing your marketing spend (Hawthorn, Elite Wedding Marketing, etc.) so Bloom can compare their attribution to what they actually deliver."
          action={{ label: 'Add your first agency', href: '/intel/agencies/new' }}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {agencies.map((a) => (
            <AgencyCard
              key={a.id}
              agency={a}
              roi={roiByAgency.get(a.id) ?? null}
              roiLoading={roiLoading && !roiByAgency.has(a.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function AgencyCard({
  agency,
  roi,
  roiLoading,
}: {
  agency: AgencyListRow
  roi: ROIRow | null
  roiLoading: boolean
}) {
  return (
    <Link
      href={`/intel/agencies/${agency.id}`}
      className="group block rounded-2xl border border-[var(--bh-line)] bg-white p-5 shadow-sm transition hover:border-[var(--bh-sage-500)] hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-serif text-lg leading-tight">{agency.name}</h3>
          {agency.website ? (
            <div className="mt-0.5 flex items-center gap-1 text-xs text-[var(--bh-muted)]">
              <span className="truncate">{agency.website}</span>
              <ExternalLink className="h-3 w-3 flex-shrink-0" />
            </div>
          ) : null}
        </div>
        {agency.orgId ? (
          <span className="rounded-full bg-[var(--bh-sage-50)] px-2 py-0.5 text-xs text-[var(--bh-sage-700)]">
            org-wide
          </span>
        ) : null}
      </div>

      {agency.services.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1">
          {agency.services.slice(0, 5).map((s) => (
            <span
              key={s}
              className="rounded-full bg-[var(--bh-warm-50)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--bh-muted)]"
            >
              {s.replace(/_/g, ' ')}
            </span>
          ))}
        </div>
      ) : null}

      <div className="mt-4 grid grid-cols-3 gap-3 border-t border-[var(--bh-line)] pt-4 text-sm">
        <Stat
          label="90-day spend"
          value={roi ? formatDollars(roi.totalSpendCents) : roiLoading ? '…' : '—'}
        />
        <Stat
          label="First-touch bookings"
          value={roi ? String(roi.firstTouchBookings) : roiLoading ? '…' : '—'}
        />
        <Stat
          label="CAC"
          value={
            roi
              ? formatDollars(roi.costPerBookingCents)
              : roiLoading
                ? '…'
                : '—'
          }
        />
      </div>

      {roi && roi.firstTouchLeads > 0 ? (
        <p className="mt-3 text-xs text-[var(--bh-muted)]">
          {roi.firstTouchLeads} first-touch leads · {roi.firstTouchTours}{' '}
          tours · {formatDollars(roi.bookedRevenueCents)} booked revenue
        </p>
      ) : null}
    </Link>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-[var(--bh-muted)]">
        {label}
      </div>
      <div className="mt-0.5 font-semibold tabular-nums">{value}</div>
    </div>
  )
}
