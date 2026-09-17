import { test, expect, type Page } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { adminClient } from '../helpers/seed'
import { loginAs } from '../helpers/auth'
import {
  journey,
  SEEDED,
  haveCreds,
  missingCredsReason,
  DEMO_VENUE_SLUG,
  type Journey,
} from '../helpers/journey'

/**
 * §32 Public surfaces — journey 32 of E2E-PLAN.md.
 *
 * "`/api/public/demo-snapshot` with an allowed origin returns the fixed
 * demo venue and refuses another origin; the wedding website with a site
 * password via POST; the vendor portal token." Proves W58, S1 and S5.
 * The `/join/contract` expiry test went with W57 on 2026-09-17.
 *
 * What it needs from the branch:
 *
 *   PUBLIC_DEMO_ALLOWED_ORIGINS  — without it EVERY origin is refused and
 *                                  only the no-Origin case can pass
 *   E2E_CONTRACT_EXPIRED_TOKEN   — the 31-day fixture the seed writes
 *   E2E_COORDINATOR_EMAIL / _PASSWORD — for the vendor page, see below
 *
 * Where the plan's prose and the code differ:
 *
 *   1. The site password sets no cookie and returns no redirect. It
 *      answers 200 either way: `{ password_required: true }` with the
 *      wrong password, the full payload with the right one. So the
 *      assertion is on the body, not on a session.
 *   2. The `?pw=` deprecation is a server-side `console.warn` and nothing
 *      else — no response header, no body field, no logger event. A
 *      browser test cannot see it, and `playwright.config.ts` pipes
 *      stderr but ignores stdout, which is where `console.warn` goes. So
 *      the test asserts the thing it CAN see — the deprecated form still
 *      works and answers identically — and says plainly that the warning
 *      itself is not observable from here.
 *   3. `/vendor/[token]` is not in the middleware's public list, so an
 *      unauthenticated request is redirected to `/login`. That looks like
 *      a bug for a link emailed to a florist. It is asserted as the
 *      current behaviour, loudly, so it cannot change unnoticed; the page
 *      itself is then checked with a session.
 */

const SECTION = '32_public_surfaces'
const HAVE_COORD = haveCreds(SEEDED.coordinator)
const NO_COORD = missingCredsReason('COORDINATOR')

/** The first origin in PUBLIC_DEMO_ALLOWED_ORIGINS, if the branch has one. */
const ALLOWED_ORIGIN = (process.env.PUBLIC_DEMO_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)[0]

const DISALLOWED_ORIGIN = 'https://not-allowed.e2e.invalid'

/** The site-password fixture this journey owns. */
const SITE_SLUG = `e2e-32-${randomBytes(3).toString('hex')}`
const SITE_PASSWORD = 'open-sesame-32'
let siteRowId: string | null = null

/** The vendor-portal fixture this journey owns. */
const VENDOR_TOKEN = randomBytes(16).toString('hex')
const VENDOR_NAME = 'E2E Florist 32'
let vendorRowId: string | null = null

function publicSurfaces(page: Page): Journey {
  return journey(page, SECTION, { allowRequests: [/\/api\/auth\/session/] })
}

