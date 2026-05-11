'use client'

/**
 * Wave 25 — Story-arc funnel chart for the per-source page.
 *
 * Renders the five segments (Discovery / Inquiry / Validation / Broadcast
 * / Cross-platform-footprint) as horizontal bars with counts, conversion
 * rates, and v1-contamination flags. Pure presentation; reads the
 * snapshot's story_arc cells.
 */

import type { StoryArcCell, StoryArcSegment } from '@/lib/services/channel-intel-hub/types'

const SEGMENT_LABELS: Record<StoryArcSegment, string> = {
  discovery: 'Discovery',
  inquiry: 'Inquiry',
  validation: 'Validation',
  broadcast: 'Broadcast',
  cross_platform_footprint: 'Cross-platform footprint',
}

const SEGMENT_COLORS: Record<StoryArcSegment, string> = {
  discovery: '#2E7D54',
  inquiry: '#7D8471',
  validation: '#A6894A',
  broadcast: '#B45309',
  cross_platform_footprint: '#78716C',
}

function fmtPct(r: number | null): string {
  if (r === null) return '—'
  return `${(r * 100).toFixed(1)}%`
}

function fmt$(cents: number | null): string {
  if (cents === null) return '—'
  return `$${(cents / 100).toFixed(0)}`
}

interface Props {
  storyArc: StoryArcCell[]
  /** Below this sample size, render the thin-data muted treatment. */
  minSampleSize?: number
}

export function SourceFunnelChart({ storyArc, minSampleSize = 10 }: Props) {
  const maxWeddings = Math.max(1, ...storyArc.map((c) => c.unique_weddings))
  return (
    <div className="bg-white border border-stone-200 rounded-xl p-6 shadow-sm">
      <div className="flex items-baseline justify-between mb-4">
        <h3 className="text-xl font-serif text-stone-900">The story arc</h3>
        <span className="text-xs text-stone-500">
          forensic segmentation · per-cell sample size + v1-contam disclosure
        </span>
      </div>
      <div className="space-y-3">
        {storyArc.map((cell) => {
          const widthPct = (cell.unique_weddings / maxWeddings) * 100
          const thin = cell.unique_weddings < minSampleSize
          return (
            <div
              key={cell.segment}
              className={`relative border rounded-lg p-4 ${
                thin ? 'border-stone-200 opacity-70' : 'border-stone-200'
              }`}
              style={{ background: `${SEGMENT_COLORS[cell.segment]}08` }}
            >
              <div className="flex items-baseline justify-between mb-2">
                <div className="flex items-baseline gap-2">
                  <span
                    className="font-semibold text-stone-900"
                    style={{ color: SEGMENT_COLORS[cell.segment] }}
                  >
                    {SEGMENT_LABELS[cell.segment]}
                  </span>
                  <span className="text-xs uppercase tracking-wide text-stone-500">
                    n={cell.unique_weddings} {thin ? '(thin)' : ''}
                  </span>
                  {cell.v1_contaminated_pct > 0 && (
                    <span
                      title={`${cell.v1_contaminated_pct.toFixed(1)}% of this cell's classifications were under a v1 prompt.`}
                      className="text-xs text-amber-700 font-mono"
                    >
                      *{cell.v1_contaminated_pct.toFixed(1)}%
                    </span>
                  )}
                </div>
                <div className="text-xs text-stone-600 space-x-3">
                  <span>
                    tour: <strong className="text-stone-900">{fmtPct(cell.conversion_to_tour_rate_0_1)}</strong>
                  </span>
                  <span>
                    booked: <strong className="text-stone-900">{fmtPct(cell.conversion_to_booked_rate_0_1)}</strong>
                  </span>
                  <span>
                    avg value: <strong className="text-stone-900">{fmt$(cell.avg_booking_value_cents)}</strong>
                  </span>
                </div>
              </div>
              <div className="h-2 bg-stone-100 rounded overflow-hidden">
                <div
                  className="h-full rounded"
                  style={{
                    width: `${widthPct}%`,
                    background: SEGMENT_COLORS[cell.segment],
                  }}
                />
              </div>
              <p className="mt-2 text-xs text-stone-500 leading-relaxed">
                {cell.annotation}
              </p>
            </div>
          )
        })}
      </div>
      <p className="mt-3 text-xs text-stone-400 italic">
        * v1-contaminated pct flags rows classified under bias-suspect prompt versions
        (see PROMPT-BIAS-AUDIT.md). Re-run the reclassify-v1 sweep for clean numbers.
      </p>
    </div>
  )
}
