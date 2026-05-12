'use client'

/**
 * One platform card on /intel/social-integration. Renders the platform
 * header (icon + name) + one row per metric, each with last-captured
 * recency, recommended frequency, status dot, and a [Capture Now] button
 * or "Coming soon" pill.
 *
 * V1 only Instagram/new_followers triggers the live capture modal; the
 * rest render in a disabled state with a tooltip.
 */

import { Camera, Music2, Users as FacebookIcon, PinIcon } from 'lucide-react'
import { StatusDot, type StatusColor } from './StatusDot'

export interface MetricDef {
  metric_type: string
  label: string
  recommendedFrequency: string
  /** When true, the [Capture Now] button is live; false renders as
   *  "Coming soon" + disabled. V1 only flips this for Instagram /
   *  new_followers. */
  functional: boolean
  /** When true, this metric is auto-synced via API and shows an
   *  "auto-sync" pill instead of [Capture Now]. None of these are
   *  live in V1; the flag is forward-compat. */
  autoSync?: boolean
}

export interface PlatformDef {
  key: 'instagram' | 'tiktok' | 'facebook' | 'pinterest'
  name: string
  icon: 'instagram' | 'tiktok' | 'facebook' | 'pinterest'
  metrics: MetricDef[]
}

export interface MetricState {
  last_captured_at: string | null
  status_color: StatusColor
  total_handles?: number | null
  matched_count?: number | null
}

interface Props {
  platform: PlatformDef
  /** Map from metric_type to its captured state. Missing entries
   *  default to "Never". */
  stateByMetric: Map<string, MetricState>
  onCapture: (platform: PlatformDef['key'], metricType: string) => void
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'Never'
  const then = new Date(iso).getTime()
  const now = Date.now()
  const diffMs = now - then
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`
  const weeks = Math.floor(days / 7)
  if (weeks === 1) return 'A week ago'
  if (weeks < 5) return `${weeks} weeks ago`
  const months = Math.floor(days / 30)
  if (months === 1) return 'A month ago'
  return `${months} months ago`
}

function PlatformIcon({ kind }: { kind: PlatformDef['icon'] }) {
  const className = 'h-5 w-5 text-sage-700'
  switch (kind) {
    case 'instagram':
      return <Camera className={className} />
    case 'tiktok':
      return <Music2 className={className} />
    case 'facebook':
      return <FacebookIcon className={className} />
    case 'pinterest':
      return <PinIcon className={className} />
  }
}

export function PlatformCard({ platform, stateByMetric, onCapture }: Props) {
  return (
    <section className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
      <header className="flex items-center gap-3 border-b border-stone-100 pb-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sage-50">
          <PlatformIcon kind={platform.icon} />
        </div>
        <h2 className="font-serif text-xl text-stone-900">{platform.name}</h2>
      </header>

      <ul className="mt-3 divide-y divide-stone-100">
        {platform.metrics.map((metric) => {
          const state = stateByMetric.get(metric.metric_type) ?? null
          const dot: StatusColor = state?.status_color ?? 'rose'
          const lastLabel = formatRelative(state?.last_captured_at ?? null)
          return (
            <li
              key={metric.metric_type}
              className="grid grid-cols-1 gap-3 py-3 sm:grid-cols-[1fr_auto] sm:items-center"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <StatusDot color={dot} />
                  <h3 className="text-sm font-medium text-stone-800">
                    {metric.label}
                  </h3>
                  {!metric.functional ? (
                    <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-stone-500">
                      Coming soon
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-xs text-stone-500">
                  Last captured {lastLabel} ·{' '}
                  {metric.recommendedFrequency} recommended
                  {state?.total_handles
                    ? ` · ${state.total_handles} handles, ${
                        state.matched_count ?? 0
                      } matched`
                    : ''}
                </p>
              </div>

              <div className="flex justify-end">
                {metric.autoSync ? (
                  <span className="rounded-full bg-teal-50 px-3 py-1 text-xs text-teal-700">
                    Auto-sync
                  </span>
                ) : metric.functional ? (
                  <button
                    type="button"
                    onClick={() => onCapture(platform.key, metric.metric_type)}
                    className="rounded-md bg-sage-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-sage-700"
                  >
                    Capture now
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled
                    title="Coming soon"
                    className="cursor-not-allowed rounded-md bg-stone-100 px-3 py-1.5 text-xs font-medium text-stone-400"
                  >
                    Capture now
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
