import { test, expect } from '@playwright/test'
import { SupabaseClient } from '@supabase/supabase-js'
import {
  createContext,
  createTestOrg,
  createTestVenue,
  createTestUser,
  createTestWedding,
  cleanup,
  TestContext,
  adminClient,
} from '../helpers/seed'
import { loginAs } from '../helpers/auth'

/**
 * §3 COUPLE INVITATION & PORTAL ACCESS
 *
 * Covers:
 *   1. Coordinator POSTs /api/portal/invite-couple. Resend is intercepted
 *      (or falls back to console log when RESEND_API_KEY is absent). The
 *      response surfaces a `registerUrl` carrying the invitation token,
 *      and `weddings.couple_invited_at` is stamped.
 *   2. (Retired 2026-09-15) registration by event code. The register
 *      flow is invite-token gated and is covered by §27.
 *   3. Venue isolation: couple A logging into venue A cannot fetch venue B's
 *      wedding data. (Asserted by middleware path guard + data lookup.)
 *   4. Couple cannot reach platform routes `/agent`, `/intel`, `/portal`,
 *      `/settings`, `/onboarding`, `/setup` — middleware bounces them.
 *   5. The couple portal dashboard renders after registration (proves the
 *      end-to-end sign-in + people→wedding linkage works).
 *   6. (Retired 2026-09-15) manual `?code=` link; see §27.
 *
 * Strategy:
 *   - Resend interception: when RESEND_API_KEY is set, we hook
 *     `https://api.resend.com/**` via `context.route`. When absent, the
 *     email helper hits a dev-fallback (console.log) and returns `ok=true`
 *     — we still verify the API response.
 *   - All couple-side routes use path-based dev routing (/couple/{slug}/…).
 */

let _admin: SupabaseClient
function admin(): SupabaseClient {
  if (_admin) return _admin
  _admin = adminClient()
  return _admin
}

/**
 * Create a wedding WITHOUT a pre-existing couple user. The invite flow is
 * the thing that creates the couple. We seed a people partner1 row with
 * NO email (or a placeholder) so registration can rewrite it.
 */
