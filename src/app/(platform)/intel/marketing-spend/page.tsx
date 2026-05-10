'use client'

/**
 * Wave 6A — marketing-spend manual entry + smoke-test view.
 *
 * Anchor docs:
 *   - bloom-wave4-5-6-master-plan.md (6A: ingestion lands now; full ROI
 *     dashboard is 6B)
 *
 * Scope: small panel proving ingestion works end-to-end. Operator can
 * type a row, paste a CSV chunk, and see month-to-date / year-to-date
 * totals. The full persona × channel × revenue dashboard ships in 6B.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { DollarSign, Plus, Loader2, AlertCircle, Check } from 'lucide-react'

interface SpendRow {
  id: string
  venue_id: string
  channel: string
  campaign_id: string | null
  campaign_name: string | null
  spend_date: string
  amount_cents: number
  currency: string
  ingested_at: string
  ingested_by: string | null
}

interface ListResponse {
  ok: true
  venueId: string
  count: number
  rows: SpendRow[]
}

interface SummaryResponse {
  ok: true
  venueId: string
  groupBy: 'channel' | 'campaign' | 'persona'
  totalCents: number
  groups: Array<{ key: string; label: string; totalCents: number; rowCount: number }>
}

const CHANNEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'google_ads', label: 'Google Ads' },
  { value: 'meta_ads', label: 'Meta Ads (Instagram / Facebook)' },
  { value: 'tiktok_ads', label: 'TikTok Ads' },
  { value: 'theknot_fee', label: 'The Knot fee' },
  { value: 'weddingwire_fee', label: 'WeddingWire fee' },
  { value: 'organic_seo', label: 'Organic SEO / content' },
  { value: 'vendor_referral', label: 'Vendor referral' },
  { value: 'other', label: 'Other' },
]

function todayIso(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function startOfMonthIso(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}-01`
}

function startOfYearIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-01-01`
}

function formatDollars(cents: number): string {
  const dollars = cents / 100
  return `$${dollars.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

export default function MarketingSpendPage() {
  const [rows, setRows] = useState<SpendRow[]>([])
  const [thisMonth, setThisMonth] = useState<number>(0)
  const [thisYear, setThisYear] = useState<number>(0)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [submitMsg, setSubmitMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // Form fields
  const [channel, setChannel] = useState<string>('google_ads')
  const [campaignName, setCampaignName] = useState<string>('')
  const [spendDate, setSpendDate] = useState<string>(todayIso())
  const [amountStr, setAmountStr] = useState<string>('')
  const [currency, setCurrency] = useState<string>('USD')
  const [notes, setNotes] = useState<string>('')

  // Bulk import textarea (CSV format)
  const [csvText, setCsvText] = useState<string>('')
  const [csvProgress, setCsvProgress] = useState<{ inserted: number; duplicates: number; errors: string[] } | null>(null)

  // ---------------------------------------------------------------
  // Loaders
  // ---------------------------------------------------------------

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [listResp, monthResp, yearResp] = await Promise.all([
        fetch('/api/admin/marketing-spend/list?limit=50'),
        fetch(`/api/admin/marketing-spend/summary?fromDate=${startOfMonthIso()}`),
        fetch(`/api/admin/marketing-spend/summary?fromDate=${startOfYearIso()}`),
      ])
      if (listResp.ok) {
        const j = (await listResp.json()) as ListResponse
        setRows(j.rows ?? [])
      }
      if (monthResp.ok) {
        const j = (await monthResp.json()) as SummaryResponse
        setThisMonth(j.totalCents ?? 0)
      }
      if (yearResp.ok) {
        const j = (await yearResp.json()) as SummaryResponse
        setThisYear(j.totalCents ?? 0)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // ---------------------------------------------------------------
  // Submit handlers
  // ---------------------------------------------------------------

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      setSubmitMsg(null)
      const amountFloat = Number(amountStr.replace(/[$,]/g, ''))
      if (!Number.isFinite(amountFloat) || amountFloat < 0) {
        setSubmitMsg({ ok: false, text: 'Amount must be a non-negative number.' })
        return
      }
      const amountCents = Math.round(amountFloat * 100)
      setSubmitting(true)
      try {
        const resp = await fetch('/api/admin/marketing-spend/manual', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel,
            campaignName: campaignName || null,
            spendDate,
            amountCents,
            currency,
            notes: notes || null,
          }),
        })
        const j = (await resp.json()) as {
          ok: boolean
          inserted?: boolean
          reason?: string | null
          error?: string
        }
        if (!resp.ok || !j.ok) {
          setSubmitMsg({ ok: false, text: j.error ?? 'Failed to record spend.' })
        } else if (j.inserted) {
          setSubmitMsg({ ok: true, text: 'Spend recorded.' })
          setCampaignName('')
          setAmountStr('')
          setNotes('')
          await refresh()
        } else {
          setSubmitMsg({
            ok: true,
            text: `Already recorded (${j.reason ?? 'duplicate'}).`,
          })
        }
      } catch (err) {
        setSubmitMsg({
          ok: false,
          text: err instanceof Error ? err.message : 'Network error.',
        })
      } finally {
        setSubmitting(false)
      }
    },
    [channel, campaignName, spendDate, amountStr, currency, notes, refresh],
  )

  const parseCsvAndPost = useCallback(async () => {
    setCsvProgress(null)
    if (!csvText.trim()) return
    const lines = csvText
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    if (lines.length < 2) {
      setCsvProgress({
        inserted: 0,
        duplicates: 0,
        errors: ['CSV needs a header row + at least one data row'],
      })
      return
    }
    const headers = lines[0].split(',').map((h) => h.trim().toLowerCase())
    const channelIdx = headers.findIndex((h) => /channel|source|platform/.test(h))
    const dateIdx = headers.findIndex((h) => /date|day|spend_date/.test(h))
    const amountIdx = headers.findIndex((h) => /amount|spend|cost/.test(h))
    const campaignIdx = headers.findIndex((h) => /campaign|name/.test(h))
    if (channelIdx === -1 || dateIdx === -1 || amountIdx === -1) {
      setCsvProgress({
        inserted: 0,
        duplicates: 0,
        errors: [
          'CSV must have columns: channel (or source/platform), date (or day/spend_date), amount (or spend/cost). Optional: campaign.',
        ],
      })
      return
    }

    let inserted = 0
    let duplicates = 0
    const errors: string[] = []
    setSubmitting(true)
    try {
      for (let i = 1; i < lines.length; i++) {
        const cells = lines[i].split(',').map((c) => c.trim())
        const ch = cells[channelIdx]
        const dt = cells[dateIdx]
        const amtRaw = cells[amountIdx]?.replace(/[$,]/g, '') ?? ''
        const amt = Number(amtRaw)
        const cmp = campaignIdx >= 0 ? cells[campaignIdx] : null
        if (!ch || !dt || !Number.isFinite(amt)) {
          errors.push(`row ${i + 1}: parse error`)
          continue
        }
        try {
          const resp = await fetch('/api/admin/marketing-spend/manual', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              channel: ch,
              campaignName: cmp || null,
              spendDate: dt,
              amountCents: Math.round(amt * 100),
            }),
          })
          const j = (await resp.json()) as { ok: boolean; inserted?: boolean; error?: string }
          if (!resp.ok || !j.ok) {
            errors.push(`row ${i + 1}: ${j.error ?? 'failed'}`)
            continue
          }
          if (j.inserted) inserted += 1
          else duplicates += 1
        } catch (err) {
          errors.push(
            `row ${i + 1}: ${err instanceof Error ? err.message : 'error'}`,
          )
        }
      }
    } finally {
      setSubmitting(false)
    }
    setCsvProgress({ inserted, duplicates, errors })
    await refresh()
  }, [csvText, refresh])

  // ---------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------

  const headerStats = useMemo(
    () => (
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
        <div>
          <span className="text-[var(--bh-muted)]">This month: </span>
          <span className="font-semibold tabular-nums">
            {formatDollars(thisMonth)}
          </span>
        </div>
        <div>
          <span className="text-[var(--bh-muted)]">This year: </span>
          <span className="font-semibold tabular-nums">
            {formatDollars(thisYear)}
          </span>
        </div>
      </div>
    ),
    [thisMonth, thisYear],
  )

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-serif text-2xl text-[var(--bh-ink)]">
            Marketing Spend
          </h1>
          <p className="mt-1 text-sm text-[var(--bh-muted)]">
            Record what you spend per channel, per day. Wave 6B layers
            persona × channel ROI on top.
          </p>
        </div>
        {headerStats}
      </div>

      {/* Manual entry form */}
      <section className="rounded-2xl border border-[var(--bh-line)] bg-white p-5 shadow-sm">
        <h2 className="font-serif text-lg flex items-center gap-2">
          <Plus className="h-4 w-4" /> Record a spend row
        </h2>
        <form
          onSubmit={handleSubmit}
          className="mt-4 grid gap-4 grid-cols-1 sm:grid-cols-2 md:grid-cols-3"
        >
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--bh-muted)]">Channel</span>
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              className="rounded-md border border-[var(--bh-line)] bg-white px-3 py-2 text-sm"
            >
              {CHANNEL_OPTIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--bh-muted)]">Campaign name (optional)</span>
            <input
              type="text"
              value={campaignName}
              onChange={(e) => setCampaignName(e.target.value)}
              className="rounded-md border border-[var(--bh-line)] bg-white px-3 py-2 text-sm"
              placeholder="e.g. Spring Tour Push"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--bh-muted)]">Spend date</span>
            <input
              type="date"
              value={spendDate}
              onChange={(e) => setSpendDate(e.target.value)}
              required
              className="rounded-md border border-[var(--bh-line)] bg-white px-3 py-2 text-sm"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--bh-muted)]">Amount</span>
            <div className="flex items-center gap-1">
              <span className="text-[var(--bh-muted)]">$</span>
              <input
                type="text"
                inputMode="decimal"
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                required
                className="flex-1 rounded-md border border-[var(--bh-line)] bg-white px-3 py-2 text-sm"
                placeholder="0.00"
              />
            </div>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--bh-muted)]">Currency</span>
            <input
              type="text"
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              maxLength={3}
              className="rounded-md border border-[var(--bh-line)] bg-white px-3 py-2 text-sm uppercase"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm sm:col-span-2 md:col-span-1">
            <span className="text-[var(--bh-muted)]">Notes</span>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="rounded-md border border-[var(--bh-line)] bg-white px-3 py-2 text-sm"
              placeholder="optional"
            />
          </label>

          <div className="sm:col-span-2 md:col-span-3 flex items-center gap-3">
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-md bg-[var(--bh-sage-700)] px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <DollarSign className="h-4 w-4" />
              )}
              Record spend
            </button>
            {submitMsg ? (
              <span
                className={`flex items-center gap-1 text-sm ${
                  submitMsg.ok ? 'text-emerald-700' : 'text-rose-700'
                }`}
              >
                {submitMsg.ok ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <AlertCircle className="h-4 w-4" />
                )}
                {submitMsg.text}
              </span>
            ) : null}
          </div>
        </form>
      </section>

      {/* CSV bulk paste */}
      <section className="rounded-2xl border border-[var(--bh-line)] bg-white p-5 shadow-sm">
        <h2 className="font-serif text-lg">Bulk paste (CSV)</h2>
        <p className="mt-1 text-xs text-[var(--bh-muted)]">
          Header row required: <code>channel,date,amount,campaign</code>.
          Amounts in dollars (we convert to cents). Idempotent — duplicate
          (channel, campaign, date) rows are skipped.
        </p>
        <textarea
          rows={8}
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
          className="mt-3 w-full rounded-md border border-[var(--bh-line)] bg-white p-3 font-mono text-xs"
          placeholder={
            'channel,date,amount,campaign\ngoogle_ads,2026-05-01,42.50,Spring Tour Push\nmeta_ads,2026-05-01,18.00,Sage Reels'
          }
        />
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={parseCsvAndPost}
            disabled={submitting || !csvText.trim()}
            className="inline-flex items-center gap-2 rounded-md border border-[var(--bh-line)] bg-white px-4 py-2 text-sm hover:bg-[var(--bh-sage-50)] disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Import CSV rows
          </button>
          {csvProgress ? (
            <span className="text-sm">
              {csvProgress.inserted} inserted · {csvProgress.duplicates}{' '}
              duplicates
              {csvProgress.errors.length > 0
                ? ` · ${csvProgress.errors.length} errors`
                : null}
            </span>
          ) : null}
        </div>
        {csvProgress?.errors.length ? (
          <ul className="mt-2 max-h-40 overflow-auto rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800">
            {csvProgress.errors.slice(0, 20).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        ) : null}
      </section>

      {/* Recent rows table */}
      <section className="rounded-2xl border border-[var(--bh-line)] bg-white p-5 shadow-sm">
        <h2 className="font-serif text-lg">Recent rows</h2>
        {loading ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-[var(--bh-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--bh-muted)]">
            No spend rows yet. Add one above.
          </p>
        ) : (
          <div className="mt-3 overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--bh-line)] text-left text-xs text-[var(--bh-muted)]">
                  <th className="py-2 pr-3">Date</th>
                  <th className="py-2 pr-3">Channel</th>
                  <th className="py-2 pr-3">Campaign</th>
                  <th className="py-2 pr-3 text-right">Amount</th>
                  <th className="py-2 pr-3">Source</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-[var(--bh-line)]/60">
                    <td className="py-2 pr-3 tabular-nums">{r.spend_date}</td>
                    <td className="py-2 pr-3">{r.channel}</td>
                    <td className="py-2 pr-3 text-[var(--bh-muted)]">
                      {r.campaign_name ?? '—'}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatDollars(r.amount_cents)}
                    </td>
                    <td className="py-2 pr-3 text-xs text-[var(--bh-muted)]">
                      {r.ingested_by ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
