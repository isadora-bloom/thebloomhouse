/**
 * Bloom House — custom brand icons.
 *
 * Hand-drawn line-art SVG glyphs designed to match the thumbprint
 * mark's visual language: organic curves, hand-drawn line weight,
 * deliberate asymmetry. Replaces lucide-react's geometric set at the
 * highest-visibility surfaces (sidebar nav modes, status indicators,
 * the TBH sub-brand mark).
 *
 * Doctrine: when adding a new brand icon, keep stroke-width at 1.5
 * units (vs lucide's 2), use round line caps/joins, and avoid pure
 * symmetry — the brand mark has subtle hand-drawn imperfection that
 * a perfect geometric vector loses.
 */

import type { SVGProps } from 'react'

interface BrandIconProps extends SVGProps<SVGSVGElement> {
  className?: string
}

const BASE_PROPS = {
  width: 24,
  height: 24,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  xmlns: 'http://www.w3.org/2000/svg',
}

// =============================================================================
// Mode icons — Agent / Weddings / Intel / Sage's Brain
// =============================================================================

/**
 * Agent — represents email + voice with overlapping envelope flap
 * and a small dot signifying activity. The flap is asymmetric
 * (slightly higher on one side) to feel hand-drawn.
 */
export function AgentMark(props: BrandIconProps) {
  return (
    <svg {...BASE_PROPS} {...props}>
      <path d="M3.5 7.5 C 3.5 6.5, 4.2 5.8, 5.2 5.8 L 18.8 5.8 C 19.8 5.8, 20.5 6.5, 20.5 7.5 L 20.5 16.2 C 20.5 17.2, 19.8 17.9, 18.8 17.9 L 5.2 17.9 C 4.2 17.9, 3.5 17.2, 3.5 16.2 Z" />
      <path d="M3.8 7.8 L 11.7 12.5 C 11.9 12.6, 12.1 12.6, 12.3 12.5 L 20.2 7.5" />
      <circle cx="17.8" cy="9.2" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  )
}

/**
 * Weddings — two interlinked rings, hand-drawn imperfect circles.
 * Replaces lucide Heart which over-uses a generic shape.
 */
export function WeddingsMark(props: BrandIconProps) {
  return (
    <svg {...BASE_PROPS} {...props}>
      <path d="M8.7 13.5 C 6.1 13.5, 4.5 11.7, 4.5 9.4 C 4.5 7.1, 6.1 5.4, 8.7 5.4 C 11.2 5.4, 12.8 7.1, 12.8 9.4 C 12.8 11.6, 11.3 13.4, 8.8 13.5 Z" />
      <path d="M15.3 18.6 C 12.7 18.6, 11.2 16.7, 11.2 14.5 C 11.2 12.2, 12.8 10.5, 15.3 10.5 C 17.9 10.5, 19.5 12.2, 19.5 14.5 C 19.5 16.7, 17.9 18.5, 15.4 18.6 Z" />
    </svg>
  )
}

/**
 * Intel — concentric arcs suggesting layered insight, with a central
 * dot. Not a generic chart icon. The arcs are slightly off-center to
 * keep the hand-drawn feel.
 */
export function IntelMark(props: BrandIconProps) {
  return (
    <svg {...BASE_PROPS} {...props}>
      <path d="M4.5 17 C 4.5 11.5, 8.5 7.5, 13 7.5" />
      <path d="M7.5 17 C 7.5 13, 10.5 10.2, 14 10.2" />
      <path d="M10.5 17 C 10.5 14.8, 12.3 13.2, 14.5 13.2" />
      <circle cx="14.8" cy="15.5" r="1.4" />
      <path d="M16 9 L 18.5 6.5" />
      <path d="M16.5 11.5 L 19.5 11" />
    </svg>
  )
}

/**
 * Sage's Brain — a stylized organic leaf/brain hybrid, echoing the
 * thumbprint's coiled-line motif. Two nested curves with a central
 * stem.
 */
export function SageMark(props: BrandIconProps) {
  return (
    <svg {...BASE_PROPS} {...props}>
      <path d="M12 4.5 C 7 4.5, 4 8.5, 4 12.5 C 4 16.5, 7 19.5, 12 19.5 C 17 19.5, 20 16.5, 20 12.5 C 20 8.5, 17 4.5, 12 4.5 Z" />
      <path d="M12 4.5 L 12 19.5" strokeDasharray="0.6 1.4" />
      <path d="M6.5 9.5 C 8.5 11.5, 10 12, 12 12 C 14 12, 15.5 11.5, 17.5 9.5" />
      <path d="M6.5 15 C 8.5 13, 10 12.5, 12 12.5 C 14 12.5, 15.5 13, 17.5 15" />
    </svg>
  )
}

// =============================================================================
// Utility icons — Heat, Pipeline, TBH mark
// =============================================================================

/**
 * Heat — flame-but-not-lucide-flame: an organic teardrop with an
 * inner curve suggesting the inside of a flame. Asymmetric to feel
 * drawn rather than vectored.
 */
export function HeatMark(props: BrandIconProps) {
  return (
    <svg {...BASE_PROPS} {...props}>
      <path d="M12 3 C 10 6, 7 7.5, 7 12 C 7 16, 9.5 19, 12 19 C 14.5 19, 17 16, 17 12 C 17 9, 15 8, 14 6 C 13.5 5, 13.2 4, 12 3 Z" />
      <path d="M10.5 13.5 C 10.5 15.5, 12 17, 13.5 16 C 14.5 15.3, 14.5 14, 13.5 13 C 13 12.5, 12.5 12, 12 11.5" />
    </svg>
  )
}

/**
 * Pipeline — three stacked horizontal flow lines with widening
 * funnel suggesting filter. Replaces the generic kanban / sankey
 * iconography with something closer to the forensic narrative
 * (signals flowing into a record).
 */
export function PipelineMark(props: BrandIconProps) {
  return (
    <svg {...BASE_PROPS} {...props}>
      <path d="M3.5 6 L 20.5 6" />
      <path d="M5.5 11 L 18.5 11" />
      <path d="M8 16 L 16 16" />
      <path d="M11 20 L 13 20" />
      <circle cx="3.5" cy="6" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="20.5" cy="6" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  )
}

/**
 * TBH mark — sub-brand glyph for TBH Reports / TBH Score. A
 * confident pen-mark style "T·B·H" arranged as a compact monogram
 * with a serif baseline tie. Uses the thumbprint's curve-stroke at
 * the bottom.
 */
export function TbhMark(props: BrandIconProps) {
  return (
    <svg {...BASE_PROPS} {...props}>
      <path d="M3.5 8 L 8.5 8" />
      <path d="M6 8 L 6 16" />
      <path d="M10 8 L 10 16" />
      <path d="M10 8 L 13 8 C 14 8, 14.5 8.7, 14.5 9.7 C 14.5 10.7, 14 11.4, 13 11.4 L 10 11.4" />
      <path d="M10 11.4 L 13.2 11.4 C 14.3 11.4, 14.8 12.1, 14.8 13.2 C 14.8 14.3, 14.2 15, 13.2 15 L 10 15" />
      <path d="M16.5 8 L 16.5 16" />
      <path d="M20.5 8 L 20.5 16" />
      <path d="M16.5 11.6 L 20.5 11.6" />
      <path d="M3.2 19 C 7 17.8, 17 17.8, 20.8 19" />
    </svg>
  )
}

// =============================================================================
// Export grouping for selective imports
// =============================================================================

export const BRAND_ICONS = {
  AgentMark,
  WeddingsMark,
  IntelMark,
  SageMark,
  HeatMark,
  PipelineMark,
  TbhMark,
}
