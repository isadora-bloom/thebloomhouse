'use client'

/**
 * /intel/agencies/[id] — Agency detail + ROI + engagement management.
 *
 * Shows the agency profile, the 90-day ROI summary, and the venue's
 * engagement with the agency (monthly fee + which channels the
 * agency manages). The engagement panel is the most important piece:
 * tying the agency to specific marketing_channels keys is what
 * lets the ROI compute roll up first-touch attribution.
 */

import { useCallback, useEffect, useState, use as usePromise } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Loader2,
  ArrowLeft,
  Pencil,
  Trash2,
  Briefcase,
  ExternalLink,
  Plus,
  Calendar,
  X,
  AlertTriangle,
  Check,
} from 'lucide-react'

interface AgencyRow {
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
}

interface EngagementRow {
  id: string
  venueId: string
  agencyId: string
  startedAt: string
  endedAt: string | null
  monthlyFeeCents: number
  managedChannels: string[]
  scopeDescription: string | null
  notes: string | null
}

interface ROIRow {
  agencyId: string
  agencyName: string
  windowDays: number
  spendCents: number
  retainerSpendCents: number
  totalSpendCents: number
  firstTouchLeads: number
  firstTouchTours: number
  firstTouchBookings: number
  bookedRevenueCents: number
  costPerBookingCents: number | null
  costPerLeadCents: number | null
}

interface ChannelRow {
  id: string
  key: string
  label: string
}

