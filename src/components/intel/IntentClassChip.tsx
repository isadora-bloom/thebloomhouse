/**
 * Wave 16 — Intent class chip.
 *
 * Anchor docs:
 *   - bloom-constitution.md
 *
 * Visual marker for one attribution_event's inquiry intent. Used in
 * the channel-role audit table and (future) anywhere a list shows
 * attribution events. Pure presentational; pairs with the role chip
 * to communicate the orthogonal forensic dimensions at a glance.
 *
 * Color discipline mirrors role chip tones — greens for "good" (real
 * targeted acquisition), orange for "platform-pushed" (broadcast),
 * yellow for validation, stone for unknown. Keeps cognitive load low
 * when both chips appear on the same row.
 */

'use client'

import { Megaphone, Crosshair, FileQuestion, Check } from 'lucide-react'

export type IntentClass = 'targeted' | 'broadcast' | 'validation' | 'unknown'

interface IntentClassChipProps {
  intentClass: IntentClass | string | null | undefined
  /** Optional templateScore — when present and intent='broadcast' or near it, surfaces via title tooltip. */
  templateScore?: number | null
  /** Tooltip override; defaults to a short explanation by intent. */
  title?: string
  size?: 'sm' | 'md'
}

const TONE_BY_INTENT: Record<IntentClass, { bg: string; text: string; ring: string; label: string }> = {
  targeted: {
    bg: 'bg-emerald-50',
    text: 'text-emerald-800',
    ring: 'ring-emerald-200',
    label: 'targeted',
  },
  broadcast: {
    bg: 'bg-orange-50',
    text: 'text-orange-800',
    ring: 'ring-orange-200',
    label: 'broadcast',
  },
  validation: {
    bg: 'bg-yellow-50',
    text: 'text-yellow-800',
    ring: 'ring-yellow-200',
    label: 'validation',
  },
  unknown: {
    bg: 'bg-stone-100',
    text: 'text-stone-600',
    ring: 'ring-stone-200',
    label: 'unknown',
  },
}

const DEFAULT_TITLE: Record<IntentClass, string> = {
  targeted: 'Couple actively chose this venue (personalised inquiry or post-inquiry engagement)',
  broadcast:
    'Platform auto-distributed via "Inquire to similar venues" — couple did not actively select us',
  validation: 'Couple discovered the venue elsewhere; this channel was the intake form',
  unknown: 'Intent not yet classified, or platform is not broadcast-capable',
}

function iconFor(intent: IntentClass) {
  switch (intent) {
    case 'targeted':
      return Crosshair
    case 'broadcast':
      return Megaphone
    case 'validation':
      return Check
    case 'unknown':
    default:
      return FileQuestion
  }
}

export function IntentClassChip({
  intentClass,
  templateScore,
  title,
  size = 'sm',
}: IntentClassChipProps) {
  // Normalise the incoming value; default to 'unknown' for anything off-spec.
  const normalised: IntentClass =
    intentClass === 'targeted' ||
    intentClass === 'broadcast' ||
    intentClass === 'validation' ||
    intentClass === 'unknown'
      ? intentClass
      : 'unknown'
  const tone = TONE_BY_INTENT[normalised]
  const Icon = iconFor(normalised)

  // Tooltip: title prop wins; otherwise default by intent, optionally
  // appended with templateScore when broadcast.
  let tooltip = title ?? DEFAULT_TITLE[normalised]
  if (normalised === 'broadcast' && typeof templateScore === 'number') {
    tooltip = `${tooltip} (templateScore=${Math.round(templateScore)}/100)`
  }

  const sizeClasses =
    size === 'md'
      ? 'text-xs px-2.5 py-1 gap-1.5'
      : 'text-[10px] px-2 py-0.5 gap-1'
  const iconSize = size === 'md' ? 'w-3.5 h-3.5' : 'w-3 h-3'

  return (
    <span
      title={tooltip}
      className={`inline-flex items-center rounded-full ring-1 font-medium ${tone.bg} ${tone.text} ${tone.ring} ${sizeClasses}`}
    >
      <Icon className={iconSize} />
      {tone.label}
    </span>
  )
}
