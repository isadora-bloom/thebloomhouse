'use client'

/**
 * Wave 6D — /intel/marketing-roi/digest page.
 *
 * Anchor: bloom-wave4-5-6-master-plan.md (6D weekly digest narrative
 * surface. Pulls top flags + top recs + WoW deltas + concluded A/B
 * tests + validated discoveries; renders the latest digest with a
 * history dropdown.)
 *
 * Distinct from /intel/marketing-roi (Wave 6B's heatmap dashboard),
 * /intel/marketing-roi/recommendations (Wave 6C's reallocation
 * dashboard), and /intel/marketing-roi/flags (Wave 6D's triage
 * dashboard). This page is the WEEKLY STORY of all of the above.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  Loader2,
  RefreshCw,
  Mail,
  MessageSquare,
} from 'lucide-react'
import {
  MarketingDigest,
  type DigestPayload,
} from '@/components/intel/MarketingDigest'

interface HistoryItem {
  id: string
  digest_period_start: string
  digest_period_end: string
  generated_at: string
}

interface LatestRow {
  id: string
  venue_id: string
  digest_period_start: string
  digest_period_end: string
  digest_jsonb: DigestPayload
  delivered_via: string | null
  delivered_at: string | null
  cost_cents: number | string
  prompt_version: string | null
  generated_at: string
  created_at: string
}

interface LatestResponse {
  ok: true
  venueId: string
  latest: LatestRow | null
  history: HistoryItem[]
}

interface BuildResponse {
  ok: boolean
  digest?: DigestPayload
  digestId?: string
  periodStart?: string
  periodEnd?: string
  costCents?: number
  error?: string
}

export default function MarketingDigestPage() {
  const [latest, setLatest] = useState<LatestRow | null>(null)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(
    null,
  )
  const [loading, setLoading] = useState(true)
  const [building, setBuilding] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [buildMsg, setBuildMsg] = useState<string | null>(null)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const resp = await fetch(
        `/api/admin/intel/marketing-loop/digest/latest`,
      )
      const j = (await resp.json()) as
        | LatestResponse
        | { ok: false; error: string }
      if (!resp.ok || !('ok' in j) || j.ok !== true) {
        setErr(
          'error' in j && typeof j.error === 'string'
            ? j.error
            : 'Failed to load digest',
        )
        return
      }
      setLatest(j.latest)
      setHistory(j.history)
      setSelectedHistoryId(j.latest?.id ?? null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchAll()
  }, [fetchAll])

  const handleBuild = useCallback(async () => {
    setBuilding(true)
    setBuildMsg(null)
    try {
      const resp = await fetch('/api/admin/intel/marketing-loop/digest/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const j = (await resp.json()) as BuildResponse
      if (!resp.ok || !j.ok) {
        setBuildMsg(`Build failed: ${j.error ?? 'unknown error'}`)
      } else {
        const cost =
          typeof j.costCents === 'number'
            ? `$${(j.costCents / 100).toFixed(3)}`
            : '$0'
        setBuildMsg(
          `Digest rebuilt for ${j.periodStart} → ${j.periodEnd}. Cost ${cost}.`,
        )
        await fetchAll()
      }
    } catch (e) {
      setBuildMsg(`Build threw: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBuilding(false)
    }
  }, [fetchAll])

  // Display the selected history item (defaults to latest).
  const displayDigest = useMemo<LatestRow | null>(() => {
    if (!selectedHistoryId) return latest
    if (latest && latest.id === selectedHistoryId) return latest
    // We only have the latest row's full payload from the latest endpoint.
    // For history-dropdown drill-down, in the current iteration we render
    // the latest payload but indicate the selection. A future iteration
    // adds GET /digest/[id] to load any past payload.
    return latest
  }, [latest, selectedHistoryId])

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl text-stone-900">
            Weekly marketing digest
          </h1>
          <p className="mt-1 text-sm text-stone-600">
            Each Monday, Sage narrates the week: top flags, pending
            recommendations, week-over-week metric shifts, A/B tests, and
            validated discoveries.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {history.length > 0 ? (
            <select
              value={selectedHistoryId ?? ''}
              onChange={(e) =>
                setSelectedHistoryId(e.target.value ? e.target.value : null)
              }
              className="rounded-md border border-stone-200 bg-white px-3 py-2 text-xs"
            >
              {history.map((h) => (
                <option key={h.id} value={h.id}>
                  Week of {h.digest_period_start} → {h.digest_period_end}
                </option>
              ))}
            </select>
          ) : null}
          <button
            type="button"
            onClick={handleBuild}
            disabled={building}
            className="inline-flex items-center gap-2 rounded-md border border-stone-900 bg-stone-900 px-3 py-2 text-xs text-white hover:bg-stone-800 disabled:opacity-50"
          >
            {building ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            Build new digest
          </button>
        </div>
      </div>

      {/* Delivery row — TODO when channels are wired. */}
      {displayDigest ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-stone-200 bg-white p-3 text-xs text-stone-600">
          <span>Delivered: {displayDigest.delivered_via ?? 'dashboard only'}</span>
          <span className="text-stone-400">·</span>
          {/* TODO: wire email delivery via Resend. Endpoint:
              POST /api/admin/intel/marketing-loop/digest/{id}/send
              with body { channel: 'email' | 'slack' }. The endpoint
              renders the digest as HTML/Slack-blocks and updates the
              delivered_via + delivered_at columns. */}
          <button
            type="button"
            disabled
            title="Email delivery coming soon — TODO wire Resend"
            className="inline-flex items-center gap-1 rounded-md border border-stone-200 bg-white px-2 py-1 text-xs text-stone-400 disabled:cursor-not-allowed"
          >
            <Mail className="h-3 w-3" />
            Send via email
          </button>
          {/* TODO: Slack channel integration. Same endpoint shape, body
              { channel: 'slack' }. Need slack_webhook_url on the venue
              row first. */}
          <button
            type="button"
            disabled
            title="Slack delivery coming soon — TODO add slack_webhook_url to venues"
            className="inline-flex items-center gap-1 rounded-md border border-stone-200 bg-white px-2 py-1 text-xs text-stone-400 disabled:cursor-not-allowed"
          >
            <MessageSquare className="h-3 w-3" />
            Send to Slack
          </button>
        </div>
      ) : null}

      {err ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          <AlertCircle className="mr-2 inline h-4 w-4 align-baseline" />
          {err}
        </div>
      ) : null}

      {buildMsg ? (
        <div className="rounded-md border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
          {buildMsg}
        </div>
      ) : null}

      {loading && !latest ? (
        <div className="flex items-center gap-2 text-sm text-stone-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : null}

      {!loading && !latest ? (
        <div className="rounded-md border border-stone-200 bg-white p-8 text-center text-sm text-stone-500">
          <RefreshCw className="mx-auto mb-2 h-5 w-5 text-stone-400" />
          No digest generated yet. Run &quot;Build new digest&quot; to
          produce this week&apos;s narrative.
        </div>
      ) : null}

      {displayDigest ? (
        <article className="rounded-2xl border border-stone-200 bg-white p-6">
          <MarketingDigest
            digest={displayDigest.digest_jsonb}
            periodStart={displayDigest.digest_period_start}
            periodEnd={displayDigest.digest_period_end}
            generatedAt={displayDigest.generated_at}
          />
        </article>
      ) : null}
    </div>
  )
}
