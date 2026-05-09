'use client'

/**
 * /agent/classification-health — Sage classifier health dashboard.
 *
 * Verifies that every inbound email is being read + classified by Haiku.
 * Read-only. No mutations. Coordinator + super_admin via standard RLS.
 *
 * Schema notes:
 *   - "inbounds" = interactions WHERE direction='inbound' AND type='email'
 *   - "classifier runs" = api_costs WHERE context='email_classification'
 *     (the cost-tracker logs the AI client's `taskType` into
 *     api_costs.context — see lib/ai/cost-tracker.ts + the classifyEmail
 *     call in lib/services/brain/router.ts)
 *   - "classification value" = intelligence_extractions WHERE
 *     extraction_type='inquiry_classification', joined to interactions
 *     by interaction_id. The pipeline persists the full classifier blob
 *     here on every email (see pipeline.ts ~L2266).
 *
 * Why these tables (not interactions.classification): the original spec
 * referenced an interactions.classification column that does not exist
 * in the schema. The pipeline writes the classification into
 * intelligence_extractions.metadata.classification keyed back to
 * interaction_id. That's the source of truth.
 */

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useScope } from '@/lib/hooks/use-scope'
import { createClient } from '@/lib/supabase/client'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  DollarSign,
  Loader2,
  ShieldAlert,
  Sparkles,
} from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DailyRow {
  date: string // YYYY-MM-DD (UTC day key)
  inbounds: number
  classifierRuns: number
}

interface DistributionRow {
  classification: string
  count: number
}

interface NullRow {
  id: string
  subject: string | null
  from_email: string | null
  from_name: string | null
  timestamp: string
  gmail_message_id: string | null
}

interface VenueCostRow {
  venue_id: string | null
  cost: number
  calls: number
}

// Possible classifier output values per
// src/lib/services/brain/router.ts:280 (classifyEmail). Plus null bucket
// for any inbound row missing an extraction.
const CLASSIFICATION_KEYS = [
  'new_inquiry',
  'inquiry_reply',
  'client_message',
  'vendor',
  'spam',
  'internal',
  'other',
] as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dayKey = (iso: string): string => iso.slice(0, 10)

function buildDailyBuckets(days: number): string[] {
  const out: string[] = []
  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setUTCDate(now.getUTCDate() - i)
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}

function fmtUSD(n: number): string {
  if (n === 0) return '$0.00'
  if (n < 0.01) return `<$0.01`
  if (n < 100) return `$${n.toFixed(2)}`
  return `$${n.toFixed(0)}`
}

function classificationLabel(c: string): string {
  switch (c) {
    case 'new_inquiry':
      return 'New inquiry'
    case 'inquiry_reply':
      return 'Inquiry reply'
    case 'client_message':
      return 'Client message'
    case 'vendor':
      return 'Vendor'
    case 'spam':
      return 'Spam'
    case 'internal':
      return 'Internal'
    case 'other':
      return 'Other'
    case '__null':
      return 'Unclassified (null)'
    default:
      return c
  }
}

