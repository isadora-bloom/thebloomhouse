import { test } from '@playwright/test'

/**
 * §5 Stripe Checkout — NEEDS BUILDING
 *
 * Blocked on: no pricing page, no subscription UI. Also per ground rules
 * we skip anything requiring the Stripe CLI (interactive).
 *
 * Requirements to implement:
 *  - Pricing page with plan tier buttons (starter, intelligence, enterprise).
 *  - POST /api/stripe/checkout creating a Stripe Checkout Session.
 *  - Webhook /api/webhooks/stripe that updates venues.plan_tier on
 *    checkout.session.completed (note: BUG-02 columns already added).
 *  - Billing portal entry point.
 */

test.describe.skip('§5 Stripe Checkout (pricing page + subscription UI missing)', () => {
  test('checkout session creates Stripe session and redirects', () => {})
  test('webhook updates venues.plan_tier to intelligence on success', () => {})
  test('cancel_subscription downgrades venue plan_tier', () => {})
})