function formatDollars(cents: number | null): string {
  if (cents === null || !Number.isFinite(cents)) return '—'
  const dollars = cents / 100
  return `$${dollars.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export default function AgencyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id: agencyId } = usePromise(params)
  const router = useRouter()

  const [agency, setAgency] = useState<AgencyRow | null>(null)
  const [engagements, setEngagements] = useState<EngagementRow[]>([])
  const [roi, setRoi] = useState<ROIRow | null>(null)
  const [channels, setChannels] = useState<ChannelRow[]>([])
  const [loading, setLoading] = useState(true)
  const [showEngagementForm, setShowEngagementForm] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [agencyResp, roiResp, channelsResp] = await Promise.all([
        fetch(`/api/intel/agencies/${agencyId}`),
        fetch(`/api/intel/agencies/${agencyId}/roi?window=90`),
        fetch('/api/portal/marketing-channels'),
      ])

      if (agencyResp.ok) {
        const j = (await agencyResp.json()) as {
          agency: AgencyRow
          engagements: EngagementRow[]
        }
        setAgency(j.agency)
        setEngagements(j.engagements ?? [])
      }
      if (roiResp.ok) {
        const j = (await roiResp.json()) as { summary: ROIRow | null }
        setRoi(j.summary)
      }
      if (channelsResp.ok) {
        const j = (await channelsResp.json()) as {
          channels?: ChannelRow[]
          rows?: ChannelRow[]
        }
        setChannels(j.channels ?? j.rows ?? [])
      }
    } finally {
      setLoading(false)
    }
  }, [agencyId])

  useEffect(() => {
    void reload()
  }, [reload])

  const handleDelete = useCallback(async () => {
    const resp = await fetch(`/api/intel/agencies/${agencyId}`, {
      method: 'DELETE',
    })
    if (resp.ok) {
      router.push('/intel/agencies')
    }
  }, [agencyId, router])

  if (loading && !agency) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-[var(--bh-muted)]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
      </div>
    )
  }
  if (!agency) {
    return (
      <div className="p-6 text-sm text-[var(--bh-muted)]">Agency not found.</div>
    )
  }

  const activeEngagement = engagements.find((e) => e.endedAt === null)

  return (
    <div className="space-y-6 p-6">
      <div>
        <Link
          href="/intel/agencies"
          className="inline-flex items-center gap-1 text-sm text-[var(--bh-muted)] hover:text-[var(--bh-ink)]"
        >
          <ArrowLeft className="h-3 w-3" /> Back to agencies
        </Link>
      </div>

      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-serif text-2xl text-[var(--bh-ink)]">
            {agency.name}
          </h1>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--bh-muted)]">
            {agency.website ? (
              <a
                href={agency.website}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 hover:text-[var(--bh-ink)]"
              >
                {agency.website}
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : null}
            {agency.contactName ? <span>{agency.contactName}</span> : null}
            {agency.contactEmail ? <span>{agency.contactEmail}</span> : null}
            {agency.contactPhone ? <span>{agency.contactPhone}</span> : null}
          </div>
          {agency.services.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1">
              {agency.services.map((s) => (
                <span
                  key={s}
                  className="rounded-full bg-[var(--bh-warm-50)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--bh-muted)]"
                >
                  {s.replace(/_/g, ' ')}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/intel/agencies/${agencyId}/edit`}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--bh-line)] bg-white px-3 py-1.5 text-sm hover:bg-[var(--bh-sage-50)]"
          >
            <Pencil className="h-3 w-3" /> Edit
          </Link>
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-white px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50"
          >
            <Trash2 className="h-3 w-3" /> Delete
          </button>
        </div>
      </header>

      {confirmDelete ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
          <div className="font-medium">Delete this agency?</div>
          <p className="mt-1 text-rose-800">
            Soft-delete preserves historical engagement + spend data;
            you can recover by writing a new agency with the same name
            (history is not auto-linked).
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={handleDelete}
              className="rounded-md bg-rose-700 px-3 py-1.5 text-sm text-white hover:opacity-90"
            >
              Yes, delete
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="rounded-md border border-rose-300 bg-white px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-100"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {/* 90-day ROI */}
      <section className="rounded-2xl border border-[var(--bh-line)] bg-white p-5 shadow-sm">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-serif text-lg">90-day ROI</h2>
          <span className="text-xs text-[var(--bh-muted)]">
            Based on first-touch attribution to managed channels
          </span>
        </div>
        {!roi || roi.firstTouchLeads === 0 ? (
          <NoROIBanner activeEngagement={!!activeEngagement} />
        ) : null}
        <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-6">
          <BigStat label="Total spend" value={roi ? formatDollars(roi.totalSpendCents) : '—'} />
          <BigStat
            label="Direct spend"
            value={roi ? formatDollars(roi.spendCents) : '—'}
            sub="from spend rows"
          />
          <BigStat
            label="Retainer"
            value={roi ? formatDollars(roi.retainerSpendCents) : '—'}
            sub="accrued in window"
          />
          <BigStat
            label="First-touch leads"
            value={roi ? String(roi.firstTouchLeads) : '—'}
          />
          <BigStat
            label="Bookings"
            value={roi ? String(roi.firstTouchBookings) : '—'}
            sub={
              roi && roi.firstTouchTours > 0
                ? `${roi.firstTouchTours} tours`
                : undefined
            }
          />
          <BigStat
            label="True CAC"
            value={roi ? formatDollars(roi.costPerBookingCents) : '—'}
            sub={
              roi && roi.costPerLeadCents !== null
                ? `${formatDollars(roi.costPerLeadCents)} / lead`
                : undefined
            }
            highlight
          />
        </div>
        {roi && roi.bookedRevenueCents > 0 ? (
          <p className="mt-4 text-sm text-[var(--bh-muted)]">
            Booked revenue attributed:{' '}
            <span className="font-semibold text-[var(--bh-ink)] tabular-nums">
              {formatDollars(roi.bookedRevenueCents)}
            </span>
            {roi.totalSpendCents > 0 ? (
              <>
                {' '}
                · ROAS{' '}
                <span className="font-semibold text-[var(--bh-ink)] tabular-nums">
                  {(roi.bookedRevenueCents / roi.totalSpendCents).toFixed(1)}×
                </span>
              </>
            ) : null}
          </p>
        ) : null}
      </section>

      {/* Engagement panel */}
      <section className="rounded-2xl border border-[var(--bh-line)] bg-white p-5 shadow-sm">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-serif text-lg flex items-center gap-2">
            <Briefcase className="h-4 w-4" /> Engagement
          </h2>
          <button
            type="button"
            onClick={() => setShowEngagementForm((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--bh-line)] bg-white px-3 py-1 text-xs hover:bg-[var(--bh-sage-50)]"
          >
            {showEngagementForm ? (
              <>
                <X className="h-3 w-3" /> Hide form
              </>
            ) : (
              <>
                <Plus className="h-3 w-3" />{' '}
                {activeEngagement ? 'Update engagement' : 'Add engagement'}
              </>
            )}
          </button>
        </div>

        {showEngagementForm ? (
          <EngagementForm
            agencyId={agencyId}
            channels={channels}
            existing={activeEngagement ?? null}
            onSaved={async () => {
              setShowEngagementForm(false)
              await reload()
            }}
          />
        ) : null}

        {engagements.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--bh-muted)]">
            No engagement on file. Add one to wire monthly fee + managed
            channels so ROI rollups work.
          </p>
        ) : (
          <div className="mt-3 space-y-3">
            {engagements.map((e) => (
              <EngagementRowView key={e.id} engagement={e} channels={channels} />
            ))}
          </div>
        )}
      </section>

      {/* Notes */}
      {agency.notes ? (
        <section className="rounded-2xl border border-[var(--bh-line)] bg-white p-5 shadow-sm">
          <h2 className="font-serif text-lg">Notes</h2>
          <p className="mt-2 whitespace-pre-wrap text-sm text-[var(--bh-ink)]">
            {agency.notes}
          </p>
        </section>
      ) : null}
    </div>
  )
}