test.describe('§32 Public surfaces', () => {
  test.beforeAll(async () => {
    const sb = adminClient()

    const { data: site } = await sb
      .from('wedding_website_settings')
      .insert({
        venue_id: SEEDED.ashcombeVenueId,
        wedding_id: SEEDED.ashcombeWeddingId,
        slug: SITE_SLUG,
        is_published: true,
        couple_names: 'Wren and Ari',
        // Stored in plain text on purpose (migration 387 says so).
        // `sitePasswordMatches` sha256s both sides before comparing, so
        // a plaintext seed and a digest seed both work.
        site_password: SITE_PASSWORD,
      })
      .select('id')
      .maybeSingle<{ id: string }>()
    siteRowId = site?.id ?? null

    const { data: vendor } = await sb
      .from('booked_vendors')
      .insert({
        venue_id: SEEDED.ashcombeVenueId,
        wedding_id: SEEDED.ashcombeWeddingId,
        vendor_name: VENDOR_NAME,
        vendor_type: 'florist',
        portal_token: VENDOR_TOKEN,
        portal_token_issued_at: new Date().toISOString(),
      })
      .select('id')
      .maybeSingle<{ id: string }>()
    vendorRowId = vendor?.id ?? null
  })

  test.afterAll(async () => {
    const sb = adminClient()
    if (siteRowId) await sb.from('wedding_website_settings').delete().eq('id', siteRowId)
    if (vendorRowId) await sb.from('booked_vendors').delete().eq('id', vendorRowId)
  })

  // -------------------------------------------------------------------------
  // The demo snapshot
  // -------------------------------------------------------------------------

  test('the demo snapshot serves an allowed origin and refuses another', async ({ page }) => {
    const j = publicSurfaces(page)
    // The refusal is the point of the test, so it is not a defect.
    j.allowRequest(/\/api\/public\/demo-snapshot/)

    await j.step('a disallowed origin is turned away', async () => {
      const res = await page.request.get('/api/public/demo-snapshot', {
        headers: { Origin: DISALLOWED_ORIGIN },
        failOnStatusCode: false,
      })
      // Refused before the rate limiter and before any database read.
      expect(res.status(), `a foreign origin answered ${res.status()}`).toBe(403)
      expect((await res.json()) as unknown).toEqual({ error: 'Origin not allowed' })
    })

    await j.step('an allowed origin gets the fixed demo venue', async () => {
      test.skip(
        !ALLOWED_ORIGIN,
        'PUBLIC_DEMO_ALLOWED_ORIGINS is not set on the branch env, so every ' +
          'browser-originated request is refused and there is no allowed case to check. ' +
          'E2E-PLAN.md lists it among the branch secrets.'
      )
      const res = await page.request.get('/api/public/demo-snapshot', {
        headers: { Origin: ALLOWED_ORIGIN },
        failOnStatusCode: false,
      })
      expect(res.status(), `the allowed origin answered ${res.status()}`).toBe(200)
      expect(res.headers()['access-control-allow-origin']).toBe(ALLOWED_ORIGIN)
      expect(res.headers()['vary'] ?? '').toContain('Origin')

      // The venue is hardcoded — there is no venueId parameter — and
      // the route re-reads `venues.is_demo` and refuses anything that is
      // not literally true. So this is the one venue it can ever be.
      const body = (await res.json()) as {
        venue?: { slug?: string }
        today?: Record<string, { count: number }>
        monthlyStory?: unknown[]
      }
      expect(body.venue?.slug, 'the snapshot served a venue that is not the demo one').toBe(
        DEMO_VENUE_SLUG
      )
      for (const block of ['needsReply', 'goingCold', 'toursThisWeek', 'highIntent']) {
        expect(body.today?.[block], `the snapshot is missing the ${block} block`).toBeTruthy()
      }
      expect(Array.isArray(body.monthlyStory)).toBe(true)
    })

    await j.end()
  })

  // -------------------------------------------------------------------------
  // The wedding website site password
  // -------------------------------------------------------------------------

  test('the site password works as a POST, and the query form still answers', async ({ page }) => {
    const j = publicSurfaces(page)
    test.skip(!siteRowId, 'the wedding website fixture could not be seeded')

    await j.step('the wrong password is told only that one is needed', async () => {
      const res = await page.request.post(
        `/api/public/wedding-website?slug=${SITE_SLUG}&action=site_password`,
        { data: { pw: 'not-the-password' }, failOnStatusCode: false }
      )
      // 200 either way: there is no 401 on this route. A wrong password
      // gets the gate, not the payload, and leaks nothing but the names.
      expect(res.status()).toBe(200)
      const body = (await res.json()) as { password_required?: boolean; website?: unknown }
      expect(body.password_required).toBe(true)
      expect(body.website, 'a wrong password saw the website payload').toBeUndefined()
    })

    await j.step('the right password via POST opens the site', async () => {
      const res = await page.request.post(
        `/api/public/wedding-website?slug=${SITE_SLUG}&action=site_password`,
        { data: { pw: SITE_PASSWORD }, failOnStatusCode: false }
      )
      expect(res.status()).toBe(200)
      const body = (await res.json()) as { password_required?: boolean; website?: unknown }
      expect(body.password_required, 'the right password was still gated').toBeUndefined()
      expect(body.website, 'the right password did not get the website').toBeTruthy()
    })

    await j.step('the deprecated ?pw= form answers the same, and is deprecated', async () => {
      // The deprecation is a console.warn on the server. It is not a
      // header, not a body field, and not a logger event, and
      // playwright.config.ts ignores the server's stdout, so a browser
      // test cannot observe it. What IS observable is that the old form
      // still works — which is what deprecated means, and what a caller
      // still on it depends on.
      const res = await page.request.get(
        `/api/public/wedding-website?slug=${SITE_SLUG}&pw=${encodeURIComponent(SITE_PASSWORD)}`,
        { failOnStatusCode: false }
      )
      expect(res.status()).toBe(200)
      const body = (await res.json()) as { password_required?: boolean; website?: unknown }
      expect(body.password_required).toBeUndefined()
      expect(body.website).toBeTruthy()
      test.info().annotations.push({
        type: 'not-asserted',
        description:
          'the ?pw= deprecation warning is a server console.warn with no wire signal; ' +
          'cover it in a vitest unit test for src/app/api/public/wedding-website/route.ts',
      })
    })

    await j.end()
  })

  // -------------------------------------------------------------------------
  // The vendor portal token
  // -------------------------------------------------------------------------

  test('a vendor portal token page renders', async ({ page }) => {
    test.skip(!HAVE_COORD, NO_COORD)
    test.skip(!vendorRowId, 'the vendor fixture could not be seeded')
    const j = publicSurfaces(page)

    await j.step('signed out, the link opens the vendor page', async () => {
      // src/middleware.ts lists /vendor among PUBLIC_ROUTES (added
      // 2026-09-15, wave 9 repair): a link emailed to a florist must
      // open without a Bloom House login, since the token is the
      // credential. Asserted so it cannot drift back to a login bounce.
      await page.context().clearCookies()
      await page.goto(`/vendor/${VENDOR_TOKEN}`)
      await page.waitForLoadState('domcontentloaded')
      expect(
        new URL(page.url()).pathname,
        'the vendor page bounced a signed-out visitor; /vendor must stay in PUBLIC_ROUTES'
      ).toBe(`/vendor/${VENDOR_TOKEN}`)
      await expect(page.getByText('Vendor Portal', { exact: false })).toBeVisible({
        timeout: 30_000,
      })
    })

    await j.step('the API behind it is public and honours the token', async () => {
      const res = await page.request.get(`/api/vendor-portal/${VENDOR_TOKEN}`, {
        failOnStatusCode: false,
      })
      expect(res.status(), `the vendor API answered ${res.status()}`).toBe(200)
      const body = (await res.json()) as { vendor?: { vendor_name?: string } }
      expect(JSON.stringify(body)).toContain(VENDOR_NAME)
    })

    await j.step('with a session, the page renders the vendor', async () => {
      await loginAs(page, 'coordinator', SEEDED.coordinator)
      await page.goto(`/vendor/${VENDOR_TOKEN}`)
      await page.waitForLoadState('domcontentloaded')
      await expect(page.getByText('Vendor Portal', { exact: false })).toBeVisible({
        timeout: 30_000,
      })
      await expect(page.getByRole('heading', { name: VENDOR_NAME })).toBeVisible()
      await expect(page.getByText("This link is unique to you", { exact: false })).toBeVisible()
    })

    await j.step('an unknown token is not found', async () => {
      const res = await page.request.get(`/api/vendor-portal/${'0'.repeat(32)}`, {
        failOnStatusCode: false,
      })
      expect(res.status()).toBe(404)
    })

    await j.end()
  })

})