async function createInvitableWedding(
  ctx: TestContext,
  opts: { venueId: string }
): Promise<{ weddingId: string; eventCode: string }> {
  const eventCode = `E2E-${ctx.testId.toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
  const weddingDate = new Date(Date.now() + 120 * 86400e3).toISOString().slice(0, 10)
  const { data, error } = await admin()
    .from('weddings')
    .insert({
      venue_id: opts.venueId,
      status: 'inquiry',
      wedding_date: weddingDate,
      guest_count_estimate: 100,
      event_code: eventCode,
      notes: `[e2e:${ctx.testId}]`,
    })
    .select('id')
    .single()
  if (error) throw new Error(`createInvitableWedding: ${error.message}`)
  ctx.createdWeddingIds.push(data.id)

  // Partner1 people row without email — registration will attach the email.
  const { data: p } = await admin()
    .from('people')
    .insert({
      venue_id: opts.venueId,
      wedding_id: data.id,
      role: 'partner1',
      first_name: 'Invite',
      last_name: `Couple-${ctx.testId}`,
      // The invite route reads the partner email off the spine, not the
      // request body ("No partner email on file" otherwise), so the seed
      // gives partner 1 one (2026-09-15).
      email: `couple-${ctx.testId}@test.thebloomhouse.com`,
    })
    .select('id')
    .single()
  if (p?.id) ctx.createdPeopleIds.push(p.id)

  return { weddingId: data.id, eventCode }
}

test.describe('§3 Couple Invitation & Portal Access', () => {
  let ctx: TestContext

  test.beforeEach(() => {
    ctx = createContext()
  })

  test.afterEach(async () => {
    await cleanup(ctx)
  })

  test('coordinator invite → registerUrl carries the invitation token; wedding stamped couple_invited_at', async ({
    page,
    context,
  }) => {
    test.setTimeout(90_000)
    const { orgId } = await createTestOrg(ctx)
    const { venueId, slug } = await createTestVenue(ctx, { orgId })
    const { weddingId, eventCode } = await createInvitableWedding(ctx, { venueId })

    // Intercept Resend if it gets called. Without RESEND_API_KEY the app
    // falls back to console.log and returns ok; the assertion below
    // tolerates both.
    const resendCalls: { url: string; body: string }[] = []
    await context.route('https://api.resend.com/**', async (route) => {
      const body = route.request().postData() ?? ''
      resendCalls.push({ url: route.request().url(), body })
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'email_e2e_mock' }),
      })
    })

    // The invite route is authenticated (S1): sign in as the venue's
    // coordinator before posting. Registering the coordinator here keeps
    // this test self-contained.
    const coordinator = await createTestUser(ctx, { role: 'coordinator', orgId, venueId })
    await loginAs(page, 'coordinator', { email: coordinator.email, password: coordinator.password })
    const resp = await page.request.post('/api/portal/invite-couple', {
      data: {
        weddingId,
        venueId,
        email: `couple-${ctx.testId}@test.thebloomhouse.com`,
        eventCode,
        coupleName: 'E2E Couple',
      },
    })
    expect(resp.ok(), `invite POST: ${resp.status()} ${await resp.text()}`).toBe(true)
    const payload = await resp.json()
    expect(payload.success).toBe(true)
    expect(payload.eventCode).toBe(eventCode)
    // The link carries partner 1's invitation token, not the event code:
    // registration is invite-gated (migration 391), and the code is a
    // display value on the coordinator side only.
    expect(payload.registerUrl).toContain(`/couple/${slug}/register?invite=`)
    expect(payload.registerUrl).not.toContain('?code=')

    // Wedding row should have couple_invited_at stamped
    const { data: wedding } = await admin()
      .from('weddings')
      .select('couple_invited_at')
      .eq('id', weddingId)
      .single()
    expect(wedding?.couple_invited_at).toBeTruthy()

    // Resend was either called (RESEND_API_KEY set) or fell back silently
    // (no key). Both are acceptable — we just assert no throw.
    // If Resend *was* called, the captured body should reference the code.
    if (resendCalls.length > 0) {
      const concat = resendCalls.map((r) => r.body).join('\n')
      expect(concat).toContain('/register?invite=')
    }
  })

  test('couple cannot access platform routes (/agent, /intel, /portal, /settings, /onboarding)', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    const { orgId } = await createTestOrg(ctx)
    const { venueId, slug } = await createTestVenue(ctx, { orgId })
    const wedding = await createTestWedding(ctx, { venueId })

    await loginAs(page, 'couple', {
      email: wedding.coupleEmail,
      password: wedding.couplePassword,
      slug,
    })

    const blockedPrefixes = ['/agent', '/intel', '/portal', '/settings', '/onboarding']
    for (const prefix of blockedPrefixes) {
      await page.goto(prefix, { waitUntil: 'domcontentloaded' })
      // Middleware redirects non-couple-role users → /login for platform routes
      const url = page.url()
      const redirected = /\/login(\?|$)/.test(url) || /\/couple\/[^/]+\/login/.test(url)
      expect(
        redirected,
        `expected couple to be bounced from ${prefix}, landed at ${url}`
      ).toBe(true)
    }
  })

  test('venue isolation: couple A cannot load venue B portal dashboard', async ({ browser }) => {
    test.setTimeout(120_000)

    // Two independent venues in two independent orgs
    const { orgId: orgA } = await createTestOrg(ctx)
    const { venueId: venueAId, slug: slugA } = await createTestVenue(ctx, { orgId: orgA })
    const weddingA = await createTestWedding(ctx, { venueId: venueAId })

    const { orgId: orgB } = await createTestOrg(ctx)
    const { slug: slugB } = await createTestVenue(ctx, { orgId: orgB })
    // No wedding seeded for venue B — we just need the slug to exist so the
    // URL resolves to a real route, then we prove couple A's session can't
    // see it.

    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      // Login as couple A at their own venue
      await loginAs(page, 'couple', {
        email: weddingA.coupleEmail,
        password: weddingA.couplePassword,
        slug: slugA,
      })
      // Prove couple A IS authenticated at their own slug first
      await page.goto(`/couple/${slugA}`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(2000)
      expect(page.url()).toContain(`/couple/${slugA}`)

      // Now jump to venue B's portal — useCoupleContext looks up
      // `people` where email = user.email AND venue_id = venueB.id,
      // which will return nothing. The dashboard will refuse to render
      // wedding data.
      await page.goto(`/couple/${slugB}`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(3000)

      // The body should NOT contain wedding-A-specific guest count / amount.
      // We check for the ABSENCE of a unique marker from wedding A's seed.
      const html = await page.content()
      // Wedding A seeded with notes `[e2e:<testId>]`; we don't render that,
      // but the `venue-slug` cookie now points at venueB so any wedding data
      // rendered must belong to venueB — and venueB has no wedding seeded,
      // so the page should not render wedding-specific numbers. We assert
      // the URL didn't redirect back to venue A.
      expect(page.url()).not.toContain(`/couple/${slugA}`)

      // DB-level invariant: there is no people row for couple A's email
      // in venue B.
      const { data: peopleInVenueB } = await admin()
        .from('people')
        .select('id')
        .eq('email', weddingA.coupleEmail)
        .eq('venue_id', (await admin()
          .from('venues')
          .select('id')
          .eq('slug', slugB)
          .single()
        ).data!.id)
      expect(peopleInVenueB ?? []).toHaveLength(0)

      // Page should not have rendered anything suggesting a wedding loaded
      // (e.g. we don't see unique-per-wedding strings from wedding A).
      expect(html).not.toContain(weddingA.coupleEmail)
    } finally {
      await page.close()
      await context.close()
    }
  })

  // Registration by event code was retired: /api/couple/register is gated
  // on the invitation token (couple_invites.token_hash, migration 391) and
  // `?code=` no longer pre-fills anything. The register, duplicate,
  // invalid-token and manual-link cases now live in §27, which drives the
  // real page with the seeded invitation. Removed 2026-09-15, not skipped.
})