function NoROIBanner({ activeEngagement }: { activeEngagement: boolean }) {
  return (
    <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
      <div>
        <p className="font-medium">
          {activeEngagement
            ? 'No attributed first-touch leads yet in the 90-day window.'
            : 'Add an engagement to start measuring ROI.'}
        </p>
        <p className="mt-1 text-amber-800">
          {activeEngagement
            ? 'Either the agency is brand-new, channel keys aren’t mapped yet, or attribution is going elsewhere. Verify managed channels on the engagement and check /intel/sources for the broader picture.'
            : 'The ROI panel reads attribution_events whose source_platform matches the channels you mark as agency-managed on the engagement.'}
        </p>
      </div>
    </div>
  )
}

function BigStat({
  label,
  value,
  sub,
  highlight,
}: {
  label: string
  value: string
  sub?: string
  highlight?: boolean
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        highlight
          ? 'border-[var(--bh-sage-300)] bg-[var(--bh-sage-50)]'
          : 'border-[var(--bh-line)] bg-white'
      }`}
    >
      <div className="text-[10px] uppercase tracking-wide text-[var(--bh-muted)]">
        {label}
      </div>
      <div className="mt-1 font-serif text-xl tabular-nums">{value}</div>
      {sub ? (
        <div className="mt-0.5 text-[11px] text-[var(--bh-muted)]">{sub}</div>
      ) : null}
    </div>
  )
}

function EngagementRowView({
  engagement,
  channels,
}: {
  engagement: EngagementRow
  channels: ChannelRow[]
}) {
  const channelLabels = new Map(channels.map((c) => [c.key, c.label]))
  return (
    <div className="rounded-lg border border-[var(--bh-line)] bg-[var(--bh-warm-50)]/50 p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-center gap-2 text-[var(--bh-muted)]">
          <Calendar className="h-3 w-3" />
          <span>
            {engagement.startedAt} →{' '}
            {engagement.endedAt ?? (
              <span className="inline-flex items-center gap-1 text-emerald-700">
                <Check className="h-3 w-3" /> active
              </span>
            )}
          </span>
        </div>
        <div className="tabular-nums">
          {formatDollars(engagement.monthlyFeeCents)} / mo
        </div>
      </div>
      {engagement.managedChannels.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {engagement.managedChannels.map((k) => (
            <span
              key={k}
              className="rounded-full bg-white px-2 py-0.5 text-[10px] text-[var(--bh-muted)]"
            >
              {channelLabels.get(k) ?? k}
            </span>
          ))}
        </div>
      ) : (
        <div className="mt-2 text-xs text-amber-700">
          No managed channels selected — ROI rollup will be empty.
        </div>
      )}
      {engagement.scopeDescription ? (
        <p className="mt-2 text-xs text-[var(--bh-ink)]">
          {engagement.scopeDescription}
        </p>
      ) : null}
    </div>
  )
}

function EngagementForm({
  agencyId,
  channels,
  existing,
  onSaved,
}: {
  agencyId: string
  channels: ChannelRow[]
  existing: EngagementRow | null
  onSaved: () => Promise<void> | void
}) {
  const [startedAt, setStartedAt] = useState<string>(
    existing?.startedAt ?? todayIso(),
  )
  const [monthlyFeeStr, setMonthlyFeeStr] = useState<string>(
    existing ? String(existing.monthlyFeeCents / 100) : '',
  )
  const [managed, setManaged] = useState<Set<string>>(
    new Set(existing?.managedChannels ?? []),
  )
  const [scope, setScope] = useState<string>(existing?.scopeDescription ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = (k: string) => {
    setManaged((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      setError(null)
      setSubmitting(true)
      try {
        const monthlyFloat = Number(monthlyFeeStr.replace(/[$,]/g, ''))
        const resp = await fetch(`/api/intel/agencies/${agencyId}/engagements`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            startedAt,
            monthlyFeeCents:
              Number.isFinite(monthlyFloat) && monthlyFloat >= 0
                ? Math.round(monthlyFloat * 100)
                : 0,
            managedChannels: [...managed],
            scopeDescription: scope.trim() || null,
          }),
        })
        if (!resp.ok) {
          const j = (await resp.json().catch(() => null)) as
            | { error?: string }
            | null
          setError(j?.error ?? 'Save failed.')
          return
        }
        await onSaved()
      } finally {
        setSubmitting(false)
      }
    },
    [agencyId, startedAt, monthlyFeeStr, managed, scope, onSaved],
  )

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-4 space-y-4 rounded-lg border border-[var(--bh-line)] bg-[var(--bh-sage-50)]/40 p-4"
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wide text-[var(--bh-muted)]">
            Started
          </span>
          <input
            type="date"
            value={startedAt}
            onChange={(e) => setStartedAt(e.target.value)}
            required
            className="w-full rounded-md border border-[var(--bh-line)] bg-white px-3 py-2"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wide text-[var(--bh-muted)]">
            Monthly fee (USD)
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={monthlyFeeStr}
            onChange={(e) => setMonthlyFeeStr(e.target.value)}
            placeholder="2000"
            className="w-full rounded-md border border-[var(--bh-line)] bg-white px-3 py-2"
          />
        </label>
      </div>

      <div>
        <span className="mb-2 block text-xs uppercase tracking-wide text-[var(--bh-muted)]">
          Managed channels
        </span>
        {channels.length === 0 ? (
          <p className="text-xs text-[var(--bh-muted)]">
            No channels configured yet. Add channels at{' '}
            <Link
              href="/portal/marketing-channels-config"
              className="underline"
            >
              /portal/marketing-channels-config
            </Link>
            .
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {channels.map((c) => {
              const on = managed.has(c.key)
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggle(c.key)}
                  className={`rounded-full border px-3 py-1 text-xs transition ${
                    on
                      ? 'border-[var(--bh-sage-700)] bg-[var(--bh-sage-700)] text-white'
                      : 'border-[var(--bh-line)] bg-white text-[var(--bh-ink)] hover:border-[var(--bh-sage-500)]'
                  }`}
                >
                  {c.label}
                </button>
              )
            })}
          </div>
        )}
        <p className="mt-2 text-[11px] text-[var(--bh-muted)]">
          These are the channel keys the ROI compute uses to roll up
          first-touch attribution to this agency.
        </p>
      </div>

      <label className="block text-sm">
        <span className="mb-1 block text-xs uppercase tracking-wide text-[var(--bh-muted)]">
          Scope description (optional)
        </span>
        <textarea
          rows={3}
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          placeholder="What this agency actually does for this venue."
          className="w-full rounded-md border border-[var(--bh-line)] bg-white px-3 py-2"
        />
      </label>

      {error ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800">
          {error}
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex items-center gap-2 rounded-md bg-[var(--bh-sage-700)] px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          Save engagement
        </button>
      </div>
    </form>
  )
}