function classificationColor(c: string): string {
  switch (c) {
    case 'new_inquiry':
      return 'bg-emerald-50 text-emerald-700'
    case 'inquiry_reply':
      return 'bg-teal-50 text-teal-700'
    case 'client_message':
      return 'bg-sage-50 text-sage-700'
    case 'vendor':
      return 'bg-blue-50 text-blue-700'
    case 'spam':
      return 'bg-rose-50 text-rose-700'
    case 'internal':
      return 'bg-purple-50 text-purple-700'
    case 'other':
      return 'bg-amber-50 text-amber-700'
    case '__null':
      return 'bg-rose-100 text-rose-800'
    default:
      return 'bg-sage-50 text-sage-700'
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ClassificationHealthPage() {
  const scope = useScope()
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  // Overview band
  const [todayInbounds, setTodayInbounds] = useState(0)
  const [todayClassifierRuns, setTodayClassifierRuns] = useState(0)
  const [todayUnclassified, setTodayUnclassified] = useState(0)
  const [ytdClassifierSpend, setYtdClassifierSpend] = useState(0)

  // Charts / tables
  const [daily, setDaily] = useState<DailyRow[]>([])
  const [distribution, setDistribution] = useState<DistributionRow[]>([])
  const [nullRows, setNullRows] = useState<NullRow[]>([])
  const [venueCosts, setVenueCosts] = useState<VenueCostRow[]>([])
  const [monthlyRunRate, setMonthlyRunRate] = useState(0)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const supabase = createClient()
        const venueId = scope.venueId

        // ---- Time windows (UTC day-aligned) ----
        const now = new Date()
        const today0 = new Date(Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
        ))
        const since14d = new Date(today0)
        since14d.setUTCDate(today0.getUTCDate() - 13) // 14 days inclusive
        const since7d = new Date(today0)
        since7d.setUTCDate(today0.getUTCDate() - 6) // 7 days inclusive
        const since30d = new Date(today0)
        since30d.setUTCDate(today0.getUTCDate() - 29) // 30 days inclusive
        const sinceYTD = new Date(Date.UTC(now.getUTCFullYear(), 0, 1))

        const tomorrow = new Date(today0)
        tomorrow.setUTCDate(today0.getUTCDate() + 1)

        // ---- Inbounds (last 14d, scoped to venue if set) ----
        let inboundQuery = supabase
          .from('interactions')
          .select('id, timestamp, subject, from_email, from_name, gmail_message_id, venue_id')
          .eq('direction', 'inbound')
          .eq('type', 'email')
          .gte('timestamp', since14d.toISOString())
          .order('timestamp', { ascending: false })
          .limit(5000)
        if (venueId) inboundQuery = inboundQuery.eq('venue_id', venueId)

        const inboundsRes = await inboundQuery
        if (inboundsRes.error) throw inboundsRes.error
        const inbounds = (inboundsRes.data ?? []) as Array<{
          id: string
          timestamp: string
          subject: string | null
          from_email: string | null
          from_name: string | null
          gmail_message_id: string | null
          venue_id: string
        }>

        // ---- Classifier api_cost rows (last 14d) ----
        let costQuery14d = supabase
          .from('api_costs')
          .select('cost, created_at, venue_id')
          .eq('context', 'email_classification')
          .gte('created_at', since14d.toISOString())
          .limit(20_000)
        if (venueId) costQuery14d = costQuery14d.eq('venue_id', venueId)
        const cost14dRes = await costQuery14d
        if (cost14dRes.error) throw cost14dRes.error
        const cost14d = (cost14dRes.data ?? []) as Array<{
          cost: number | null
          created_at: string
          venue_id: string | null
        }>

        // ---- YTD classifier spend (single sum, scoped) ----
        let costYTDQuery = supabase
          .from('api_costs')
          .select('cost')
          .eq('context', 'email_classification')
          .gte('created_at', sinceYTD.toISOString())
          .limit(100_000)
        if (venueId) costYTDQuery = costYTDQuery.eq('venue_id', venueId)
        const costYTDRes = await costYTDQuery
        if (costYTDRes.error) throw costYTDRes.error
        const costYTD = (costYTDRes.data ?? []) as Array<{ cost: number | null }>
        const ytdSum = costYTD.reduce((a, r) => a + Number(r.cost ?? 0), 0)

        // ---- Last 30d roll-up by venue (no venueId filter — this is the
        // cross-venue panel; super_admin sees all, RLS narrows others). ----
        const cost30dRes = await supabase
          .from('api_costs')
          .select('cost, venue_id')
          .eq('context', 'email_classification')
          .gte('created_at', since30d.toISOString())
          .limit(100_000)
        if (cost30dRes.error) throw cost30dRes.error
        const cost30d = (cost30dRes.data ?? []) as Array<{
          cost: number | null
          venue_id: string | null
        }>
        const venueBucket = new Map<string | null, { cost: number; calls: number }>()
        for (const r of cost30d) {
          const k = r.venue_id ?? null
          const b = venueBucket.get(k) ?? { cost: 0, calls: 0 }
          b.cost += Number(r.cost ?? 0)
          b.calls += 1
          venueBucket.set(k, b)
        }
        const venueRows: VenueCostRow[] = Array.from(venueBucket.entries())
          .map(([vid, b]) => ({ venue_id: vid, cost: b.cost, calls: b.calls }))
          .sort((a, b) => b.cost - a.cost)

        // 30-day spend → projected monthly. Uses calendar 30 not days-elapsed
        // because we always pull the trailing 30. Run-rate := sum × (30/30).
        const totalLast30 = venueRows.reduce((a, r) => a + r.cost, 0)

        // ---- intelligence_extractions for the same inbound IDs ----
        // Pull every inquiry_classification extraction for these
        // interactions so we can join classification + spot the nulls.
        const interactionIds = inbounds.map((i) => i.id)
        let classifications: Array<{
          interaction_id: string | null
          metadata: Record<string, unknown> | null
          created_at: string
        }> = []
        if (interactionIds.length > 0) {
          // Supabase 'in' filter has ~1000-id limit; chunk to be safe.
          const CHUNK = 500
          for (let i = 0; i < interactionIds.length; i += CHUNK) {
            const slice = interactionIds.slice(i, i + CHUNK)
            const r = await supabase
              .from('intelligence_extractions')
              .select('interaction_id, metadata, created_at')
              .eq('extraction_type', 'inquiry_classification')
              .in('interaction_id', slice)
            if (r.error) throw r.error
            classifications = classifications.concat(
              (r.data ?? []) as typeof classifications,
            )
          }
        }
        // Map interaction_id → first classification value found.
        const classByInt = new Map<string, string | null>()
        for (const c of classifications) {
          if (!c.interaction_id) continue
          if (classByInt.has(c.interaction_id)) continue
          const md = (c.metadata ?? {}) as { classification?: string }
          classByInt.set(c.interaction_id, md.classification ?? null)
        }

        // ---- Build daily series (14d) ----
        const dayBuckets = buildDailyBuckets(14)
        const inboundByDay = new Map<string, number>()
        for (const i of inbounds) {
          const k = dayKey(i.timestamp)
          inboundByDay.set(k, (inboundByDay.get(k) ?? 0) + 1)
        }
        const runsByDay = new Map<string, number>()
        for (const r of cost14d) {
          const k = dayKey(r.created_at)
          runsByDay.set(k, (runsByDay.get(k) ?? 0) + 1)
        }
        const dailyRows: DailyRow[] = dayBuckets.map((d) => ({
          date: d,
          inbounds: inboundByDay.get(d) ?? 0,
          classifierRuns: runsByDay.get(d) ?? 0,
        }))

        // ---- Build distribution (last 7 days) ----
        const since7Iso = since7d.toISOString()
        const counts = new Map<string, number>()
        for (const k of CLASSIFICATION_KEYS) counts.set(k, 0)
        counts.set('__null', 0)
        for (const i of inbounds) {
          if (i.timestamp < since7Iso) continue
          const c = classByInt.get(i.id) ?? null
          const bucket =
            c && (CLASSIFICATION_KEYS as readonly string[]).includes(c)
              ? c
              : c === null
                ? '__null'
                : 'other'
          counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
        }
        const distRows: DistributionRow[] = Array.from(counts.entries())
          .map(([classification, count]) => ({ classification, count }))
          .sort((a, b) => b.count - a.count)

        // ---- Null list (last 7 days, scope-respecting) ----
        const nulls: NullRow[] = inbounds
          .filter(
            (i) => i.timestamp >= since7Iso && classByInt.get(i.id) == null,
          )
          .slice(0, 50)
          .map((i) => ({
            id: i.id,
            subject: i.subject,
            from_email: i.from_email,
            from_name: i.from_name,
            timestamp: i.timestamp,
            gmail_message_id: i.gmail_message_id,
          }))

        // ---- Today buckets ----
        const todayIso = today0.toISOString()
        const tomorrowIso = tomorrow.toISOString()
        const todayInb = inbounds.filter(
          (i) => i.timestamp >= todayIso && i.timestamp < tomorrowIso,
        )
        const todayInbCount = todayInb.length
        const todayRuns = cost14d.filter(
          (r) => r.created_at >= todayIso && r.created_at < tomorrowIso,
        ).length
        const todayNullCount = todayInb.filter(
          (i) => classByInt.get(i.id) == null,
        ).length

        if (cancelled) return
        setTodayInbounds(todayInbCount)
        setTodayClassifierRuns(todayRuns)
        setTodayUnclassified(todayNullCount)
        setYtdClassifierSpend(ytdSum)
        setDaily(dailyRows)
        setDistribution(distRows)
        setNullRows(nulls)
        setVenueCosts(venueRows)
        setMonthlyRunRate(totalLast30)
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [scope.venueId])

  // Health badge for the "today" band: classifier runs should equal or
  // exceed inbounds (a single email can re-run if reprocess-orphans
  // fires; the inverse — runs < inbounds — is the failure mode).
  const todayHealth = useMemo(() => {
    if (todayInbounds === 0) {
      return { tone: 'idle', label: 'No inbounds yet today' }
    }
    if (todayUnclassified === 0 && todayClassifierRuns >= todayInbounds) {
      return { tone: 'ok', label: 'Healthy' }
    }
    if (todayUnclassified > 0) {
      return {
        tone: 'warn',
        label: `${todayUnclassified} unclassified — check pipeline`,
      }
    }
    if (todayClassifierRuns < todayInbounds) {
      return {
        tone: 'warn',
        label: `Classifier behind by ${todayInbounds - todayClassifierRuns}`,
      }
    }
    return { tone: 'ok', label: 'Healthy' }
  }, [todayInbounds, todayClassifierRuns, todayUnclassified])

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
          Could not load classification health: {err}
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-serif text-sage-900 flex items-center gap-2">
          <ShieldAlert className="w-6 h-6 text-teal-600" />
          Classification health
        </h1>
        <p className="text-sm text-sage-500 mt-1">
          Verifies Sage is reading and classifying every inbound email. If
          the daily bars stop matching or the unclassified list grows, the
          pipeline is dropping work.
        </p>
      </div>

      {/* ---------- 1. Overview band ---------- */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="text-xs uppercase tracking-wider text-sage-500">
            Today inbounds
          </div>
          <div className="text-2xl font-semibold text-sage-900 mt-1">
            {todayInbounds}
          </div>
          <div className="text-xs text-sage-500 mt-1">
            inbound emails received today
          </div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="text-xs uppercase tracking-wider text-sage-500">
            Today classified
          </div>
          <div className="text-2xl font-semibold text-sage-900 mt-1">
            {todayClassifierRuns}
          </div>
          <div className="text-xs text-sage-500 mt-1">
            Haiku classifier calls today
          </div>
        </div>
        <div
          className={`bg-surface border rounded-xl p-4 ${
            todayUnclassified > 0 ? 'border-rose-200' : 'border-border'
          }`}
        >
          <div className="text-xs uppercase tracking-wider text-sage-500">
            Today null-classification
          </div>
          <div
            className={`text-2xl font-semibold mt-1 ${
              todayUnclassified > 0 ? 'text-rose-600' : 'text-sage-900'
            }`}
          >
            {todayUnclassified}
          </div>
          <div className="text-xs text-sage-500 mt-1">
            inbounds with no extraction record
          </div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="text-xs uppercase tracking-wider text-sage-500">
            YTD classifier spend
          </div>
          <div className="text-2xl font-semibold text-sage-900 mt-1">
            {fmtUSD(ytdClassifierSpend)}
          </div>
          <div className="text-xs text-sage-500 mt-1">
            email_classification, year-to-date
          </div>
        </div>
        <div className="sm:col-span-2 lg:col-span-4">
          <div
            className={`flex items-center gap-2 text-sm rounded-lg px-3 py-2 ${
              todayHealth.tone === 'ok'
                ? 'bg-emerald-50 text-emerald-700'
                : todayHealth.tone === 'warn'
                  ? 'bg-rose-50 text-rose-700'
                  : 'bg-sage-50 text-sage-600'
            }`}
          >
            {todayHealth.tone === 'ok' ? (
              <CheckCircle2 className="w-4 h-4" />
            ) : todayHealth.tone === 'warn' ? (
              <AlertTriangle className="w-4 h-4" />
            ) : (
              <Activity className="w-4 h-4" />
            )}
            <span>{todayHealth.label}</span>
          </div>
        </div>
      </section>

      {/* ---------- 2. Daily chart ---------- */}
      <section className="bg-surface border border-border rounded-xl p-5 space-y-3">
        <h2 className="text-base font-semibold text-sage-800 flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-teal-600" />
          Inbounds vs classifier runs (last 14 days)
        </h2>
        <p className="text-xs text-sage-500">
          Bars should be roughly the same height each day. A persistent gap
          (inbounds &gt; classifier runs) means the pipeline is dropping
          work before it reaches Haiku.
        </p>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={daily}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="date" stroke="#9ca3af" fontSize={11} />
              <YAxis stroke="#9ca3af" fontSize={11} allowDecimals={false} />
              <Tooltip />
              <Legend />
              <Bar
                dataKey="inbounds"
                fill="#7D8471"
                name="Inbound emails"
                radius={[4, 4, 0, 0]}
              />
              <Bar
                dataKey="classifierRuns"
                fill="#5D7A7A"
                name="Classifier runs"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* ---------- 3. Distribution table ---------- */}
      <section className="bg-surface border border-border rounded-xl p-5 space-y-3">
        <h2 className="text-base font-semibold text-sage-800 flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-teal-600" />
          Classification distribution (last 7 days)
        </h2>
        <p className="text-xs text-sage-500">
          If one bucket dominates &gt;80% of traffic, the prompt may be
          stuck — Haiku falls back to the same label when context is
          ambiguous.
        </p>
        {distribution.every((r) => r.count === 0) ? (
          <p className="text-sm text-sage-500">No inbounds in the last 7 days.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-sage-500 border-b border-border">
                  <th className="py-2">Classification</th>
                  <th className="py-2 text-right">Count</th>
                  <th className="py-2 text-right">Share</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const total = distribution.reduce((a, r) => a + r.count, 0)
                  return distribution.map((r) => {
                    const pct = total > 0 ? (r.count / total) * 100 : 0
                    return (
                      <tr
                        key={r.classification}
                        className="border-b border-border last:border-0"
                      >
                        <td className="py-2.5">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${classificationColor(r.classification)}`}
                          >
                            {classificationLabel(r.classification)}
                          </span>
                        </td>
                        <td className="py-2.5 text-right text-sage-800">
                          {r.count}
                        </td>
                        <td className="py-2.5 text-right text-sage-500">
                          {pct.toFixed(0)}%
                        </td>
                      </tr>
                    )
                  })
                })()}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---------- 4. Null-classification list ---------- */}
      <section className="bg-surface border border-border rounded-xl p-5 space-y-3">
        <h2 className="text-base font-semibold text-sage-800 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-600" />
          Inbounds with no classification (last 7 days)
        </h2>
        <p className="text-xs text-sage-500">
          These rows hit the inbox but never produced an
          intelligence_extractions row. Click through to the inbox to
          inspect — usually the pipeline errored mid-processing.
        </p>
        {nullRows.length === 0 ? (
          <p className="text-sm text-emerald-700">
            All inbounds in the last 7 days have a classification record.
          </p>
        ) : (
          <div className="space-y-1">
            {nullRows.map((r) => {
              const q = r.gmail_message_id ?? r.from_email ?? ''
              const href = q
                ? `/agent/inbox?q=${encodeURIComponent(q)}`
                : '/agent/inbox'
              return (
                <Link
                  key={r.id}
                  href={href}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg bg-rose-50/50 hover:bg-rose-50 transition-colors"
                >
                  <span className="text-xs text-sage-500 w-44 shrink-0">
                    {new Date(r.timestamp).toLocaleString()}
                  </span>
                  <span className="text-sm text-sage-800 truncate flex-1">
                    {r.subject ?? '(no subject)'}
                  </span>
                  <span className="text-xs text-sage-500 truncate max-w-xs">
                    {r.from_name ?? r.from_email ?? '—'}
                  </span>
                </Link>
              )
            })}
          </div>
        )}
      </section>

      {/* ---------- 5. Per-venue cost roll-up ---------- */}
      <section className="bg-surface border border-border rounded-xl p-5 space-y-3">
        <h2 className="text-base font-semibold text-sage-800 flex items-center gap-2">
          <DollarSign className="w-4 h-4 text-teal-600" />
          Classifier spend by venue (last 30 days)
        </h2>
        <p className="text-xs text-sage-500">
          Trailing 30-day total per venue. Projected monthly run-rate is
          the same number — the trailing window is exactly 30 calendar
          days. RLS limits the table to venues you have access to.
        </p>
        {venueCosts.length === 0 ? (
          <p className="text-sm text-sage-500">
            No email_classification calls in the last 30 days.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-sage-500 border-b border-border">
                  <th className="py-2">Venue</th>
                  <th className="py-2 text-right">Calls</th>
                  <th className="py-2 text-right">Cost (30d)</th>
                  <th className="py-2 text-right">Projected monthly</th>
                </tr>
              </thead>
              <tbody>
                {venueCosts.map((v) => (
                  <tr
                    key={v.venue_id ?? '__null__'}
                    className="border-b border-border last:border-0"
                  >
                    <td className="py-2.5 font-mono text-xs text-sage-700">
                      {v.venue_id ?? '— (unscoped)'}
                    </td>
                    <td className="py-2.5 text-right text-sage-800">
                      {v.calls.toLocaleString()}
                    </td>
                    <td className="py-2.5 text-right text-sage-800">
                      {fmtUSD(v.cost)}
                    </td>
                    <td className="py-2.5 text-right text-sage-500">
                      {fmtUSD(v.cost)}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td className="py-2.5 font-medium text-sage-900">Total</td>
                  <td className="py-2.5 text-right text-sage-900 font-medium">
                    {venueCosts
                      .reduce((a, r) => a + r.calls, 0)
                      .toLocaleString()}
                  </td>
                  <td className="py-2.5 text-right text-sage-900 font-medium">
                    {fmtUSD(monthlyRunRate)}
                  </td>
                  <td className="py-2.5 text-right text-sage-700 font-medium">
                    {fmtUSD(monthlyRunRate)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
