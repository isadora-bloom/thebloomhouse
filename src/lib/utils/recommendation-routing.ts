/**
 * Infer the most relevant in-product destination for an LLM-generated
 * recommendation. The LLM emits free text; we keyword-match the text
 * against operator-facing surfaces so each recommendation becomes a
 * one-click jump rather than a "now what?" dead end.
 *
 * Order matters: more specific patterns first. Returns null when no
 * match is confident enough — the recommendation then renders as plain
 * text. Never invent a destination; "no match" is the right answer for
 * recommendations that don't map cleanly.
 */

interface SurfaceHint {
  /** Lowercase keywords. ALL must match (AND), or any one of an `any` group. */
  any: string[]
  href: string
  label: string
}

const SURFACE_HINTS: SurfaceHint[] = [
  // Channel intelligence
  {
    any: ['knot', 'wedding wire', 'weddingwire', 'zola', 'platform listing'],
    href: '/intel/channels',
    label: 'Open Channels',
  },
  {
    any: ['channel mix', 'attribution', 'first touch', 'source split'],
    href: '/intel/channels',
    label: 'Open Channels',
  },
  // Voice / tone
  {
    any: ['voice', 'tone', 'response style', 'writing style', 'word choice'],
    href: '/sage/voice-dna',
    label: 'Open Voice DNA',
  },
  {
    any: ['training game', 'teach the ai', 'teach sage', 'approve'],
    href: '/agent/learning',
    label: 'Open Training',
  },
  // Marketing recommendations
  {
    any: ['ad spend', 'agency', 'hawthorn', 'paid marketing'],
    href: '/intel/agencies',
    label: 'Open Agencies',
  },
  {
    any: ['marketing roi', 'cac', 'cost per booking'],
    href: '/intel/marketing-roi',
    label: 'Open Marketing ROI',
  },
  // Tours + bookings
  {
    any: ['tour conversion', 'tour to book', 'no-show', 'tour follow-up', 'post-tour'],
    href: '/intel/tours',
    label: 'Open Tours',
  },
  {
    any: ['booking velocity', 'time to book', 'days to book'],
    href: '/intel/dashboard',
    label: 'Open Dashboard',
  },
  // Email / inbox
  {
    any: ['response time', 'reply faster', 'auto-send', 'auto send', 'first-response'],
    href: '/agent/settings',
    label: 'Open Auto-send Settings',
  },
  {
    any: ['email template', 'follow-up cadence', 'follow up cadence', 'nudge'],
    href: '/agent/inbox',
    label: 'Open Inbox',
  },
  // Cohort / persona
  {
    any: ['persona', 'archetype', 'cohort', 'segment'],
    href: '/intel/cohort',
    label: 'Open Cohort',
  },
  // Re-engagement
  {
    any: ['re-engage', 'reengage', 'cold lead', 'stale lead', 'lost lead', 'dormant'],
    href: '/intel/re-engagement',
    label: 'Open Re-engagement',
  },
  // Knowledge / FAQ
  {
    any: ['faq', 'knowledge', 'question', 'common question', 'frequently asked'],
    href: '/agent/knowledge-gaps',
    label: 'Open Knowledge Gaps',
  },
  // Reviews
  {
    any: ['review', 'rating', 'testimonial'],
    href: '/intel/reviews',
    label: 'Open Reviews',
  },
  // Trends + market pulse
  {
    any: ['trend', 'search interest', 'cultural moment', 'season'],
    href: '/intel/market-pulse',
    label: 'Open Market Pulse',
  },
  // Pricing
  {
    any: ['pricing', 'rate card', 'min spend', 'minimum spend', 'price point'],
    href: '/intel/pricing',
    label: 'Open Pricing',
  },
  // Discoveries
  {
    any: ['discovery', 'hypothesis', 'pattern'],
    href: '/intel/discoveries',
    label: 'Open Discoveries',
  },
]

export interface RecommendationDestination {
  href: string
  label: string
}

export function inferRecommendationDestination(
  text: string,
): RecommendationDestination | null {
  if (!text) return null
  const lower = text.toLowerCase()
  for (const hint of SURFACE_HINTS) {
    if (hint.any.some((kw) => lower.includes(kw))) {
      return { href: hint.href, label: hint.label }
    }
  }
  return null
}
