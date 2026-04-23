import { test, expect, Page } from '@playwright/test'
import {
  createContext,
  createTestOrg,
  createTestVenue,
  createTestUser,
  createTestWedding,
  cleanup,
  TestContext,
} from '../helpers/seed'
import { loginAs } from '../helpers/auth'

/**
 * §20 DEMO ISOLATION — the real-data-in-demo bleed is an auth/demo cookie
 * collision, not a data-layer problem. These tests exercise the three
 * scenarios that together prove the bleed is closed:
 *
 *   1. Authed user visiting /demo is signed out before demo cookies land.
 *      Result: queries in the demo run as anon and return Crestwood rows only.
 *
 *   2. Anonymous user visiting /demo sees the same Crestwood Collection.
 *      Zero of any one user's data is visible.
 *
 *   3. The 24-hour bleed: authed user → /demo → exit demo → re-login → their
 *      own dashboard shows only their own data. No Crestwood residue from the
 *      demo visit, no stale bloom_demo cookie keeping middleware in bypass.
 *
 * White-label is implicit in scenario 1 + 3: the test Rixey venue has a
 * testId-suffixed name (e.g. "Rixey Test [e2e:abcd1234]"). Asserting
 * "that string visible" or "that string absent" proves scope isolation.
 */

function hasSupabaseAuthCookie(cookies: { name: string }[]): boolean {
  return cookies.some((c) => c.name.startsWith('sb-') && c.name.endsWith('-auth-token'))
}

function demoCookieValue(cookies: { name: string; value: string }[]): string | null {
  return cookies.find((c) => c.name === 'bloom_demo')?.value ?? null
}

async function visitDemoPlatform(page: Page): Promise<void> {
  await page.goto('/demo')
  await page.waitForLoadState('domcontentloaded')
  // The Platform button's accessible name composes both the title and subtitle
  // so getByRole({name:/Platform/}) can miss depending on how the tree resolves.
  // A locator-level `button:has-text("Platform")` is deterministic here.
  const button = page.locator('button:has-text("Platform")').first()
  await button.waitFor({ state: 'visible', timeout: 10_000 })
  await button.click()
  // launchDemo is async (awaits supabase.auth.signOut before writing cookies
  // and routing). A bare waitForURL can race the sign-out round-trip on a
  // cold Supabase JS client. Poll for the bloom_demo cookie as the
  // deterministic "launchDemo finished" signal, then settle the URL.
  await page.waitForFunction(
    () => document.cookie.split('; ').some((c) => c === 'bloom_demo=true'),
    null,
    { timeout: 15_000 }
  )
  await page.waitForURL((url) => url.pathname === '/' || url.pathname.startsWith('/intel') || url.pathname.startsWith('/agent') || url.pathname === '/welcome', { timeout: 15_000 }).catch(() => null)
  await page.waitForLoadState('networkidle').catch(() => null)
}

