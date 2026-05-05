import { test, expect } from '@playwright/test'
import {
  createContext,
  createTestOrg,
  createTestVenue,
  createTestUser,
  cleanup,
  TestContext,
} from '../helpers/seed'
import { loginAs } from '../helpers/auth'

/**
 * §24 Scope switcher cookie propagation (PROJECT-AUDIT-V2 GAP-09)
 *
 * The bug: `useVenueId` / `useScope` previously read scope from cookies
 * via an empty-deps `useEffect`. After a scope switch the cookie was
 * updated but in-flight components kept the old value until a hard
 * reload. The scope-switcher worked around this with
 * `window.location.reload()` — slow, jarring, and racy with API calls
 * that fired between the cookie write and the reload.
 *
 * Fix: VenueScopeProvider holds the scope in React state hydrated from
 * the SSR-resolved value. `useScopeMutator()` updates the store
 * synchronously, writes the cookies, and calls `router.refresh()`. No
 * full reload, no race window.
 *
 * Tests:
 *   1. Switching from Venue A to Venue B updates the trigger pill
 *      label without a full page reload (no `load` event fires).
 *   2. The bloom_venue cookie is written by the click and matches the
 *      newly selected venue id.
 *   3. After the switch, an API call from the page (caught by route
 *      interceptor) carries the new venue's data — no stale value
 *      sneaks through.
 */

test.describe('§24 Scope switcher — cookie propagation race (GAP-09)', () => {
  let ctx: TestContext

  test.beforeEach(() => {
    ctx = createContext()
  })

  test.afterEach(async () => {
    await cleanup(ctx)
  })

  test('switching venue updates the trigger pill without a full page reload', async ({ page, context }) => {
    const { orgId } = await createTestOrg(ctx)
    const venueA = await createTestVenue(ctx, {
      orgId,
      planTier: 'intelligence',
      name: `E2E A [e2e:${ctx.testId}]`,
    })
    const venueB = await createTestVenue(ctx, {
      orgId,
      planTier: 'intelligence',
      name: `E2E B [e2e:${ctx.testId}]`,
    })
    // Coordinator's profile.venue_id points at A initially.
    const coord = await createTestUser(ctx, {
      role: 'org_admin',
      orgId,
      venueId: venueA.venueId,
    })

    await context.clearCookies({ name: 'bloom_demo' })
    await loginAs(page, 'org_admin', { email: coord.email, password: coord.password })

    await page.goto('/agent/inbox')
    await page.waitForLoadState('domcontentloaded')

    // Sanity — pill should display venue A (the SSR-resolved scope).
    const pillName = page.getByTestId('scope-indicator-name')
    await expect(pillName).toHaveText(/E2E A/i, { timeout: 10_000 })

    // Tag the window so we can detect a full reload. If the page
    // reloads, this property is gone.
    await page.evaluate(() => {
      ;(window as unknown as { __scopeSwitchSentinel?: number }).__scopeSwitchSentinel = Date.now()
    })

    // Open the scope indicator popover.
    await page.getByTestId('scope-indicator-trigger').click()

    // Pick venue B from the popover list.
    const venueBButton = page.getByTestId(`scope-indicator-venue-${venueB.venueId}`)
    await expect(venueBButton).toBeVisible({ timeout: 10_000 })
    await venueBButton.click()

    // Pill text updates synchronously from the in-memory store — no
    // full page navigation, no reload.
    await expect(pillName).toHaveText(/E2E B/i, { timeout: 5_000 })

    // The window sentinel survives, proving no `window.location.reload()`
    // was triggered. (A real reload wipes globals.)
    const sentinelStillPresent = await page.evaluate(
      () =>
        typeof (window as unknown as { __scopeSwitchSentinel?: number }).__scopeSwitchSentinel ===
        'number',
    )
    expect(
      sentinelStillPresent,
      'scope switch should NOT trigger window.location.reload()',
    ).toBe(true)

    // bloom_venue cookie was written client-side to the new venue id.
    const cookies = await context.cookies()
    const venueCookie = cookies.find((c) => c.name === 'bloom_venue')
    expect(venueCookie?.value).toBe(venueB.venueId)
  })

  test('API calls fired after a scope switch carry the new venue id (no stale read)', async ({ page, context }) => {
    const { orgId } = await createTestOrg(ctx)
    const venueA = await createTestVenue(ctx, {
      orgId,
      planTier: 'intelligence',
      name: `E2E A [e2e:${ctx.testId}]`,
    })
    const venueB = await createTestVenue(ctx, {
      orgId,
      planTier: 'intelligence',
      name: `E2E B [e2e:${ctx.testId}]`,
    })
    const admin = await createTestUser(ctx, {
      role: 'org_admin',
      orgId,
      venueId: venueA.venueId,
    })

    await context.clearCookies({ name: 'bloom_demo' })
    await loginAs(page, 'org_admin', { email: admin.email, password: admin.password })

    await page.goto('/agent/inbox')
    await page.waitForLoadState('domcontentloaded')

    // Wait for the SSR-resolved trigger to render.
    const pillName = page.getByTestId('scope-indicator-name')
    await expect(pillName).toHaveText(/E2E A/i, { timeout: 10_000 })

    // Watch for any /api/* request initiated AFTER the switch — its
    // bloom_venue cookie header should match venue B, never venue A.
    const seenVenueIdsAfterSwitch: string[] = []

    const startCapture = async () => {
      page.on('request', (req) => {
        const url = req.url()
        if (!url.includes('/api/')) return
        const cookieHeader = req.headers()['cookie'] ?? ''
        const match = cookieHeader.match(/(?:^|;\s*)bloom_venue=([^;]+)/)
        if (match) seenVenueIdsAfterSwitch.push(decodeURIComponent(match[1]))
      })
    }
    await startCapture()

    // Open + select venue B.
    await page.getByTestId('scope-indicator-trigger').click()
    await page.getByTestId(`scope-indicator-venue-${venueB.venueId}`).click()
    await expect(pillName).toHaveText(/E2E B/i, { timeout: 5_000 })

    // Trigger an API call after the switch. router.refresh() inside
    // useScopeMutator already forces a server-component re-render; we
    // also nudge the client by navigating to a page that fetches data.
    await page.goto('/intel/dashboard')
    await page.waitForLoadState('domcontentloaded')
    // Give the dashboard's effects a moment to fire requests.
    await page.waitForTimeout(1500)

    // No /api/* call should have carried the OLD venue's id after the
    // switch — that's the GAP-09 race we're guarding against.
    const stale = seenVenueIdsAfterSwitch.filter((id) => id === venueA.venueId)
    expect(
      stale,
      `Expected zero stale (venue A) /api/* requests after switch. Saw: ${JSON.stringify(stale)}`,
    ).toEqual([])

    // And at least one request should have gone out with venue B.
    const fresh = seenVenueIdsAfterSwitch.filter((id) => id === venueB.venueId)
    expect(
      fresh.length,
      'Expected at least one /api/* request to carry the new venue id',
    ).toBeGreaterThan(0)
  })
})
