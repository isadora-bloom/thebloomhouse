'use client'

/**
 * 6px-ish colored dot showing recency-vs-recommended-frequency for a
 * metric row. Sage = fresh, amber = overdue, rose = stale-or-never.
 *
 * The colors deliberately match the Bloom palette tokens (sage / gold /
 * rose) rather than the consumer-app green/yellow/red. Editorial
 * restraint.
 */

export type StatusColor = 'sage' | 'amber' | 'rose'

interface Props {
  color: StatusColor
  title?: string
}

const COLOR_CLASS: Record<StatusColor, string> = {
  sage: 'bg-sage-500',
  amber: 'bg-gold-500',
  rose: 'bg-rose-400',
}

const LABEL: Record<StatusColor, string> = {
  sage: 'Captured within the recommended window',
  amber: 'Overdue',
  rose: 'Never captured or very stale',
}

export function StatusDot({ color, title }: Props) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${COLOR_CLASS[color]}`}
      title={title ?? LABEL[color]}
      aria-label={title ?? LABEL[color]}
    />
  )
}