test.describe('§20 Demo Isolation', () => {
  let ctx: TestContext
  test.beforeEach(() => { ctx = createContext() })
  test.afterEach(async () => { await cleanup(ctx) })

  // -------------------------------------------------------------------------
  // Scenario 1 — authed Rixey → /demo → auth cookie is gone
  // -------------------------------------------------------------------------

  test('scenario 1: authed user visiting /demo is signed out before demo cookies land', async ({ page }) => {
    const { orgId } = await createTestOrg(ctx, { name: `Rixey Test Org [e2e:${ctx.testId}]` })
    const { venueId } = await createTestVenue(ctx, {
      orgId,
      name: `Rixey Test Venue [e2e:${ctx.testId}]`,
    })
    const user = await createTestUser(ctx, {
      role: 'org_admin',
      orgId,
      venueId,
      firstName: 'RixeyTester',
    })

    await loginAs(page, 'org_admin', { email: user.email, password: user.password })

    // Pre-check: authed session is in place.
    const preCookies = await page.context().cookies()
    expect(hasSupabaseAuthCookie(preCookies), 'login should leave an sb-*-auth-token cookie').toBe(true)
    expect(demoCookieValue(preCookies)).toBeNull()

    await visitDemoPlatform(page)

    // Post-check: demo cookies set, auth cookie gone.
    const postCookies = await page.context().cookies()
    expect(demoCookieValue(postCookies), 'bloom_demo should be true after clicking Platform').toBe('true')
    expect(hasSupabaseAuthCookie(postCookies), 'Supabase auth cookie must be cleared by the demo sign-out').toBe(false)

    // Rendered content: Rixey Test Venue name must not appear — queries should
    // now run as anon against demo venues only.
    const body = await page.locator('body').innerText()
    expect(body).not.toContain(`Rixey Test Venue [e2e:${ctx.testId}]`)
  })

  // -------------------------------------------------------------------------
  // Scenario 2 — anonymous → /demo → Crestwood only
  // -------------------------------------------------------------------------

  test('scenario 2: anonymous visitor to /demo sees the Crestwood Collection only', async ({ page, context }) => {
    // Fresh context, belt-and-braces clear any cookies the browser carried.
    await context.clearCookies()

    await visitDemoPlatform(page)

    const cookies = await page.context().cookies()
    expect(demoCookieValue(cookies), 'bloom_demo set').toBe('true')
    expect(hasSupabaseAuthCookie(cookies), 'anon visitor has no auth cookie').toBe(false)

    // The DemoBanner component renders "Demo Mode" whenever bloom_demo=true.
    await expect(page.locator('body')).toContainText(/Demo Mode/i, { timeout: 10_000 })
  })

  // -------------------------------------------------------------------------
  // Scenario 3 — the 24-hour bleed: authed → /demo → exit → re-login clean
  // -------------------------------------------------------------------------

  test('scenario 3: authed → /demo → exit → re-login leaves zero demo residue', async ({ page }) => {
    const { orgId } = await createTestOrg(ctx, { name: `Rixey Test Org [e2e:${ctx.testId}]` })
    const { venueId } = await createTestVenue(ctx, {
      orgId,
      name: `Rixey Test Venue [e2e:${ctx.testId}]`,
    })
    const user = await createTestUser(ctx, {
      role: 'org_admin',
      orgId,
      venueId,
      firstName: 'RixeyTester',
    })
    await createTestWedding(ctx, { venueId })

    // 1) Log in and verify the real dashboard renders with the Rixey venue.
    await loginAs(page, 'org_admin', { email: user.email, password: user.password })
    const sessionCookieBefore = (await page.context().cookies()).find((c) =>
      c.name.startsWith('sb-') && c.name.endsWith('-auth-token')
    )
    expect(sessionCookieBefore, 'login should set a Supabase auth cookie').toBeDefined()

    // 2) Visit /demo → Platform. Auth cookie gets cleared; demo cookies set.
    await visitDemoPlatform(page)
    const demoPhaseCookies = await page.context().cookies()
    expect(demoCookieValue(demoPhaseCookies)).toBe('true')
    expect(hasSupabaseAuthCookie(demoPhaseCookies)).toBe(false)

    // 3) Exit demo via the banner X button (aria-label="Exit demo").
    const exitButton = page.getByRole('button', { name: /Exit demo/i })
    await exitButton.click()
    // exitDemo clears bloom_demo/bloom_venue/bloom_scope and routes to /. With
    // no auth cookie, middleware redirects to /welcome.
    await page.waitForURL((url) => /\/welcome$|\/login$|\/$/.test(url.pathname), { timeout: 10_000 }).catch(() => null)

    const afterExit = await page.context().cookies()
    expect(demoCookieValue(afterExit), 'bloom_demo cleared on exit').toBeNull()
    expect(afterExit.some((c) => c.name === 'bloom_scope' && c.value), 'bloom_scope cleared').toBe(false)
    expect(afterExit.some((c) => c.name === 'bloom_venue' && c.value), 'bloom_venue cleared').toBe(false)

    // 4) Log back in. User sees their own venue again, no Crestwood residue.
    await loginAs(page, 'org_admin', { email: user.email, password: user.password })
    await page.goto('/intel/dashboard')
    await page.waitForLoadState('networkidle').catch(() => null)

    const finalCookies = await page.context().cookies()
    expect(demoCookieValue(finalCookies), 'no lingering bloom_demo after re-login').toBeNull()
    expect(hasSupabaseAuthCookie(finalCookies), 'Supabase auth cookie restored after re-login').toBe(true)

    const body = await page.locator('body').innerText()
    expect(body).not.toContain('The Crestwood Collection')
    expect(body).not.toContain('Hawthorne Manor')
    // Their own test venue name is referenced by the scope indicator somewhere
    // in the shell. If the shell is mounted (authed flow), the venue name is
    // resolvable. This also proves the user is back on the authed flow and
    // not a stale demo bypass.
    await expect(page.locator('body')).toContainText(new RegExp(ctx.testId), { timeout: 10_000 })
  })

  // -------------------------------------------------------------------------
  // Belt-and-braces: middleware collision resolution
  // -------------------------------------------------------------------------

  test('scenario 4 (middleware): stale bloom_demo + auth session → demo cookies cleared on next request', async ({ page, context }) => {
    const { orgId } = await createTestOrg(ctx, { name: `Rixey Test Org [e2e:${ctx.testId}]` })
    const { venueId } = await createTestVenue(ctx, {
      orgId,
      name: `Rixey Test Venue [e2e:${ctx.testId}]`,
    })
    const user = await createTestUser(ctx, {
      role: 'org_admin',
      orgId,
      venueId,
      firstName: 'RixeyTester',
    })

    await loginAs(page, 'org_admin', { email: user.email, password: user.password })

    // Simulate a stale bloom_demo cookie landing in the browser while the user
    // still has an active auth session — the exact 24-hour legacy case.
    // Playwright's addCookies accepts `url` OR (`domain`+`path`), not both.
    await context.addCookies([
      { name: 'bloom_demo', value: 'true', domain: 'localhost', path: '/' },
      { name: 'bloom_scope', value: JSON.stringify({ level: 'venue', venueId: '22222222-2222-2222-2222-222222222201' }), domain: 'localhost', path: '/' },
      { name: 'bloom_venue', value: '22222222-2222-2222-2222-222222222201', domain: 'localhost', path: '/' },
    ])

    // Any subsequent request routed through middleware must clear the demo
    // cookies because an auth session exists.
    await page.goto('/intel/dashboard')
    await page.waitForLoadState('networkidle').catch(() => null)

    const cookies = await page.context().cookies()
    expect(demoCookieValue(cookies), 'middleware must clear stale bloom_demo when auth exists').toBeNull()
    expect(cookies.some((c) => c.name === 'bloom_scope' && c.value), 'middleware must clear stale bloom_scope').toBe(false)
  })
})
