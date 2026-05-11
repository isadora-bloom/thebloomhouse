/**
 * LifecycleStageChip — single primitive for rendering the canonical
 * 13-stage lifecycle label.
 *
 * Wave 11 (Migration 278). Reusable across:
 *   - /agent/leads (column)
 *   - /intel/clients/[id] (header)
 *   - /agent/pipeline (card chip)
 *   - lifecycle audit timeline
 *
 * Variants:
 *   - 'pill' (default) — colored pill with stage label
 *   - 'dot'            — 2.5x2.5 colored dot, dense grids
 *   - 'inline'         — colored label only, no pill background
 */

import type { LifecycleStage } from '@/lib/services/lifecycle/state-machine'

export type LifecycleChipVariant = 'pill' | 'dot' | 'inline'

export interface LifecycleStageChipProps {
  stage: LifecycleStage | string | null | undefined
  variant?: LifecycleChipVariant
  className?: string
  title?: string
}

interface StageStyle {
  label: string
  /** Full pill bg + text class string. */
  pill: string
  /** Dot bg class. */
  dot: string
  /** Inline text color class. */
  text: string
}

// One source of truth for stage colors. Keep them muted — the chip
// is informational, not call-to-action.
const STAGE_STYLES: Record<LifecycleStage, StageStyle> = {
  pre_touch: {
    label: 'Pre-touch',
    pill: 'bg-slate-100 text-slate-600',
    dot: 'bg-slate-400',
    text: 'text-slate-600',
  },
  first_touch: {
    label: 'First touch',
    pill: 'bg-blue-50 text-blue-700',
    dot: 'bg-blue-400',
    text: 'text-blue-700',
  },
  nurture: {
    label: 'Nurture',
    pill: 'bg-indigo-50 text-indigo-700',
    dot: 'bg-indigo-400',
    text: 'text-indigo-700',
  },
  tour_scheduled: {
    label: 'Tour scheduled',
    pill: 'bg-amber-50 text-amber-800',
    dot: 'bg-amber-400',
    text: 'text-amber-800',
  },
  tour_completed: {
    label: 'Tour completed',
    pill: 'bg-orange-50 text-orange-800',
    dot: 'bg-orange-400',
    text: 'text-orange-800',
  },
  proposal_active: {
    label: 'Proposal',
    pill: 'bg-yellow-50 text-yellow-800',
    dot: 'bg-yellow-500',
    text: 'text-yellow-800',
  },
  booked: {
    label: 'Booked',
    pill: 'bg-emerald-50 text-emerald-800',
    dot: 'bg-emerald-500',
    text: 'text-emerald-800',
  },
  planning_active: {
    label: 'Planning',
    pill: 'bg-teal-50 text-teal-800',
    dot: 'bg-teal-500',
    text: 'text-teal-800',
  },
  day_of: {
    label: 'Day-of',
    pill: 'bg-fuchsia-50 text-fuchsia-800',
    dot: 'bg-fuchsia-500',
    text: 'text-fuchsia-800',
  },
  post_event: {
    label: 'Post-event',
    pill: 'bg-purple-50 text-purple-800',
    dot: 'bg-purple-500',
    text: 'text-purple-800',
  },
  long_tail: {
    label: 'Long tail',
    pill: 'bg-violet-50 text-violet-800',
    dot: 'bg-violet-500',
    text: 'text-violet-800',
  },
  lost: {
    label: 'Lost',
    pill: 'bg-rose-50 text-rose-800',
    dot: 'bg-rose-500',
    text: 'text-rose-800',
  },
  cancelled: {
    label: 'Cancelled',
    pill: 'bg-stone-100 text-stone-700',
    dot: 'bg-stone-500',
    text: 'text-stone-700',
  },
}

const UNKNOWN_STYLE: StageStyle = {
  label: 'Unknown',
  pill: 'bg-gray-100 text-gray-500',
  dot: 'bg-gray-400',
  text: 'text-gray-500',
}

function styleFor(stage: string | null | undefined): StageStyle {
  if (!stage) return UNKNOWN_STYLE
  return (
    (STAGE_STYLES as Record<string, StageStyle>)[stage] ?? UNKNOWN_STYLE
  )
}

export function LifecycleStageChip({
  stage,
  variant = 'pill',
  className,
  title,
}: LifecycleStageChipProps) {
  const style = styleFor(stage ?? null)
  const ttl = title ?? style.label

  if (variant === 'dot') {
    return (
      <span
        className={`inline-block w-2.5 h-2.5 rounded-full ${style.dot} ${className ?? ''}`}
        title={ttl}
      />
    )
  }

  if (variant === 'inline') {
    return (
      <span
        className={`inline text-sm font-medium ${style.text} ${className ?? ''}`}
        title={ttl}
      >
        {style.label}
      </span>
    )
  }

  // pill
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${style.pill} ${className ?? ''}`}
      title={ttl}
    >
      {style.label}
    </span>
  )
}
