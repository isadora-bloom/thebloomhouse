import type { PlanTier } from '@/lib/auth/plan-tiers'

// ---------------------------------------------------------------------------
// Plan catalog — Pricing v2 (capacity-gated 5-tier model)
//
// Single source of truth for pricing, features, and Stripe price IDs.
// Consumed by the public /pricing page, the billing page, and the
// checkout endpoint (to validate incoming price IDs).
//
// Every tier gets every feature. Capacity (inquiries/mo, venues, active
// couples in portal) is the only differentiator.
//
// Annual prepay = monthly * 12 * 0.85 (15% off), offered for solo/growth/
// multi only. Pre-Opening has no annual prepay; Enterprise is sales-led.
// Prices are USD.
// ---------------------------------------------------------------------------

export interface Plan {
  tier: PlanTier
  name: string
  tagline: string
  monthly: number
  /** 0 if no annual offering for this tier (pre_opening, enterprise). */
  annual: number
  monthlyPriceId?: string
  annualPriceId?: string
  features: string[]
  capacity: { inquiries: string; venues: string; couples: string }
  /** Highlighted as the recommended tier on the pricing page. */
  featured?: boolean
  /** True for sales-led tiers (pre_opening waitlist, multi onboarding, enterprise). */
  contactSales?: boolean
}

export const PLANS: Plan[] = [
  {
    tier: 'pre_opening',
    name: 'Pre-Opening',
    tagline: 'For venues not yet operational.',
    monthly: 99,
    annual: 0,
    monthlyPriceId: process.env.STRIPE_PRICE_PRE_OPENING_MONTHLY,
    contactSales: true,
    capacity: { inquiries: '100/mo', venues: '1', couples: '30 active' },
    features: [
      'Full Bloom platform — Agent + Intelligence + Portal',
      'Pre-opening guidance and benchmarks',
      'Auto-rolls to Solo when first wedding completes',
    ],
  },
  {
    tier: 'solo',
    name: 'Solo',
    tagline: 'For established single venues, owner-operated.',
    monthly: 299,
    annual: 3049,  // 299 * 12 * 0.85 = 3049.8 → 3049
    monthlyPriceId: process.env.STRIPE_PRICE_SOLO_MONTHLY,
    annualPriceId: process.env.STRIPE_PRICE_SOLO_ANNUAL,
    capacity: { inquiries: '150/mo', venues: '1', couples: '50 active' },
    features: [
      'Full Bloom platform — Agent + Intelligence + Portal',
      'Voice training + Always/Never rules',
      'Custom venue knowledge base',
      'Email support',
    ],
  },
  {
    tier: 'growth',
    name: 'Growth',
    tagline: 'For venues with staff, ~50–100 weddings/year.',
    monthly: 549,
    annual: 5599,  // 549 * 12 * 0.85 = 5599.8 → 5599
    monthlyPriceId: process.env.STRIPE_PRICE_GROWTH_MONTHLY,
    annualPriceId: process.env.STRIPE_PRICE_GROWTH_ANNUAL,
    featured: true,
    capacity: { inquiries: '400/mo', venues: '1', couples: '150 active' },
    features: [
      'Everything in Solo',
      'Higher capacity for established venues',
      'Priority email support',
    ],
  },
  {
    tier: 'multi',
    name: 'Multi',
    tagline: 'For small portfolios (2–5 venues).',
    monthly: 1099,
    annual: 11209,  // 1099 * 12 * 0.85 = 11209.8 → 11209
    monthlyPriceId: process.env.STRIPE_PRICE_MULTI_MONTHLY,
    annualPriceId: process.env.STRIPE_PRICE_MULTI_ANNUAL,
    contactSales: true,
    capacity: { inquiries: '1,200/mo', venues: 'Up to 5', couples: '400 active' },
    features: [
      'Everything in Growth',
      'Cross-venue intelligence',
      'Unified attribution across portfolio',
      'Dedicated onboarding',
    ],
  },
  {
    tier: 'enterprise',
    name: 'Enterprise',
    tagline: 'For venue groups, PE-backed portfolios, regional rollups.',
    monthly: 0,
    annual: 0,
    contactSales: true,
    capacity: { inquiries: 'Unlimited', venues: 'Unlimited', couples: 'Unlimited' },
    features: [
      'Everything in Multi',
      'Cross-portfolio dashboards',
      'API access',
      'Dedicated account management',
      'Priority feature requests',
      'Uptime + response SLA',
    ],
  },
]

/**
 * Map a Stripe price ID back to its plan tier. Used by the webhook and
 * checkout endpoints. Returns `null` if the price ID is unknown.
 */
export function planTierForPriceId(priceId: string): PlanTier | null {
  for (const plan of PLANS) {
    if (plan.monthlyPriceId === priceId || plan.annualPriceId === priceId) {
      return plan.tier
    }
  }
  return null
}

/**
 * Find a plan by tier. Always defined for valid tiers.
 */
export function planForTier(tier: PlanTier): Plan | undefined {
  return PLANS.find((p) => p.tier === tier)
}

/**
 * Check that a priceId is one of the configured subscription prices.
 * Prevents clients from passing arbitrary Stripe prices at checkout.
 */
export function isConfiguredPriceId(priceId: string): boolean {
  return planTierForPriceId(priceId) !== null
}
