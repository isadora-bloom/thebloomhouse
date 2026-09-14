import { test, expect, APIRequestContext, Browser } from '@playwright/test'
import { adminClient, createContext, seedBasicGraph, cleanup } from '../helpers/seed'
import { loginAsApi, ApiAuthHandle } from '../helpers/api-auth'
import { loginAs } from '../helpers/auth'

/**
 * §29 Security regressions — journey 29 of E2E-PLAN.md.
 *
 * Every assertion here is a hole that SECURITY-AUDIT-2026-09-14.md found
 * and S1 to S5 closed. The point of the section is that they stay closed:
 * each test names the finding, so a failure reads as "SEC-xx is open
 * again" rather than "something returned the wrong number".
 *
 * What it needs from the branch (scripts/e2e-seed.ts prints all of it):
 *
 *   E2E_COORDINATOR_EMAIL / E2E_COORDINATOR_PASSWORD  — Ashcombe Barn
 *   E2E_ASHCOMBE_VENUE_ID, E2E_ASHCOMBE_WEDDING_ID
 *
 * and the Crestwood demo set for the "other venue" half. Without the
 * coordinator credentials the cross-venue tests skip with a reason rather
 * than passing vacuously — a security spec that quietly passes because it
 * could not log in is worse than no spec.
 */

// --- the fixture ids --------------------------------------------------------

const ASHCOMBE_VENUE_ID =
  process.env.E2E_ASHCOMBE_VENUE_ID ?? 'a5c0b0e0-0000-4000-8000-000000000010'
const ASHCOMBE_WEDDING_ID =
  process.env.E2E_ASHCOMBE_WEDDING_ID ?? 'a5c0b0e0-0000-4000-8000-000000000020'

/** Hawthorne Manor, from supabase/seed.sql. The venue the caller is NOT. */
const OTHER_VENUE_ID = '22222222-2222-2222-2222-222222222201'

const COORDINATOR = {
  email: process.env.E2E_COORDINATOR_EMAIL ?? '',
  password: process.env.E2E_COORDINATOR_PASSWORD ?? '',
}
const HAVE_COORDINATOR = Boolean(COORDINATOR.email && COORDINATOR.password)
const NO_COORDINATOR_REASON =
  'E2E_COORDINATOR_EMAIL / E2E_COORDINATOR_PASSWORD are not set. Run scripts/e2e-seed.ts --apply and paste the printed env lines.'

/** The six headers next.config.ts ships on /:path*. */
const SECURITY_HEADERS = [
  'content-security-policy',
  'x-frame-options',
  'strict-transport-security',
  'referrer-policy',
  'x-content-type-options',
  'permissions-policy',
]

// --- helpers ----------------------------------------------------------------

/** An agency owned by the other venue, created for the [id] cluster test. */
let otherAgencyId: string | null = null

/** The other venue's first wedding, for the wedding-id routes. */
let otherWeddingId: string | null = null

async function loginCoordinator(browser: Browser): Promise<ApiAuthHandle> {
  return loginAsApi(browser, 'coordinator', COORDINATOR, { venueId: ASHCOMBE_VENUE_ID })
}

/** Status codes that mean "refused", for a route that may answer either. */
function expectRefused(status: number, label: string) {
  expect(
    [403, 404],
    `${label} answered ${status}. A cross-venue id must be refused with 403 or 404.`
  ).toContain(status)
}

