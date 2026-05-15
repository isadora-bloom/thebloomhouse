'use client'

/**
 * SVG journey ribbon.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §6. Renders every touchpoint
 * for one couple as a single horizontal SVG ribbon timeline.
 *
 * §6 Don't skip (every item enforced below):
 *   1. NOT a vertical list. Rendered as SVG with proportional time
 *      spacing.
 *   2. NOT logarithmic time. Linear. Long quiet stretches stay long.
 *   3. Action chip is mandatory — surfaced as a separate component
 *      (JourneyActionChip) consumed by the page.
 *   4. Confidence styling: High = solid, Medium = ring, Low = dashed
 *      ring.
 *
 * Density clustering
 * ------------------
 * Doctrine: "auto-cluster adjacent touchpoints into burst markers
 * with count badges ('12 touches in 48h'), expandable inline." We
 * cluster touchpoints whose x-pixel positions overlap within 12px
 * of any sibling; the cluster renders as a rounded badge with the
 * count and expands on click into a popover stack.
 *
 * Gap labels
 * ----------
 * Doctrine: "Hover any gap to see silence duration." Gaps over 14
 * days between consecutive touchpoints get a faint vertical tick
 * with a tooltip showing the duration.
 */

import { useMemo, useRef, useState } from 'react'

export interface JourneyTouchpoint {
  id: string
  channel: string
  signal_tier: string
  action_type: string
  occurred_at: string
  confidence_tier: string | null
  raw_payload: Record<string, unknown> | null
}

interface JourneyRibbonProps {
  touchpoints: JourneyTouchpoint[]
  height?: number
  rightPaddingDays?: number
  onTouchpointClick?: (t: JourneyTouchpoint) => void
}

interface PositionedTouchpoint extends JourneyTouchpoint {
  x: number
}

interface Cluster {
  members: PositionedTouchpoint[]
  x: number
}

const CLUSTER_PX = 12
const GAP_DAYS_THRESHOLD = 14

function channelColor(channel: string): string {
  const c = channel.toLowerCase()
  if (c === 'gmail' || c.includes('email')) return '#e11d48'
  if (c === 'calendly') return '#0284c7'
  if (c === 'knot' || c === 'theknot') return '#db2777'
  if (c === 'weddingwire') return '#d97706'
  if (c === 'instagram') return '#7c3aed'
  if (c === 'pinterest') return '#dc2626'
  if (c === 'website') return '#059669'
  if (c === 'phone' || c === 'openphone' || c === 'sms') return '#047857'
  if (c === 'honeybook') return '#9333ea'
  return '#57534e'
}

function dotStyle(confidence: string | null, tier: string): {
  fill: string
  stroke: string
  strokeWidth: number
  strokeDasharray?: string
  opacity: number
} {
  // §6 Don't skip #4. High = solid, Medium = ring, Low = dashed ring.
  const c = (confidence ?? tier ?? '').toLowerCase()
  if (c === 'high' || c === 'highest' || c === 'operator_confirmed') {
    return { fill: 'currentColor', stroke: 'currentColor', strokeWidth: 0, opacity: 1 }
  }
  if (c === 'medium' || c === 'medium_high') {
    return { fill: 'white', stroke: 'currentColor', strokeWidth: 2, opacity: 0.95 }
  }
  // low / unknown / aggregate_only
  return {
    fill: 'white',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeDasharray: '2 2',
    opacity: 0.7,
  }
}

function formatDuration(ms: number): string {
  const days = Math.round(ms / 86_400_000)
  if (days < 30) return `${days} days`
  const months = Math.round(days / 30)
  if (months < 12) return `${months} months`
  const years = (days / 365).toFixed(1)
  return `${years} years`
}

function actionLabel(action: string): string {
  return action.replace(/_/g, ' ')
}

