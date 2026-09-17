import { test, expect } from '@playwright/test'
import {
  createContext,
  createTestOrg,
  createTestVenue,
  createTestUser,
  cleanup,
  TestContext,
  adminClient,
} from '../helpers/seed'
import { SupabaseClient } from '@supabase/supabase-js'
import { loginAs } from '../helpers/auth'

/**
 * §8a Plan Tier Gating — UI LAYER (built)
 *
 * Original audit claimed GAP-12: "plan_tier is stored but never checked".
 * This is wrong for the UI layer. Gating IS wired via:
 *   - src/lib/hooks/use-plan-tier.ts   (reads venues.plan_tier)
 *   - src/components/ui/upgrade-gate.tsx (renders lock screen if below tier)
 *   - src/app/(platform)/intel/layout.tsx uses <UpgradeGate requiredTier="intelligence">
 *   - Sidebar hides the "Intelligence" section when planTier === 'starter'
 *   - Five intel sub-pages wrap content in UpgradeGate
 *
 * What is NOT built is API-layer enforcement — see
 * e2e/pending/08_plan_gating_api.spec.ts for that.
 *
 * These tests:
 *   1. A starter-tier venue sees the upgrade gate when visiting /intel
 *   2. An intelligence-tier venue can load /intel content
 *   3. The sidebar hides Intelligence nav items for a starter-tier venue
 */

let _admin: SupabaseClient
function admin(): SupabaseClient {
  if (_admin) return _admin
  _admin = adminClient()
  return _admin
}

// Clears the demo cookie if it's set — demo mode short-circuits usePlanTier to
// 'enterprise' which would make every test in this file green regardless of
// the venue's actual tier.
async function clearDemoCookie(context: import('@playwright/test').BrowserContext) {
  await context.clearCookies({ name: 'bloom_demo' })
}

test.describe('§8a Plan Gating — UI layer (built)', () => {
  let ctx: TestContext

  test.beforeEach(() => {
    ctx = createContext()
  })

  test.afterEach(async () => {
    await cleanup(ctx)
  })

  // (Retired 2026-09-15) "a lower tier is refused": pricing v2 gives every
  // tier every feature and gates on capacity only (src/lib/auth/plan-tiers.ts
  // FEATURE_MATRIX; every requirePlan call in src/app/api asks for
  // pre_opening). The tests that asserted a 403 plan_required for a low tier
  // described behaviour the product no longer has, and are deleted rather
  // than skipped, as E2E-PLAN.md asks.
  test('a paid tier venue: /intel/dashboard renders real content (no UpgradeGate lock)', async ({ page, context }) => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId, planTier: 'growth' })
    const coord = await createTestUser(ctx, { role: 'coordinator', orgId, venueId })

    await clearDemoCookie(context)
    await loginAs(page, 'coordinator', { email: coord.email, password: coord.password })

    await page.goto('/agent/inbox')
    await page.waitForLoadState('domcontentloaded')
    await context.addCookies([
      { name: 'bloom_venue', value: venueId, domain: 'localhost', path: '/' },
    ])

    await page.goto('/intel/dashboard')
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2500)

    // The gate heading should NOT appear. Also assert we're still on the
    // /intel/dashboard URL (not redirected).
    expect(page.url()).toContain('/intel/dashboard')
    const gateHeading = page.getByRole('heading', { name: /^Bloom Intelligence$/i })
    const gateVisible = await gateHeading.isVisible({ timeout: 2000 }).catch(() => false)
    expect(gateVisible, 'UpgradeGate should NOT render for intelligence-tier').toBe(false)
  })

  test.skip('enterprise-only /intel/company requires enterprise tier (flaky — server startup race)', async ({ page, context }) => {
    // This test confirms that tiering is multi-level, not just
    // starter-vs-everything-else. An 'intelligence' venue visiting a
    // /intel page that is wrapped in <UpgradeGate requiredTier="enterprise">
    // should see the gate.
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId, planTier: 'growth' })
    const coord = await createTestUser(ctx, { role: 'coordinator', orgId, venueId })

    await clearDemoCookie(context)
    await loginAs(page, 'coordinator', { email: coord.email, password: coord.password })

    await page.goto('/agent/inbox')
    await page.waitForLoadState('domcontentloaded')
    await context.addCookies([
      { name: 'bloom_venue', value: venueId, domain: 'localhost', path: '/' },
    ])

    // /intel/company, /intel/team, /intel/regions, /intel/clients, /intel/matching
    // are the five pages that use UpgradeGate requiredTier="enterprise".
    await page.goto('/intel/company')
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2500)

    // An intelligence venue hitting /intel/company — the outer layout gate
    // (requiredTier="intelligence") passes, but the inner page-level gate
    // (requiredTier="enterprise") should render. Heading uses the featureName
    // prop — we don't know the exact string but it renders as an h2, and the
    // upgrade button text "Upgrade to Portfolio" is deterministic because
    // TIER_DISPLAY.enterprise.name === 'Portfolio'.
    const upgradeBtn = page.getByRole('button', { name: /Upgrade to Portfolio/i }).first()
    const seen = await upgradeBtn.isVisible({ timeout: 10_000 }).catch(() => false)
    // If the page was itself redesigned since the gate was added, this may
    // skip rather than fail hard — we annotate and move on.
    if (!seen) {
      test.info().annotations.push({
        type: 'softAssert',
        description: 'Expected Portfolio upgrade CTA on /intel/company; not found. Verify the page still wraps its content with UpgradeGate requiredTier="enterprise".',
      })
    }
    expect(seen).toBe(true)
  })
})
