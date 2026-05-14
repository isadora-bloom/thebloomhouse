'use client'

/**
 * Wave 25 — Channel Intelligence Hub comparison page.
 *
 * Anchor docs:
 *   - feedback_measure_dont_assume.md
 *   - feedback_self_reported_sources_not_truth.md
 *   - feedback_deep_fix_vs_bandaid.md
 *
 * Lists every channel with > 10 AE rows for the venue, side-by-side.
 * Each card shows the mini story-arc + Apparent vs Real CAC + the
 * forensic correction. Drill into a card opens the per-source deep dive.
 *
 * This page supersedes the UX of /intel/sources but does not delete it
 * (kept as compat).
 */

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft,
  RefreshCw,
  Filter,
  Compass,
  Megaphone,
  AlertCircle,
} from 'lucide-react'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { ChannelSourceCard } from '@/components/intel/ChannelSourceCard'
import type { ChannelComparisonPayload } from '@/lib/services/channel-intel-hub/types'

type WindowDays = 30 | 90 | 365
type SortKey = 'volume' | 'real_cac' | 'quality' | 'conversion' | 'correction'

const WINDOW_OPTIONS: Array<{ value: WindowDays; label: string }> = [
  { value: 30, label: 'Last 30 days' },
  { value: 90, label: 'Last 90 days' },
  { value: 365, label: 'Last 12 months' },
]

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: 'volume', label: 'Volume (most weddings)' },
  { value: 'real_cac', label: 'Lowest Real CAC' },
  { value: 'correction', label: 'Largest forensic correction' },
  { value: 'conversion', label: 'Highest conversion' },
  { value: 'quality', label: 'Best review rating' },
]

