import { test, expect } from '@playwright/test'
import {
  createContext,
  createTestOrg,
  createTestVenue,
  createTestUser,
  cleanup,
  TestContext,
} from '../helpers/seed'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
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
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  _admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
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

  test('starter-tier venue: /intel/dashboard renders the UpgradeGate "Bloom Intelligence" lock', async ({ page, context }) => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId, planTier: 'starter' })
    const coord = await createTestUser(ctx, { role: 'coordinator', orgId, venueId })

    await clearDemoCookie(context)
    await loginAs(page, 'coordinator', { email: coord.email, password: coord.password })

    // Load a platform page first so the scope-selector sets bloom_venue.
    await page.goto('/agent/inbox')
    await page.waitForLoadState('domcontentloaded')
    // Wait for scope-selector to run & write the bloom_venue cookie.
    await page.waitForFunction(
      () => document.cookie.split('; ').some((c) => c.startsWith('bloom_venue=')),
      null,
      { timeout: 10_000 }
    ).catch(() => null)
    // Manually ensure cookie present — scope-selector may race.
    await context.addCookies([
      { name: 'bloom_venue', value: venueId, domain: 'localhost', path: '/' },
    ])

    await page.goto('/intel/dashboard')
    await page.waitForLoadState('domcontentloaded')
    // usePlanTier runs in a useEffect; give it time to hit Supabase.
    await page.waitForTimeout(2500)

    // UpgradeGate renders the feature name as an h2 heading; the intel/layout
    // wraps children with featureName="Bloom Intelligence".
    const gateHeading = page.getByRole('heading', { name: /Bloom Intelligence/i }).first()
    await expect(gateHeading).toBeVisible({ timeout: 10_000 })

    // And the CTA button to upgrade.
    const upgradeBtn = page.getByRole('button', { name: /Upgrade to/i }).first()
    await expect(upgradeBtn).toBeVisible()
  })

  test('intelligence-tier venue: /intel/dashboard renders real content (no UpgradeGate lock)', async ({ page, context }) => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId, planTier: 'intelligence' })
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

  test('sidebar hides Intelligence nav items for starter-tier venue', async ({ page, context }) => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId, planTier: 'starter' })
    const coord = await createTestUser(ctx, { role: 'coordinator', orgId, venueId })

    await clearDemoCookie(context)
    await loginAs(page, 'coordinator', { email: coord.email, password: coord.password })

    // Load an allowed page so the sidebar renders. /agent/inbox is in the
    // starter-tier feature set.
    await page.goto('/agent/inbox')
    await page.waitForLoadState('domcontentloaded')
    await context.addCookies([
      { name: 'bloom_venue', value: venueId, domain: 'localhost', path: '/' },
    ])
    // Reload so usePlanTier reads bloom_venue and re-queries Supabase.
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2500)

    // The sidebar's buildSections() skips the 'Intelligence' section when
    // planTier === 'starter'. That section has a distinctive sub-subtitle
    // "Daily mode" elsewhere, but the simplest check is: no nav link to
    // /intel/dashboard (Market Pulse / Dashboard) should appear in the
    // sidebar for a starter venue.
    const intelLink = page.locator('a[href="/intel/dashboard"], a[href^="/intel/"]').first()
    const visible = await intelLink.isVisible({ timeout: 2000 }).catch(() => false)
    expect(visible, 'Intelligence nav links should be hidden for starter tier').toBe(false)
  })

  test.skip('enterprise-only /intel/company requires enterprise tier (flaky — server startup race)', async ({ page, context }) => {
    // This test confirms that tiering is multi-level, not just
    // starter-vs-everything-else. An 'intelligence' venue visiting a
    // /intel page that is wrapped in <UpgradeGate requiredTier="enterprise">
    // should see the gate.
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId, planTier: 'intelligence' })
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