test.describe('§29 Security regressions (S1 to S5)', () => {
  test.beforeAll(async () => {
    const sb = adminClient()

    const { data: wedding } = await sb
      .from('weddings')
      .select('id')
      .eq('venue_id', OTHER_VENUE_ID)
      .limit(1)
      .maybeSingle<{ id: string }>()
    otherWeddingId = wedding?.id ?? null

    // An agency the caller must not be able to reach. Created here rather
    // than assumed from the demo seed so the test says what it depends on.
    const { data: agency } = await sb
      .from('marketing_agencies')
      .upsert(
        {
          id: 'a9e0c0de-0000-4000-8000-0000000000a1',
          venue_id: OTHER_VENUE_ID,
          name: 'Other Venue Agency [e2e:29]',
        },
        { onConflict: 'id' }
      )
      .select('id')
      .maybeSingle<{ id: string }>()
    otherAgencyId = agency?.id ?? null
  })

  test.afterAll(async () => {
    if (otherAgencyId) {
      await adminClient().from('marketing_agencies').delete().eq('id', otherAgencyId)
    }
  })

  // -------------------------------------------------------------------------
  // SEC — the /demo/api credential-granting prefix (S1)
  // -------------------------------------------------------------------------

  test('/demo/api/** is 404 — the rewrite never reaches an API route', async ({ request }) => {
    // The demo rewrite mints a signed demo token and attaches it to the
    // request. Reaching /api through it was a credential-granting prefix
    // on the whole API surface. src/middleware.ts answers 404 outright.
    for (const path of [
      '/demo/api/agent/send',
      '/demo/api',
      '/demo/api/team/invite',
      '/demo/api/agent/wipe-pipeline-data',
    ]) {
      const res = await request.get(path)
      expect(res.status(), `${path} must be 404`).toBe(404)
    }
  })

  test('a demo session is refused on a mutating route', async ({ browser }) => {
    const context = await browser.newContext()
    try {
      // GET /demo/ takes the rewrite, which sets bloom_demo plus the
      // signed demo token on the context.
      const entry = await context.request.get('/demo/')
      expect(entry.status(), 'GET /demo/ should render the demo dashboard').toBeLessThan(400)
      const cookies = await context.cookies()
      expect(
        cookies.some((c) => c.name === 'bloom_demo'),
        'the demo rewrite should have set bloom_demo'
      ).toBe(true)

      const res = await context.request.post('/api/agent/wipe-pipeline-data?confirm=YES')
      expect(
        res.status(),
        'the demo identity deletes nothing — refuseDemo() answers 403'
      ).toBe(403)
    } finally {
      await context.close()
    }
  })

  // -------------------------------------------------------------------------
  // SEC-C3 — /api/team/invite had no authentication at all (S1)
  // -------------------------------------------------------------------------

  test('POST /api/team/invite without a session is 401', async ({ request }) => {
    const res = await request.post('/api/team/invite', {
      data: { email: 'nobody@example.test', role: 'coordinator' },
      failOnStatusCode: false,
    })
    expect(res.status()).toBe(401)
  })

  test('POST /api/team/invite with a coordinator session is 403', async ({ browser }) => {
    test.skip(!HAVE_COORDINATOR, NO_COORDINATOR_REASON)
    const handle = await loginCoordinator(browser)
    try {
      const res = await handle.request.post('/api/team/invite', {
        data: { email: 'nobody@example.test', role: 'coordinator' },
        failOnStatusCode: false,
      })
      expect(
        res.status(),
        'inviting is org_admin or super_admin only — a coordinator is 403'
      ).toBe(403)
    } finally {
      await handle.close()
    }
  })

  // -------------------------------------------------------------------------
  // SEC-H23 + SEC-C7 — the eight trusted-id route groups (S1, S5)
  //
  // Each of these took a venue id or a wedding id straight from the
  // request and went to the database with the service-role client.
  // -------------------------------------------------------------------------

  test.describe('trusted-id routes refuse another venue', () => {
    let handle: ApiAuthHandle
    let request: APIRequestContext

    test.beforeEach(async ({ browser }) => {
      test.skip(!HAVE_COORDINATOR, NO_COORDINATOR_REASON)
      handle = await loginCoordinator(browser)
      request = handle.request
    })

    test.afterEach(async () => {
      if (handle) await handle.close()
    })

    test('1/8 POST /api/intel/positioning with another venue id', async () => {
      const res = await request.post('/api/intel/positioning', {
        data: { venueId: OTHER_VENUE_ID },
        failOnStatusCode: false,
      })
      expectRefused(res.status(), 'intel/positioning')
    })

    test('2/8 GET /api/intel/weekly-learned?venue_id=other', async () => {
      const res = await request.get(`/api/intel/weekly-learned?venue_id=${OTHER_VENUE_ID}`, {
        failOnStatusCode: false,
      })
      expectRefused(res.status(), 'intel/weekly-learned')
    })

    test('3/8 GET /api/intel/agencies?venue_id=other', async () => {
      const res = await request.get(`/api/intel/agencies?venue_id=${OTHER_VENUE_ID}`, {
        failOnStatusCode: false,
      })
      expectRefused(res.status(), 'intel/agencies')
    })

    test('4/8 POST /api/tracking with another venue id, and nothing is recorded', async () => {
      const sb = adminClient()
      const before = await sb
        .from('engagement_events')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', OTHER_VENUE_ID)

      const res = await request.post('/api/tracking', {
        data: { action: 'tour_booked', venueId: OTHER_VENUE_ID },
        failOnStatusCode: false,
      })
      expectRefused(res.status(), 'tracking')

      const after = await sb
        .from('engagement_events')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', OTHER_VENUE_ID)
      expect(after.count ?? 0, 'the refused call must not have recorded anything').toBe(
        before.count ?? 0
      )
    })

    test('5/8 GET /api/portal/section-config?venue_id=other', async () => {
      const res = await request.get(`/api/portal/section-config?venue_id=${OTHER_VENUE_ID}`, {
        failOnStatusCode: false,
      })
      expectRefused(res.status(), 'portal/section-config')
      if (res.status() === 200) {
        // Belt and braces: if the route ever answers 200 again, say what
        // leaked rather than only that the status was wrong.
        const body = (await res.json()) as { data?: { venue_id?: string }[] }
        expect(
          body.data ?? [],
          'section-config handed back another venue portal configuration'
        ).toEqual([])
      }
    })

    test('6/8 POST /api/portal/invite-couple for another venue wedding, and nothing is stamped', async () => {
      test.skip(!otherWeddingId, 'the demo seed produced no wedding for the other venue')
      const sb = adminClient()
      const before = await sb
        .from('weddings')
        .select('couple_invited_at')
        .eq('id', otherWeddingId!)
        .maybeSingle<{ couple_invited_at: string | null }>()

      const res = await request.post('/api/portal/invite-couple', {
        data: { weddingId: otherWeddingId },
        failOnStatusCode: false,
      })
      expectRefused(res.status(), 'portal/invite-couple')

      const after = await sb
        .from('weddings')
        .select('couple_invited_at')
        .eq('id', otherWeddingId!)
        .maybeSingle<{ couple_invited_at: string | null }>()
      expect(
        after.data?.couple_invited_at ?? null,
        'the refused invite must not have stamped couple_invited_at'
      ).toBe(before.data?.couple_invited_at ?? null)
    })

    test('7/8 POST /api/admin/lifecycle/apply for another venue wedding, and the row is untouched', async () => {
      test.skip(!otherWeddingId, 'the demo seed produced no wedding for the other venue')
      const sb = adminClient()
      const before = await sb
        .from('weddings')
        .select('status, updated_at')
        .eq('id', otherWeddingId!)
        .maybeSingle<{ status: string; updated_at: string | null }>()

      const res = await request.post('/api/admin/lifecycle/apply', {
        data: { weddingId: otherWeddingId },
        failOnStatusCode: false,
      })
      expectRefused(res.status(), 'admin/lifecycle/apply')

      const after = await sb
        .from('weddings')
        .select('status, updated_at')
        .eq('id', otherWeddingId!)
        .maybeSingle<{ status: string; updated_at: string | null }>()
      expect(after.data?.status).toBe(before.data?.status)
      expect(after.data?.updated_at ?? null).toBe(before.data?.updated_at ?? null)
    })

    test('8/8 GET /api/intel/agencies/[id]/contacts for another venue agency', async () => {
      test.skip(!otherAgencyId, 'could not seed an agency for the other venue')
      const res = await request.get(`/api/intel/agencies/${otherAgencyId}/contacts`, {
        failOnStatusCode: false,
      })
      expectRefused(res.status(), 'intel/agencies/[id]/contacts')
    })
  })

  // -------------------------------------------------------------------------
  // SEC — unsigned webhook deliveries (S5)
  // -------------------------------------------------------------------------

  test('an unsigned Stripe delivery is refused without doing any work', async ({ request }) => {
    const res = await request.post('/api/webhooks/stripe', {
      data: { id: 'evt_e2e_unsigned', type: 'checkout.session.completed' },
      failOnStatusCode: false,
    })
    // 503 when STRIPE_WEBHOOK_SECRET is unset (the route refuses to
    // pretend it can verify anything), 401 when it IS set and the
    // signature header is missing. Both are "refused before any
    // handler ran", which is the property under test; which one you
    // get is a fact about the branch env, not about the code.
    expect([401, 503], `stripe webhook answered ${res.status()}`).toContain(res.status())
  })

  test('an unsigned Calendly delivery is refused without doing any work', async ({ request }) => {
    const res = await request.post('/api/webhooks/calendly', {
      data: { event: 'invitee.created', payload: {} },
      failOnStatusCode: false,
    })
    expect([401, 503], `calendly webhook answered ${res.status()}`).toContain(res.status())
  })

  // -------------------------------------------------------------------------
  // SEC — the header block on /:path* (S5)
  // -------------------------------------------------------------------------

  test('every response carries the security headers', async ({ request }) => {
    const paths = ['/welcome', '/login', '/api/public/demo-snapshot', '/demo/api/agent/send']
    for (const path of paths) {
      const res = await request.get(path, { failOnStatusCode: false })
      const headers = res.headers()
      for (const name of SECURITY_HEADERS) {
        expect(headers[name], `${path} is missing ${name}`).toBeTruthy()
      }
      expect(headers['x-frame-options']).toBe('DENY')
      expect(headers['x-content-type-options']).toBe('nosniff')
      expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
      expect(headers['content-security-policy']).toContain("frame-ancestors 'none'")
    }
  })

  // -------------------------------------------------------------------------
  // SEC — CSV formula injection (S5, audit item 3)
  // -------------------------------------------------------------------------

  test('a guest named =1+1 exports as a quoted cell starting with an apostrophe', async ({
    page,
  }) => {
    // A throwaway graph rather than the Ashcombe fixture: the export is a
    // client-side download off the couple portal, so the test needs a
    // couple it can log in as, and the fixture's couple invitation has
    // deliberately not been redeemed.
    const ctx = createContext()
    const marker = `e2e29-${Date.now()}`
    const sb = adminClient()
    try {
      const graph = await seedBasicGraph(ctx)
      await sb.from('wedding_config').upsert(
        { venue_id: graph.venueId, wedding_id: graph.wedding.weddingId, plated_meal: true },
        { onConflict: 'venue_id,wedding_id' }
      )
      const { error } = await sb.from('guest_list').insert({
        venue_id: graph.venueId,
        wedding_id: graph.wedding.weddingId,
        first_name: '=1+1',
        last_name: marker,
        rsvp_status: 'pending',
      })
      if (error) throw new Error(`could not seed the guest: ${error.message}`)

      await loginAs(page, 'couple', {
        email: graph.wedding.coupleEmail,
        password: graph.wedding.couplePassword,
        slug: graph.slug,
      })
      await page.goto(`/couple/${graph.slug}/guests`)
      await page.waitForLoadState('domcontentloaded')
      await expect(page.getByText(marker)).toBeVisible({ timeout: 20_000 })

      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 20_000 }),
        page.getByRole('button', { name: /^export$/i }).click(),
      ])
      const file = await download.path()
      const fs = await import('node:fs')
      const csv = fs.readFileSync(file!, 'utf8')

      const row = csv.split(/\r?\n/).find((l) => l.includes(marker))
      expect(row, 'the seeded guest should appear in the export').toBeTruthy()
      expect(
        row!.startsWith(`"'=1+1"`),
        `the formula cell was not neutralised: ${row}`
      ).toBe(true)
    } finally {
      await sb.from('guest_list').delete().eq('last_name', marker)
      await cleanup(ctx)
    }
  })

  // -------------------------------------------------------------------------
  // SEC — a literal "undefined" bearer token (S1)
  // -------------------------------------------------------------------------

  test('Authorization: Bearer undefined on an admin route is refused', async ({ request }) => {
    // The client-side "undefined" that a missing token stringifies to must
    // never be treated as a credential.
    for (const path of ['/api/admin/lifecycle/apply', '/api/team/invite']) {
      const res = await request.post(path, {
        headers: { Authorization: 'Bearer undefined' },
        data: { weddingId: ASHCOMBE_WEDDING_ID, email: 'nobody@example.test' },
        failOnStatusCode: false,
      })
      expect([401, 403], `${path} accepted a Bearer undefined (${res.status()})`).toContain(
        res.status()
      )
    }
  })

  // -------------------------------------------------------------------------
  // SEC — the public preview rate limit (S1 / GAP-H3)
  // -------------------------------------------------------------------------

  test('POST /api/public/sage-preview returns 429 after its per-IP limit', async ({ request }) => {
    // The limiter is durable (Postgres, sliding window) and has no test
    // hook — src/lib/rate-limit.ts exposes checkRateLimit and nothing
    // else. So this fires the real window: 30 requests an hour per IP.
    //
    // Two things keep it cheap. The rate-limit check is the FIRST thing
    // the route does, before the body is even parsed, so a request with
    // no venueSlug consumes a token and returns 400 without touching the
    // model or the venue. And the bucket key comes from
    // clientIpForRateLimit, which prefers x-real-ip — a header nothing
    // sets in front of a local `next start`, so the test can pin its own
    // bucket instead of getting a fresh UUID bucket per request.
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 20}`
    const headers = { 'x-real-ip': ip }

    let sawLimit = 0
    for (let i = 1; i <= 35; i++) {
      const res = await request.post('/api/public/sage-preview', {
        headers,
        data: {},
        failOnStatusCode: false,
      })
      if (res.status() === 429) {
        sawLimit = i
        expect(res.headers()['retry-after'], 'a 429 must say when to come back').toBeTruthy()
        break
      }
      expect(
        res.status(),
        `request ${i} should have been rejected for a missing venueSlug, not ${res.status()}`
      ).toBe(400)
    }

    expect(sawLimit, 'the per-IP limit never fired inside 35 requests').toBeGreaterThan(0)
    expect(sawLimit, 'the limit fired earlier than the documented 30 per hour').toBeGreaterThan(30)
  })
})