export default function ChannelIntelHubPage() {
  const venueId = useVenueId()
  const [windowDays, setWindowDays] = useState<WindowDays>(90)
  const [sort, setSort] = useState<SortKey>('volume')
  const [payload, setPayload] = useState<ChannelComparisonPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load(force: boolean = false) {
    if (!venueId) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/admin/intel/channels/list?venueId=${venueId}&windowDays=${windowDays}${force ? '&force=1' : ''}`,
      )
      const json = (await res.json()) as ChannelComparisonPayload
      if (!res.ok || !json.ok) {
        setError(json.error ?? `HTTP ${res.status}`)
        return
      }
      setPayload(json)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueId, windowDays])

  const sortedRows = useMemo(() => {
    if (!payload) return []
    const rows = [...payload.rows]
    switch (sort) {
      case 'volume':
        rows.sort((a, b) => b.unique_weddings - a.unique_weddings)
        break
      case 'real_cac':
        rows.sort((a, b) => {
          if (a.real_cac_cents === null) return 1
          if (b.real_cac_cents === null) return -1
          return a.real_cac_cents - b.real_cac_cents
        })
        break
      case 'correction':
        rows.sort((a, b) => {
          const aDelta = Math.abs(a.cac_delta_cents ?? 0)
          const bDelta = Math.abs(b.cac_delta_cents ?? 0)
          return bDelta - aDelta
        })
        break
      case 'conversion':
        rows.sort((a, b) => (b.conversion_rate_0_1 ?? 0) - (a.conversion_rate_0_1 ?? 0))
        break
      case 'quality':
        rows.sort((a, b) => (b.avg_review_rating ?? 0) - (a.avg_review_rating ?? 0))
        break
    }
    return rows
  }, [payload, sort])

  // Largest-CAC-correction callouts
  const callouts = useMemo(() => {
    if (!payload) return []
    const sorted = [...payload.rows]
      .filter((r) => r.cac_delta_cents !== null)
      .sort((a, b) => Math.abs(b.cac_delta_cents ?? 0) - Math.abs(a.cac_delta_cents ?? 0))
      .slice(0, 3)
    return sorted
  }, [payload])

  return (
    <div className="p-8 max-w-7xl mx-auto">
      {/* Hero */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-stone-500 mb-2">
            <Compass className="w-3 h-3" />
            Channel Intelligence Hub
          </div>
          <h1 className="text-3xl font-serif text-stone-900 mb-2">Channel intelligence</h1>
          <p className="text-stone-600 max-w-3xl">
            One forensic readout per channel. Discovery / Inquiry / Validation /
            Broadcast / Cross-platform-footprint story arc, Real vs Apparent CAC,
            quality signals. Every number carries its sample size + prompt-version
            disclosure. Drill into a card for the deep dive.
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <Link
              href="/intel/sources"
              className="text-sage-700 hover:text-sage-900 underline underline-offset-2"
            >
              Legacy: Sources &amp; ROI
            </Link>
            <span className="text-stone-400">·</span>
            <Link
              href="/intel/marketing-roi"
              className="text-sage-700 hover:text-sage-900 underline underline-offset-2"
            >
              Legacy: Marketing ROI
            </Link>
            <span className="text-stone-400">·</span>
            <Link
              href="/admin/attribution/roles"
              className="text-sage-700 hover:text-sage-900 underline underline-offset-2"
            >
              Power tool: Role &amp; Intent audit
            </Link>
            <span className="text-stone-400">·</span>
            <Link
              href="/intel/channel-truth"
              className="text-sage-700 hover:text-sage-900 underline underline-offset-2"
            >
              Channel Truth audit
            </Link>
          </div>
        </div>
        <button
          onClick={() => load(true)}
          disabled={loading || !venueId}
          className="inline-flex items-center gap-2 px-4 py-2 bg-sage-600 text-white rounded-md hover:bg-sage-700 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Controls */}
      <div className="bg-white border border-stone-200 rounded-xl p-4 mb-6 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-stone-500">Window</span>
          <div className="flex gap-1">
            {WINDOW_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setWindowDays(opt.value)}
                className={`px-3 py-1 rounded text-sm ${
                  windowDays === opt.value
                    ? 'bg-stone-800 text-white'
                    : 'bg-stone-100 text-stone-700 hover:bg-stone-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-stone-500" />
          <span className="text-xs uppercase tracking-wide text-stone-500">Sort</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="bg-white border border-stone-200 rounded px-2 py-1 text-sm"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        {payload && (
          <div className="ml-auto text-xs text-stone-500">
            {payload.total_channels_with_data} channels with &gt;=10 AE ·{' '}
            <span className="text-stone-700">computed {payload.computed_at_iso}</span>
          </div>
        )}
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-700 mt-0.5" />
          <div className="text-sm text-red-800">{error}</div>
        </div>
      )}

      {/* Cross-channel callouts */}
      {callouts.length > 0 && (
        <div className="mb-6 bg-amber-50 border border-amber-200 rounded-xl p-5">
          <h2 className="font-serif text-amber-900 text-lg mb-3 flex items-center gap-2">
            <Megaphone className="w-5 h-5" />
            Cross-channel forensic corrections
          </h2>
          <ul className="space-y-2 text-sm text-amber-900">
            {callouts.map((row) => {
              const apparent = row.apparent_cac_cents
              const real = row.real_cac_cents
              const delta = row.cac_delta_cents
              if (apparent === null || real === null || delta === null) return null
              return (
                <li key={row.channel_slug}>
                  <strong>{row.display_name}</strong>: apparent CAC{' '}
                  <span className="font-mono">${(apparent / 100).toFixed(0)}</span> →
                  real CAC{' '}
                  <span className="font-mono">${(real / 100).toFixed(0)}</span>{' '}
                  ({delta > 0 ? '+' : ''}
                  <span className="font-mono">${(delta / 100).toFixed(0)}</span> correction).
                  Forensic discount applied: broadcast +{' '}
                  <span className="font-semibold">
                    {row.story_arc_mini.broadcast}
                  </span>{' '}
                  rows; cross-platform-footprint +{' '}
                  <span className="font-semibold">
                    {row.story_arc_mini.cross_platform_footprint}
                  </span>{' '}
                  rows.
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* Card grid */}
      {loading && !payload && (
        <div className="text-stone-500">Loading channel snapshots…</div>
      )}
      {payload && sortedRows.length === 0 && !loading && (
        <div className="bg-white border border-stone-200 rounded-xl p-8 text-center text-stone-500">
          No channels with &gt;=10 attribution events in this window. Try a longer window.
        </div>
      )}
      {sortedRows.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {sortedRows.map((row) => (
            <ChannelSourceCard key={row.channel_slug} row={row} />
          ))}
        </div>
      )}

      {/* Calibration footer */}
      {payload && (
        <div className="mt-8 bg-stone-50 border border-stone-200 rounded p-4 text-xs text-stone-600">
          <strong className="text-stone-800">Calibration:</strong>{' '}
          Snapshots are deterministic, computed from auto-attributed first-touch rows,
          weddings, marketing spend, reviews, and reconstructed couple intel.
          Forensic Discovery / Validation / Broadcast / Cross-platform-footprint
          segmentation uses each channel&apos;s role and intent. Real CAC excludes
          broadcast intent and cross-platform-footprint wide-AI-reviewed rows.
          Asterisks flag rows classified under earlier prompts that may be biased.
        </div>
      )}

      <div className="mt-6">
        <Link
          href="/intel"
          className="inline-flex items-center gap-1 text-sm text-stone-600 hover:text-stone-900"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Intel
        </Link>
      </div>
    </div>
  )
}
