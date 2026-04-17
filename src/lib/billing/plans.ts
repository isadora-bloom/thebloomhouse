import type { PlanTier } from '@/lib/hooks/use-plan-tier'

// ---------------------------------------------------------------------------
// Plan catalog
//
// Single source of truth for pricing, features, and Stripe price IDs.
// Consumed by the public /pricing page, the billing page, and the
// checkout endpoint (to validate incoming price IDs).
//
// Prices are USD. Annual shows the yearly total (already discounted —
// equivalent to ~10 months).
// ---------------------------------------------------------------------------

export interface Plan {
  tier: PlanTier
  name: string
  tagline: string
  monthly: number
  annual: number
  monthlyPriceId?: string
  annualPriceId?: string
  features: string[]
  /** Highlighted as the recommended tier on the pricing page. */
  featured?: boolean
}

export const PLANS: Plan[] = [
  {
    tier: 'starter',
    name: 'Starter',
    tagline: 'Everything a single venue needs to respond, manage, and grow.',
    monthly: 0,
    annual: 0,
    features: [
      'AI email agent with approval queue',
      'Lead pipeline & heat map',
      'Couple portal with Sage chat',
      'Knowledge base & vendor directory',
      'Voice training & brand rules',
      'Email sequences & analytics',
      'Up to 1 venue',
    ],
  },
  {
    tier: 'intelligence',
    name: 'Intelligence',
    tagline: 'The full Bloom House intelligence loop — market, trends, reviews.',
    monthly: 249,
    annual: 2490,
    monthlyPriceId: process.env.STRIPE_PRICE_INTELLIGENCE_MONTHLY,
    annualPriceId: process.env.STRIPE_PRICE_INTELLIGENCE_ANNUAL,
    featured: true,
    features: [
      'Everything in Starter',
      'Intelligence dashboard & market pulse',
      'Ask Anything (natural language queries)',
      'Daily briefings & trend watch',
      'Review monitoring & sentiment',
      'Tour conversion analytics',
      'Lost-deal insights & campaigns',
      'Capacity & forecast models',
      'Health score tracking',
    ],
  },
  {
    tier: 'enterprise',
    name: 'Enterprise',
    tagline: 'For venue groups and multi-property operators.',
    monthly: 599,
    annual: 5990,
    monthlyPriceId: process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY,
    annualPriceId: process.env.STRIPE_PRICE_ENTERPRISE_ANNUAL,
    features: [
      'Everything in Intelligence',
      'Portfolio overview across venues',
      'Company-wide performance dashboards',
      'Team performance & regions',
      'Cross-venue client deduplication',
      'Unlimited venues & users',
      'Priority support',
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
