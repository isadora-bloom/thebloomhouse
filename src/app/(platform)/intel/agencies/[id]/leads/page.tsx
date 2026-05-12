'use client'

/**
 * /intel/agencies/[id]/leads — Wave 6E drill-down.
 *
 * The "show me the 17 leads this agency drove" view. Reached from the
 * agency detail page's clickable ROI counts. Each row is the venue's
 * wedding row + the channel the agency-managed first-touch landed on.
 */

import { useEffect, useState, use as usePromise } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  ArrowLeft,
  Loader2,
  Briefcase,
  Calendar,
  Phone,
  ExternalLink,
} from 'lucide-react'

interface LeadRow {
  id: string
  status: string | null
  estimatedValueCents: number | null
  inquiryDate: string | null
  bookedAt: string | null
  partner1Name: string | null
  partner2Name: string | null
  weddingDate: string | null
  attributedChannel: string | null
  firstTouchAt: string | null
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function formatDollars(cents: number | null): string {
  if (cents === null || !Number.isFinite(cents)) return '—'
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`
}

function statusLabel(status: string | null): string {
  if (!status) return '—'
  return status.replace(/_/g, ' ')
}

export default function AgencyLeadsPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id: agencyId } = usePromise(params)
  const searchParams = useSearchParams()
  const statusFilter = searchParams.get('status')

  const [leads, setLeads] = useState<LeadRow[]>([])
  const [agencyName, setAgencyName] = useState<string>('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const params = new URLSearchParams()
        params.set('window', '365')
        if (statusFilter) params.set('status', statusFilter)
        const [leadsResp, agencyResp] = await Promise.all([
          fetch(`/api/intel/agencies/${agencyId}/leads?${params.toString()}`),
          fetch(`/api/intel/agencies/${agencyId}`),
        ])
        if (leadsResp.ok) {
          const j = (await leadsResp.json()) as { leads: LeadRow[] }
          if (!cancelled) setLeads(j.leads ?? [])
        }
        if (agencyResp.ok) {
          const j = (await agencyResp.json()) as { agency: { name: string } }
          if (!cancelled) setAgencyName(j.agency.name)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [agencyId, statusFilter])

  const totalRevenue = leads.reduce((s, l) => s + (l.estimatedValueCents ?? 0), 0)
  const bookedCount = leads.filter(
    (l) => l.status === 'booked' || l.status === 'completed',
  ).length

  return (
    <div className="space-y-6 p-6">
      <div>
        <Link
          href={`/intel/agencies/${agencyId}`}
          className="inline-flex items-center gap-1 text-sm text-[var(--bh-muted)] hover:text-[var(--bh-ink)]"
        >
          <ArrowLeft className="h-3 w-3" /> Back to {agencyName || 'agency'}
        </Link>
        <h1 className="mt-2 font-serif text-2xl text-[var(--bh-ink)]">
          Leads attributed to {agencyName || 'this agency'}
        </h1>
        <p className="mt-1 text-sm text-[var(--bh-muted)]">
          Weddings whose first-touch attribution landed on a channel this
          agency manages, last 365 days
          {statusFilter ? `, filtered to status: ${statusLabel(statusFilter)}` : null}.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Leads in window" value={leads.length} />
        <Stat label="Booked" value={bookedCount} />
        <Stat
          label="Pipeline revenue"
          value={formatDollars(totalRevenue)}
        />
        <Stat label="Filter" value={statusFilter || 'all statuses'} />
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--bh-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : leads.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[var(--bh-line)] bg-white p-10 text-center text-sm text-[var(--bh-muted)]">
          No leads attributed to this agency in the last 365 days.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-[var(--bh-line)] bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--bh-line)] text-left text-xs uppercase tracking-wide text-[var(--bh-muted)]">
                <th className="py-3 px-4">Couple</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Channel</th>
                <th className="py-3 px-4">First touch</th>
                <th className="py-3 px-4">Inquiry</th>
                <th className="py-3 px-4">Wedding date</th>
                <th className="py-3 px-4 text-right">Value</th>
                <th className="py-3 px-4">Action</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr
                  key={l.id}
                  className="border-b border-[var(--bh-line)]/60 hover:bg-[var(--bh-sage-50)]/30"
                >
                  <td className="py-3 px-4">
                    <div className="font-medium">
                      {[l.partner1Name, l.partner2Name].filter(Boolean).join(' & ') ||
                        '(no name)'}
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <span className="rounded-full bg-[var(--bh-warm-50)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--bh-muted)]">
                      {statusLabel(l.status)}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <span className="inline-flex items-center gap-1 text-xs">
                      <Briefcase className="h-3 w-3" />
                      {l.attributedChannel}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-xs tabular-nums text-[var(--bh-muted)]">
                    {fmtDate(l.firstTouchAt)}
                  </td>
                  <td className="py-3 px-4 text-xs tabular-nums text-[var(--bh-muted)]">
                    {fmtDate(l.inquiryDate)}
                  </td>
                  <td className="py-3 px-4 text-xs tabular-nums text-[var(--bh-muted)]">
                    <span className="inline-flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {fmtDate(l.weddingDate)}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right tabular-nums">
                    {formatDollars(l.estimatedValueCents)}
                  </td>
                  <td className="py-3 px-4">
                    <Link
                      href={`/intel/clients/${l.id}`}
                      className="inline-flex items-center gap-1 text-xs text-[var(--bh-sage-700)] hover:underline"
                    >
                      Open <ExternalLink className="h-3 w-3" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-[var(--bh-line)] bg-white p-3">
      <div className="text-[10px] uppercase tracking-wide text-[var(--bh-muted)]">
        {label}
      </div>
      <div className="mt-1 font-serif text-xl tabular-nums">{value}</div>
    </div>
  )
}
