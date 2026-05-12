/**
 * Brand-aligned status indicators.
 *
 * Replaces the generic green/amber/red round-dot pattern that every
 * AI-built dashboard uses. Tones are pulled from the Bloom House
 * palette so the indicator system reads as part of the brand rather
 * than imported from a Tailwind tutorial.
 *
 * Three semantic levels:
 *   - "good"     → sage-700 (#5a6051) on warm-white halo
 *   - "warn"     → gold-600 (#a6894a) — same as brand accent
 *   - "alert"    → rose-700 (#9c4a4a) — muted, on-palette, not Material red
 *   - "neutral"  → slate-400 — for inactive / unknown states
 *
 * Shape is a small organic teardrop instead of a perfect circle so it
 * echoes the thumbprint mark's hand-drawn line work. Use the `dot`
 * variant for tight spaces where the teardrop reads as a smudge.
 */

import type { SVGProps } from 'react'

export type StatusLevel = 'good' | 'warn' | 'alert' | 'neutral'

const COLOR: Record<StatusLevel, string> = {
  good: '#5a6051',
  warn: '#a6894a',
  alert: '#9c4a4a',
  neutral: '#94a3b8',
}

interface StatusIndicatorProps extends SVGProps<SVGSVGElement> {
  level: StatusLevel
  variant?: 'teardrop' | 'dot' | 'glyph'
  className?: string
}

export function StatusIndicator({
  level,
  variant = 'teardrop',
  className = '',
  ...rest
}: StatusIndicatorProps) {
  const fill = COLOR[level]
  if (variant === 'dot') {
    return (
      <svg
        viewBox="0 0 12 12"
        width="12"
        height="12"
        className={className}
        aria-hidden
        {...rest}
      >
        <circle cx="6" cy="6" r="3.5" fill={fill} />
      </svg>
    )
  }
  if (variant === 'glyph') {
    // Two short brush-strokes — works as a tiny KPI status next to a
    // metric without the perfect-circle "dashboard tells".
    return (
      <svg
        viewBox="0 0 16 16"
        width="14"
        height="14"
        className={className}
        aria-hidden
        {...rest}
      >
        <path
          d="M3 6 C 5 5, 7 5, 9 6"
          stroke={fill}
          strokeWidth="1.6"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M3 10 C 5 9, 7 9, 9 10"
          stroke={fill}
          strokeWidth="1.6"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    )
  }
  // teardrop default — organic, off-center, hand-drawn feel
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      className={className}
      aria-hidden
      {...rest}
    >
      <path
        d="M8 2 C 5 5, 4 7.5, 4 10 C 4 12.5, 5.8 14, 8 14 C 10.2 14, 12 12.5, 12 10 C 12 8, 11 6.5, 10 5 C 9.5 4, 9 3, 8 2 Z"
        fill={fill}
      />
    </svg>
  )
}

/**
 * Convenience: a small inline status pill with the indicator + a label.
 * Use for "Live", "Warning", "Stale" style tags.
 */
export function StatusPill({
  level,
  label,
  className = '',
}: {
  level: StatusLevel
  label: string
  className?: string
}) {
  const fill = COLOR[level]
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full bg-white border px-2 py-0.5 text-[10px] uppercase tracking-wide ${className}`}
      style={{ borderColor: `${fill}55`, color: fill }}
    >
      <StatusIndicator level={level} variant="teardrop" />
      {label}
    </span>
  )
}
