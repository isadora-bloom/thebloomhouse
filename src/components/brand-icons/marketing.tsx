/**
 * Bloom House — marketing-surface brand icons.
 *
 * Twelve hand-drawn SVG glyphs designed to replace the iconoir icons
 * on the highest-visibility marketing pages (homepage feature cards,
 * about-page values cards). Style matches the thumbprint mark's
 * organic line work — stroke 1.5, round caps/joins, deliberate
 * asymmetry, no perfect-mirror symmetry.
 *
 * Companion to brand-icons/index.tsx which holds the four platform
 * mode marks plus utility marks (Heat/Pipeline/Tbh).
 */

import type { SVGProps } from 'react'

interface BrandIconProps extends SVGProps<SVGSVGElement> {
  className?: string
}

const BASE = {
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
// TIER 1 — Homepage feature cards
// =============================================================================

/**
 * MidnightMail — envelope with a small crescent moon over its top
 * edge. Conveys "email at midnight" without dropping a generic Mail
 * shape. Flap asymmetry kept loose, moon offset to the right.
 */
export function MidnightMail(props: BrandIconProps) {
  return (
    <svg {...BASE} {...props}>
      <path d="M3.5 8.5 C 3.5 7.4, 4.3 6.7, 5.4 6.7 L 18.6 6.7 C 19.7 6.7, 20.5 7.4, 20.5 8.5 L 20.5 16.5 C 20.5 17.6, 19.7 18.3, 18.6 18.3 L 5.4 18.3 C 4.3 18.3, 3.5 17.6, 3.5 16.5 Z" />
      <path d="M3.9 8.9 L 11.7 13.2 C 11.9 13.3, 12.1 13.3, 12.3 13.2 L 20.1 8.5" />
      <path d="M17.5 4.8 C 16.4 4.5, 15 5, 14.5 6.1 C 14 7.2, 14.7 8.6, 15.8 8.9 C 16.4 9.1, 17.1 9, 17.5 8.7 C 16.8 8.8, 16.1 8.6, 15.6 8.1 C 15 7.4, 15.1 6.2, 15.8 5.6 C 16.3 5.1, 17 4.9, 17.5 4.8 Z" />
    </svg>
  )
}

/**
 * CrossPlatform — three overlapping conversation bubbles at different
 * angles. Conveys "six aliases across platforms" — fragments converging
 * but not yet merged. Bubble sizes vary; tails point outward.
 */
export function CrossPlatform(props: BrandIconProps) {
  return (
    <svg {...BASE} {...props}>
      <path d="M4 9 C 4 7.5, 5.2 6.5, 6.8 6.5 L 11.2 6.5 C 12.8 6.5, 14 7.5, 14 9 L 14 11.5 C 14 13, 12.8 14, 11.2 14 L 7 14 L 4.8 15.8 L 5.2 14 C 4.5 13.6, 4 12.6, 4 11.5 Z" />
      <path d="M10 12 C 10 10.8, 11 10, 12.3 10 L 16.7 10 C 18 10, 19 10.8, 19 12 L 19 14 C 19 15.2, 18 16, 16.7 16 L 12.5 16 L 11 17.5 L 11.3 16 C 10.5 15.7, 10 15, 10 14 Z" />
      <path d="M14.5 5 C 14.5 4.2, 15.2 3.6, 16.1 3.6 L 18.9 3.6 C 19.8 3.6, 20.5 4.2, 20.5 5 L 20.5 6.5 C 20.5 7.3, 19.8 8, 18.9 8 L 16 8" />
    </svg>
  )
}

/**
 * ForensicInsight — magnifying glass with a small thumbprint-ridge
 * curve inside the lens. Replaces BarChart3 / TrendingUp on the Intel
 * feature card. The ridge curve is the same coiled-line motif as the
 * brand mark, miniaturized.
 */
export function ForensicInsight(props: BrandIconProps) {
  return (
    <svg {...BASE} {...props}>
      <circle cx="10.5" cy="10.5" r="6.2" />
      <path d="M15 15 L 19.5 19.5" strokeWidth="2" />
      <path d="M7.2 11 C 8 9, 10 8.5, 11.5 9.5" />
      <path d="M7.8 12.8 C 9 11.2, 10.8 11, 12.2 12" />
      <path d="M8.6 14 C 9.8 13, 11 13, 12.2 13.5" />
    </svg>
  )
}

/**
 * CoupleHands — two organic curved forms interlocking. NOT a heart
 * shape — two distinct teardrop-ish curves meeting at an angle. Reads
 * as a relationship metaphor without the generic Valentine glyph.
 */
export function CoupleHands(props: BrandIconProps) {
  return (
    <svg {...BASE} {...props}>
      <path d="M6.5 5 C 4 6.5, 3.5 9.5, 5 12 C 6.2 14, 9 14.5, 11 13.5 C 12 13, 12.5 11.8, 12.5 10.5 C 12.5 8.5, 11.2 7, 9.5 6.2 C 8.5 5.7, 7.4 5.2, 6.5 5 Z" />
      <path d="M17.8 10.5 C 20.3 12, 21 14.8, 19.7 17.3 C 18.7 19.3, 16 19.8, 14 19 C 12.7 18.5, 12 17.4, 12 16.2 C 12 14.2, 13.3 12.7, 15 12 C 16 11.5, 17 11, 17.8 10.5 Z" />
    </svg>
  )
}

/**
 * QuietMorning — horizon line with a sun arc rising. Replaces the
 * generic Clock for the "stop drowning" benefit. Suggests a calm
 * start instead of urgency.
 */
export function QuietMorning(props: BrandIconProps) {
  return (
    <svg {...BASE} {...props}>
      <path d="M3 16 L 21 16" />
      <path d="M7 16 C 7 12.5, 9.3 9.5, 12 9.5 C 14.7 9.5, 17 12.5, 17 16" />
      <path d="M12 5.5 L 12 7.5" />
      <path d="M5.5 9 L 6.8 10.2" />
      <path d="M18.5 9 L 17.2 10.2" />
      <path d="M3 19.5 L 21 19.5" strokeDasharray="0.6 1.6" />
    </svg>
  )
}

/**
 * RealVoice — a quill / pen-nib leaving a single hand-drawn signature
 * curve. Replaces Sparkles. Voice DNA isn't a sparkle — it's a stroke.
 */
export function RealVoice(props: BrandIconProps) {
  return (
    <svg {...BASE} {...props}>
      <path d="M17.5 4 L 19.5 6 L 11 14.5 L 9 14.5 L 9 12.5 Z" />
      <path d="M16.5 5 L 18.5 7" />
      <path d="M9 14.5 L 7.5 16" />
      <path d="M4 19.5 C 6.5 18, 9 17.5, 11.5 17.8 C 14 18.1, 16.5 18.8, 20 19" />
    </svg>
  )
}

/**
 * FieldGuide — open book with a compass-rose-ish marker inside. For
 * the "how it works" section. Suggests guidance + a map.
 */
export function FieldGuide(props: BrandIconProps) {
  return (
    <svg {...BASE} {...props}>
      <path d="M3.5 6.5 C 3.5 6, 4 5.5, 4.5 5.5 L 11.5 5.5 C 11.8 5.5, 12 5.7, 12 6 L 12 18.5 C 12 18.8, 11.8 19, 11.5 19 L 4.5 19 C 4 19, 3.5 18.5, 3.5 18 Z" />
      <path d="M20.5 6.5 C 20.5 6, 20 5.5, 19.5 5.5 L 12.5 5.5 C 12.2 5.5, 12 5.7, 12 6 L 12 18.5 C 12 18.8, 12.2 19, 12.5 19 L 19.5 19 C 20 19, 20.5 18.5, 20.5 18 Z" />
      <path d="M16 10 L 16 14" />
      <path d="M14 12 L 18 12" />
      <path d="M14.5 10.5 L 17.5 13.5" strokeDasharray="0.5 1.2" />
    </svg>
  )
}

/**
 * Shelter — an architectural arch suggesting safety + coverage. NOT a
 * shield. Replaces Shield on the trust / privacy section.
 */
export function Shelter(props: BrandIconProps) {
  return (
    <svg {...BASE} {...props}>
      <path d="M4 19 L 4 11 C 4 7.5, 7.5 4.5, 12 4.5 C 16.5 4.5, 20 7.5, 20 11 L 20 19" />
      <path d="M3 19.5 L 21 19.5" />
      <path d="M9 19 L 9 13.5 C 9 12, 10.3 11, 12 11 C 13.7 11, 15 12, 15 13.5 L 15 19" />
    </svg>
  )
}

// =============================================================================
// TIER 2 — About-page values cards
// =============================================================================

/**
 * VoiceMatters — a single vocal-cord curve doubling on itself. Plus a
 * tiny accent dot suggesting an emphasized syllable.
 */
export function VoiceMatters(props: BrandIconProps) {
  return (
    <svg {...BASE} {...props}>
      <path d="M5 12 C 5 8.5, 8 6, 12 6 C 16 6, 19 8.5, 19 12 C 19 15.5, 16 18, 12 18 C 8 18, 5 15.5, 5 12 Z" />
      <path d="M7.5 10 C 8.5 10.5, 9.2 11.5, 9.2 12.5" />
      <path d="M9.5 9 C 11 9.7, 12 11, 12 12.5" />
      <path d="M12 9 C 13.5 9.7, 14.8 11, 14.8 12.5" />
      <path d="M15 10 C 16 10.7, 16.5 11.5, 16.5 12.5" />
      <circle cx="12" cy="15" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  )
}

/**
 * Transparency — open window with curtain pulled back. Light comes
 * through. Honest, nothing-hidden framing.
 */
export function Transparency(props: BrandIconProps) {
  return (
    <svg {...BASE} {...props}>
      <path d="M4.5 4.5 L 19.5 4.5 L 19.5 19.5 L 4.5 19.5 Z" />
      <path d="M12 4.5 L 12 19.5" />
      <path d="M4.5 12 L 19.5 12" />
      <path d="M8.5 4.5 C 8.5 8, 7 11, 6 12" />
      <path d="M15.5 4.5 C 15.5 8, 17 11, 18 12" />
    </svg>
  )
}

/**
 * BuiltForOne — a single hand holding a small bloom (echoes the
 * "Bloom House" name). The bloom is just a center dot with a few
 * petal-curves around it.
 */
export function BuiltForOne(props: BrandIconProps) {
  return (
    <svg {...BASE} {...props}>
      <path d="M5 18 C 5 16, 6.5 14.5, 8.5 14.5 L 15.5 14.5 C 17.5 14.5, 19 16, 19 18 L 19 20 L 5 20 Z" />
      <path d="M12 14.5 L 12 11" />
      <circle cx="12" cy="8.5" r="1" />
      <path d="M9.5 7.5 C 10 7, 10.5 6.7, 11 6.5" />
      <path d="M14.5 7.5 C 14 7, 13.5 6.7, 13 6.5" />
      <path d="M10.5 5.5 C 11 5, 11.5 4.8, 12 4.7" />
      <path d="M13.5 5.5 C 13 5, 12.5 4.8, 12 4.7" />
      <path d="M9.5 9.5 C 9 10, 8.8 10.5, 8.7 11" />
      <path d="M14.5 9.5 C 15 10, 15.2 10.5, 15.3 11" />
    </svg>
  )
}

/**
 * PeopleFirst — two figures in conversation, slightly leaning toward
 * each other. NOT a shield or heart. Curves convey attention.
 */
export function PeopleFirst(props: BrandIconProps) {
  return (
    <svg {...BASE} {...props}>
      <circle cx="8" cy="8" r="2.5" />
      <circle cx="16" cy="8" r="2.5" />
      <path d="M3.5 19 C 3.5 16, 5.5 14, 8 14 C 9.3 14, 10.5 14.5, 11.3 15.3" />
      <path d="M12.7 15.3 C 13.5 14.5, 14.7 14, 16 14 C 18.5 14, 20.5 16, 20.5 19" />
      <path d="M10 10.5 C 10.5 11.2, 11.2 11.5, 12 11.5 C 12.8 11.5, 13.5 11.2, 14 10.5" />
    </svg>
  )
}

// =============================================================================
// Export grouping
// =============================================================================

export const MARKETING_BRAND_ICONS = {
  // Tier 1
  MidnightMail,
  CrossPlatform,
  ForensicInsight,
  CoupleHands,
  QuietMorning,
  RealVoice,
  FieldGuide,
  Shelter,
  // Tier 2
  VoiceMatters,
  Transparency,
  BuiltForOne,
  PeopleFirst,
}
