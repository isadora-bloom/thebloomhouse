'use client'

/**
 * Wave 25 — per-source card on the comparison page.
 *
 * Renders one ChannelComparisonRow with the story-arc mini, Apparent vs
 * Real CAC, and a drill-in button. Every number carries its sample size.
 */

import Link from 'next/link'
import { ArrowRight, TrendingDown, TrendingUp, AlertTriangle } from 'lucide-react'
import type {
  ChannelComparisonRow,
  StoryArcSegment,
} from '@/lib/services/channel-intel-hub/types'

const SEGMENT_LABELS: Record<StoryArcSegment, string> = {
  discovery: 'Discovery',
  inquiry: 'Inquiry',
  validation: 'Validation',
  broadcast: 'Broadcast',
  cross_platform_footprint: 'Cross-plat',
}

const SEGMENT_COLORS: Record<StoryArcSegment, string> = {
  discovery: '#2E7D54',
  inquiry: '#7D8471',
  validation: '#A6894A',
  broadcast: '#B45309',
  cross_platform_footprint: '#78716C',
}

function fmt$(cents: number | null): string {
  if (cents === null) return '—'
  return `$${(cents / 100).toFixed(0)}`
}

function fmtPct(r: number | null): string {
  if (r === null) return '—'
  return `${(r * 100).toFixed(1)}%`
}

interface Props {
  row: ChannelComparisonRow
}

export function ChannelSourceCard({ row }: Props) {
  const cacDelta = row.cac_delta_cents
  const cacDirection: 'good' | 'bad' | 'neutral' =
    cacDelta === null ? 'neutral' : cacDelta < 0 ? 'good' : cacDelta > 0 ? 'bad' : 'neutral'

  return (
    <div className="bg-white border border-stone-200 rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <h3 className="text-lg font-serif text-stone-900">{row.display_name}</h3>
          <p className="text-xs text-stone-500">
            {row.unique_weddings} weddings · {row.ae_total} attribution events
          </p>
        </div>
        {row.v1_contaminated_pct > 0 && (
          <span
            title={`${row.v1_contaminated_pct.toFixed(1)}% of classifications relied on a v1 prompt.`}
            className="text-xs text-amber-700 font-mono flex items-center gap-1"
          >
            <AlertTriangle className="w-3 h-3" />
            *{row.v1_contaminated_pct.toFixed(1)}%
          </span>
        )}
      </div>

      {/* Story arc mini */}
      <div className="grid grid-cols-5 gap-1 mb-4">
        {(
          [
            'discovery',
            'inquiry',
            'validation',
            'broadcast',
            'cross_platform_footprint',
          ] as StoryArcSegment[]
        ).map((seg) => (
          <div key={seg} className="text-center">
            <div
              className="text-base font-semibold leading-tight"
              style={{ color: SEGMENT_COLORS[seg] }}
            >
              {row.story_arc_mini[seg]}
            </div>
            <div className="text-[10px] uppercase tracking-wide text-stone-500">
              {SEGMENT_LABELS[seg]}
            </div>
          </div>
        ))}
      </div>

      {/* Apparent vs Real CAC */}
      <div className="bg-stone-50 rounded-lg p-3 mb-3">
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-stone-600">Apparent CAC</span>
          <span className="font-mono text-stone-900">{fmt$(row.apparent_cac_cents)}</span>
        </div>
        <div className="flex items-baseline justify-between text-xs mt-1">
          <span className="text-stone-600">Real CAC (Discovery+Validation only)</span>
          <span className="font-mono font-semibold text-stone-900">{fmt$(row.real_cac_cents)}</span>
        </div>
        {cacDelta !== null && (
          <div className="mt-2 flex items-center gap-1 text-xs">
            {cacDirection === 'bad' ? (
              <TrendingUp className="w-3 h-3 text-red-700" />
            ) : cacDirection === 'good' ? (
              <TrendingDown className="w-3 h-3 text-emerald-700" />
            ) : null}
            <span
              className={
                cacDirection === 'bad'
                  ? 'text-red-700 font-mono'
                  : cacDirection === 'good'
                    ? 'text-emerald-700 font-mono'
                    : 'text-stone-600 font-mono'
              }
            >
              {cacDelta > 0 ? '+' : ''}
              {fmt$(cacDelta)} forensic correction
            </span>
          </div>
        )}
      </div>

      {/* Conversion / quality */}
      <div className="grid grid-cols-2 gap-3 mb-4 text-xs">
        <div>
          <div className="text-stone-500">Inquiry → Book</div>
          <div className="font-mono text-stone-900">{fmtPct(row.conversion_rate_0_1)}</div>
        </div>
        <div>
          <div className="text-stone-500">Avg review</div>
          <div className="font-mono text-stone-900">
            {row.avg_review_rating !== null
              ? `${row.avg_review_rating}/5 (n=${row.review_count})`
              : '—'}
          </div>
        </div>
      </div>

      <Link
        href={`/intel/channels/${row.channel_slug}`}
        className="inline-flex items-center gap-1 text-sm text-sage-700 hover:text-sage-900 font-medium"
      >
        Drill into {row.display_name}
        <ArrowRight className="w-4 h-4" />
      </Link>
    </div>
  )
}
