import Stripe from 'stripe'

// ---------------------------------------------------------------------------
// Stripe singleton
//
// Mirrors the Anthropic client pattern in src/lib/ai/client.ts: construct
// lazily so a missing env var throws at call-time (clear 500) instead of
// at module-load (crashing the build).
// ---------------------------------------------------------------------------

let stripeClient: Stripe | null = null

// Pinned to the API version bundled with stripe@17.x.
// Change this when upgrading the SDK.
const STRIPE_API_VERSION: Stripe.LatestApiVersion = '2025-02-24.acacia'

export function getStripe(): Stripe {
  if (!stripeClient) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not set — Stripe is not configured')
    }
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: STRIPE_API_VERSION,
      typescript: true,
    })
  }
  return stripeClient
}

/**
 * Returns true if STRIPE_SECRET_KEY is set. UI can use this to decide
 * whether to show "Upgrade" buttons or a "Billing not configured" state.
 */
export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY)
}