export function JourneyRibbon({
  touchpoints,
  height = 64,
  rightPaddingDays = 30,
  onTouchpointClick,
}: JourneyRibbonProps) {
  const ribbonRef = useRef<SVGSVGElement>(null)
  const [expandedClusterIdx, setExpandedClusterIdx] = useState<number | null>(null)
  const [hover, setHover] = useState<
    | { kind: 'dot'; tp: PositionedTouchpoint }
    | { kind: 'gap'; left: PositionedTouchpoint; right: PositionedTouchpoint }
    | null
  >(null)

  const { positioned, clusters, span, totalWidth, gaps } = useMemo(() => {
    if (touchpoints.length === 0) {
      return {
        positioned: [] as PositionedTouchpoint[],
        clusters: [] as Cluster[],
        span: 0,
        totalWidth: 800,
        gaps: [] as Array<{ left: PositionedTouchpoint; right: PositionedTouchpoint }>,
      }
    }
    const sorted = [...touchpoints].sort(
      (a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at),
    )
    const firstMs = Date.parse(sorted[0]!.occurred_at)
    const lastMs = Date.parse(sorted[sorted.length - 1]!.occurred_at)
    const rightPaddingMs = rightPaddingDays * 86_400_000
    const totalSpan = lastMs - firstMs + rightPaddingMs
    // Width: 800px standard; the parent container wraps in a
    // responsive div and SVG scales via viewBox.
    const width = 800
    const left = 32
    const right = 32
    const usable = width - left - right

    const positioned: PositionedTouchpoint[] = sorted.map((t) => {
      const ms = Date.parse(t.occurred_at) - firstMs
      const x = totalSpan > 0 ? left + (ms / totalSpan) * usable : left
      return { ...t, x }
    })

    // Density clustering: walk left to right, merge any dot within
    // CLUSTER_PX of the prior cluster's right edge.
    const clusters: Cluster[] = []
    for (const tp of positioned) {
      const last = clusters[clusters.length - 1]
      if (last && Math.abs(tp.x - last.x) <= CLUSTER_PX) {
        last.members.push(tp)
        // Cluster x: arithmetic mean keeps the burst centered.
        last.x = last.members.reduce((s, m) => s + m.x, 0) / last.members.length
      } else {
        clusters.push({ members: [tp], x: tp.x })
      }
    }

    // Gaps over the threshold between consecutive single touchpoints
    // (or between cluster centroids) earn a vertical tick.
    const gaps: Array<{ left: PositionedTouchpoint; right: PositionedTouchpoint }> = []
    for (let i = 0; i < positioned.length - 1; i++) {
      const a = positioned[i]!
      const b = positioned[i + 1]!
      const diff = Date.parse(b.occurred_at) - Date.parse(a.occurred_at)
      if (diff > GAP_DAYS_THRESHOLD * 86_400_000) {
        gaps.push({ left: a, right: b })
      }
    }

    return {
      positioned,
      clusters,
      span: totalSpan,
      totalWidth: width,
      gaps,
    }
  }, [touchpoints, rightPaddingDays])

  if (touchpoints.length === 0) {
    return (
      <div className="flex h-16 items-center justify-center rounded-md border border-dashed border-stone-200 bg-stone-50/60 text-xs text-stone-500">
        No touchpoints yet.
      </div>
    )
  }

  const baselineY = height / 2

  return (
    <div className="relative">
      <svg
        ref={ribbonRef}
        viewBox={`0 0 ${totalWidth} ${height}`}
        className="block h-16 w-full"
        preserveAspectRatio="none"
      >
        <line
          x1={0}
          x2={totalWidth}
          y1={baselineY}
          y2={baselineY}
          stroke="#e7e5e4"
          strokeWidth={1}
        />

        {/* gap ticks */}
        {gaps.map((g, i) => {
          const mid = (g.left.x + g.right.x) / 2
          return (
            <g
              key={`gap-${i}`}
              onMouseEnter={() => setHover({ kind: 'gap', left: g.left, right: g.right })}
              onMouseLeave={() => setHover(null)}
            >
              <line
                x1={mid}
                x2={mid}
                y1={baselineY - 4}
                y2={baselineY + 4}
                stroke="#a8a29e"
                strokeWidth={1}
                strokeDasharray="1 2"
              />
            </g>
          )
        })}

        {/* clusters + dots */}
        {clusters.map((cluster, i) => {
          if (cluster.members.length === 1) {
            const t = cluster.members[0]!
            const style = dotStyle(t.confidence_tier, t.signal_tier)
            const color = channelColor(t.channel)
            return (
              <g
                key={t.id}
                style={{ color, cursor: 'pointer' }}
                onMouseEnter={() => setHover({ kind: 'dot', tp: t })}
                onMouseLeave={() => setHover(null)}
                onClick={() => onTouchpointClick?.(t)}
              >
                <circle
                  cx={t.x}
                  cy={baselineY}
                  r={6}
                  fill={style.fill === 'currentColor' ? color : style.fill}
                  stroke={style.stroke === 'currentColor' ? color : style.stroke}
                  strokeWidth={style.strokeWidth}
                  strokeDasharray={style.strokeDasharray}
                  opacity={style.opacity}
                />
              </g>
            )
          }
          // multi-member cluster: render as a rounded badge.
          const color = channelColor(cluster.members[0]!.channel)
          return (
            <g
              key={`cluster-${i}`}
              style={{ color, cursor: 'pointer' }}
              onClick={() =>
                setExpandedClusterIdx((idx) => (idx === i ? null : i))
              }
              onMouseEnter={() =>
                setHover({ kind: 'dot', tp: cluster.members[0]! })
              }
              onMouseLeave={() => setHover(null)}
            >
              <rect
                x={cluster.x - 12}
                y={baselineY - 9}
                width={24}
                height={18}
                rx={9}
                fill={color}
                opacity={0.92}
              />
              <text
                x={cluster.x}
                y={baselineY + 4}
                fontSize={10}
                fontWeight={600}
                textAnchor="middle"
                fill="white"
              >
                {cluster.members.length}
              </text>
            </g>
          )
        })}
      </svg>

      {/* hover tooltips */}
      {hover && hover.kind === 'dot' && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border border-stone-200 bg-white px-2 py-1 text-xs shadow-md"
          style={{
            left: `${(hover.tp.x / totalWidth) * 100}%`,
            top: 0,
          }}
        >
          <div className="font-medium text-stone-800">
            {actionLabel(hover.tp.action_type)}
          </div>
          <div className="text-stone-500">
            {hover.tp.channel} · {new Date(hover.tp.occurred_at).toLocaleDateString()}
          </div>
          <div className="text-[10px] text-stone-400">
            tier {hover.tp.signal_tier}
            {hover.tp.confidence_tier && ` · conf ${hover.tp.confidence_tier}`}
          </div>
        </div>
      )}
      {hover && hover.kind === 'gap' && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border border-stone-200 bg-stone-900 px-2 py-1 text-xs text-white shadow-md"
          style={{
            left: `${((hover.left.x + hover.right.x) / 2 / totalWidth) * 100}%`,
            top: 0,
          }}
        >
          {formatDuration(
            Date.parse(hover.right.occurred_at) - Date.parse(hover.left.occurred_at),
          )}{' '}
          quiet
        </div>
      )}

      {/* expanded cluster popover */}
      {expandedClusterIdx !== null && clusters[expandedClusterIdx] && (
        <div
          className="absolute z-20 -translate-x-1/2 translate-y-2 rounded-md border border-stone-200 bg-white p-2 shadow-lg"
          style={{
            left: `${(clusters[expandedClusterIdx]!.x / totalWidth) * 100}%`,
            top: height,
            minWidth: 240,
          }}
        >
          <div className="mb-1 flex items-center justify-between text-xs text-stone-600">
            <span>{clusters[expandedClusterIdx]!.members.length} touches in burst</span>
            <button
              onClick={() => setExpandedClusterIdx(null)}
              className="text-stone-400 hover:text-stone-700"
            >
              ×
            </button>
          </div>
          <ul className="space-y-1 text-xs">
            {clusters[expandedClusterIdx]!.members.map((m) => (
              <li
                key={m.id}
                className="flex items-center gap-2"
                onClick={() => onTouchpointClick?.(m)}
              >
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: channelColor(m.channel) }}
                />
                <span className="font-medium text-stone-800">
                  {actionLabel(m.action_type)}
                </span>
                <span className="text-stone-500">{m.channel}</span>
                <span className="ml-auto text-stone-400">
                  {new Date(m.occurred_at).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                  })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* span label */}
      <div className="mt-1 flex items-center justify-between text-[10px] text-stone-400">
        <span>
          {touchpoints[0]
            ? new Date(touchpoints[0].occurred_at).toLocaleDateString()
            : ''}
        </span>
        <span>{formatDuration(span)} span</span>
        <span>now</span>
      </div>
    </div>
  )
}
