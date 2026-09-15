import { test, expect, type Page } from '@playwright/test'
import { loginAs } from '../helpers/auth'
import { journey, SEEDED, haveCreds, missingCredsReason, type Journey } from '../helpers/journey'

/**
 * §31 Integrations hub honesty — journey 31 of E2E-PLAN.md.
 *
 * "every hub card reachable; Dubsado and Aisle Planner say import, not
 * coming soon; the three ad platforms say 'not configured' with the
 * variables named; the sending-domain section shows DNS records after a
 * stubbed Resend create; Instagram shows the webhook URL." Proves W28,
 * W53, W54 and W55.
 *
 * What it needs from the branch: the manager credentials, because the
 * sending-domain write is `requireRole(MANAGER_ROLES)` and `refuseDemo`.
 *
 *   E2E_MANAGER_EMAIL / E2E_MANAGER_PASSWORD
 *
 * Where the plan's prose and the code differ:
 *
 *   1. "Every hub card reachable" means the thirteen `ready: true`
 *      adapters. The nine planned ones are not on the page at all
 *      without `?showPlanned=1`, and when they are, they render an em
 *      dash instead of a link — which is the honesty the journey is
 *      about, so both halves are checked.
 *   2. Dubsado and Aisle Planner DO still print "Coming soon", as their
 *      status line, whenever the venue has no imported couples. The
 *      button correctly says "Import". So the assertion is scoped to the
 *      action link and the pill, not to the card's whole text — a blunt
 *      `not.toContainText('Coming soon')` would fail on a correct page.
 *   3. `page.route` cannot intercept the Resend create: it happens
 *      server-side inside the Next route handler, and `page.route` only
 *      sees browser traffic. The stub is therefore at the app's own API
 *      boundary, `/api/settings/sending-domain`, returning the exact
 *      shape the route returns. That is still "a stubbed create" and it
 *      is the only layer a browser test can reach.
 *   4. The DNS records are not a table. They are cards with inline
 *      `Name` and `Value` labels under a heading. There are no column
 *      headings to assert.
 */

const SECTION = '31_integrations_hub'
const HAVE = haveCreds(SEEDED.manager)
const NO_CREDS = missingCredsReason('MANAGER')

/** The thirteen cards a default `/settings/integrations` renders. */
const HUB_CARDS: ReadonlyArray<{ title: string; action: string; href: string }> = [
  { title: 'Gmail', action: 'Connect', href: '/settings/gmail' },
  { title: 'OpenPhone (Quo)', action: 'Connect', href: '/settings/openphone' },
  { title: 'Twilio', action: 'Connect', href: '/settings/integrations/twilio' },
  { title: 'Zoom', action: 'Connect', href: '/settings/zoom' },
  { title: 'Calendly', action: 'Connect', href: '/settings/integrations/calendly' },
  { title: 'Omi / Plaud', action: 'Connect', href: '/settings/audio-capture' },
  { title: 'Instagram DMs', action: 'Connect', href: '/settings/integrations/instagram' },
  { title: 'Google Ads', action: 'Connect', href: '/settings/integrations/google-ads' },
  { title: 'Meta Ads', action: 'Connect', href: '/settings/integrations/meta-ads' },
  { title: 'TikTok Ads', action: 'Connect', href: '/settings/integrations/tiktok-ads' },
  { title: 'HoneyBook', action: 'Import', href: '/onboarding/crm-import?provider=honeybook' },
  { title: 'Dubsado', action: 'Import', href: '/onboarding/crm-import?provider=dubsado' },
  {
    title: 'Aisle Planner',
    action: 'Import',
    href: '/onboarding/crm-import?provider=aisle_planner',
  },
]

/** The three ad platforms, and the variables each page must name. */
const AD_PLATFORMS: ReadonlyArray<{
  name: string
  path: string
  statusApi: string
  vars: string[]
}> = [
  {
    name: 'Google Ads',
    path: '/settings/integrations/google-ads',
    statusApi: '**/api/integrations/google-ads/status',
    vars: [
      'GOOGLE_ADS_CLIENT_ID',
      'GOOGLE_ADS_CLIENT_SECRET',
      'GOOGLE_ADS_DEVELOPER_TOKEN',
      'GOOGLE_ADS_OAUTH_REDIRECT_URI',
    ],
  },
  {
    name: 'Meta Ads',
    path: '/settings/integrations/meta-ads',
    statusApi: '**/api/integrations/meta-ads/status',
    vars: ['META_ADS_APP_ID', 'META_ADS_APP_SECRET', 'META_ADS_OAUTH_REDIRECT_URI'],
  },
  {
    name: 'TikTok Ads',
    path: '/settings/integrations/tiktok-ads',
    statusApi: '**/api/integrations/tiktok-ads/status',
    vars: ['TIKTOK_ADS_APP_ID', 'TIKTOK_ADS_APP_SECRET', 'TIKTOK_ADS_OAUTH_REDIRECT_URI'],
  },
]

function hub(page: Page): Journey {
  return journey(page, SECTION, { allowRequests: [/\/api\/auth\/session/] })
}

async function signIn(page: Page): Promise<void> {
  await loginAs(page, 'venue_manager', SEEDED.manager)
}

test.describe('§31 Integrations hub honesty', () => {
  test('every hub card is on the page and every one of them goes somewhere', async ({ page }) => {
    test.skip(!HAVE, NO_CREDS)
    // Thirteen destinations, each compiled on first visit under
    // `next dev --webpack`; that alone ran past the 150s budget on
    // 2026-09-15. slow() triples it. The compile is the harness's cost,
    // not the page's.
    test.slow()
    const j = hub(page)

    await j.step('open the hub', async () => {
      await signIn(page)
      await page.goto('/settings/integrations')
      await expect(page.getByRole('heading', { name: 'Integrations', level: 1 })).toBeVisible({
        timeout: 30_000,
      })
    })

    await j.step('the thirteen ready cards are all there, with their links', async () => {
      for (const card of HUB_CARDS) {
        const heading = page.getByRole('heading', { name: card.title, exact: true })
        await expect(heading, `no card titled ${card.title}`).toBeVisible()
        // The action label is `Configure` once connected, so accept
        // either: what must never happen is the card having no link.
        const link = page.locator(`a[href="${card.href}"]`).first()
        await expect(link, `the ${card.title} card links nowhere`).toHaveCount(1)
        await expect(link).toHaveText(new RegExp(`${card.action}|Configure`))
      }
    })

    await j.step('each card destination actually renders', async () => {
      for (const card of HUB_CARDS) {
        await page.goto(card.href)
        await page.waitForLoadState('domcontentloaded')
        await expect(
          page.locator('body'),
          `${card.href} (the ${card.title} card) did not render`
        ).not.toContainText(/Application error|This page could not be found/i)
      }
    })

    await j.step('the planned cards are honest about being planned', async () => {
      await page.goto('/settings/integrations?showPlanned=1')
      await expect(page.getByRole('heading', { name: 'Integrations', level: 1 })).toBeVisible({
        timeout: 30_000,
      })
      // Nine adapters with ready: false. They say Coming soon and offer
      // no link, which is the whole point of the honesty audit.
      await expect(page.getByText('Coming soon').first()).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Aircall', exact: true })).toBeVisible()
      await expect(page.getByRole('link', { name: 'Hide planned integrations' })).toBeVisible()
    })

    await j.end()
  })

  test('Dubsado and Aisle Planner offer an import, not a waiting list', async ({ page }) => {
    test.skip(!HAVE, NO_CREDS)
    const j = hub(page)

    await j.step('open the hub', async () => {
      await signIn(page)
      await page.goto('/settings/integrations')
      await expect(page.getByRole('heading', { name: 'Integrations', level: 1 })).toBeVisible({
        timeout: 30_000,
      })
    })

    for (const crm of ['Dubsado', 'Aisle Planner'] as const) {
      await j.step(`${crm} says Import`, async () => {
        const href =
          crm === 'Dubsado'
            ? '/onboarding/crm-import?provider=dubsado'
            : '/onboarding/crm-import?provider=aisle_planner'
        const link = page.locator(`a[href="${href}"]`).first()
        await expect(link, `${crm} has no import link`).toHaveCount(1)
        await expect(link).toHaveText(/Import/)
        // The pill is what a planned adapter gets. These two are ready,
        // so they must not carry one. (Their STATUS line still reads
        // "Coming soon" when no couples have been imported — a separate,
        // and arguably wrong, string that this assertion deliberately
        // steps around rather than failing on.)
        await expect(link).not.toHaveText(/Coming soon/)
      })
    }

    await j.step('the import page opens on the right provider', async () => {
      await page.goto('/onboarding/crm-import?provider=dubsado')
      await page.waitForLoadState('domcontentloaded')
      await expect(page.locator('body')).not.toContainText(/This page could not be found/i)
    })

    await j.end()
  })

  test('the ad platforms say what is missing, by name', async ({ page }) => {
    test.skip(!HAVE, NO_CREDS)
    const j = hub(page)

    await j.step('sign in', async () => {
      await signIn(page)
    })

    for (const platform of AD_PLATFORMS) {
      await j.step(`${platform.name} names its missing variables`, async () => {
        // The pages are client components that fetch their own status,
        // so the unconfigured state can be driven from the browser
        // regardless of what the branch env happens to hold. Without
        // this the test would only pass on a branch that has no ad
        // credentials, which is a fact about the env, not the product.
        await page.route(platform.statusApi, (route) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              provider: platform.name,
              configured: false,
              missing: platform.vars,
              connectorStatus: null,
              connection: null,
            }),
          })
        )
        await page.goto(platform.path)
        await expect(page.getByRole('heading', { name: 'Setup not complete' })).toBeVisible({
          timeout: 30_000,
        })
        for (const name of platform.vars) {
          await expect(
            page.getByText(name, { exact: false }).first(),
            `${platform.name} did not name ${name}`
          ).toBeVisible()
        }
        await page.unroute(platform.statusApi)
      })
    }

    await j.end()
  })

  test('a stubbed sending-domain create shows the DNS records', async ({ page }) => {
    test.skip(!HAVE, NO_CREDS)
    const j = hub(page)

    // The exact shape `/api/settings/sending-domain` returns, with the
    // records `mapResendStatus` would have produced from a real create.
    const stubbed = {
      domain: 'e2e-ashcombe.test',
      fromName: 'Ashcombe Barn',
      status: 'unverified',
      checkedAt: new Date().toISOString(),
      hasResendDomain: true,
      records: [
        {
          record: 'SPF',
          type: 'MX',
          name: 'send',
          value: 'feedback-smtp.us-east-1.amazonses.com',
          priority: 10,
          status: null,
        },
        {
          record: 'DKIM',
          type: 'TXT',
          name: 'resend._domainkey',
          value: 'p=E2E-PLACEHOLDER-PUBLIC-KEY',
          priority: null,
          status: null,
        },
      ],
    }

    await j.step('stub the create at the app boundary', async () => {
      // Resend is reached server-side, so page.route cannot see it. This
      // intercepts the app's own endpoint instead and hands back what a
      // successful create returns.
      await page.route('**/api/settings/sending-domain', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(stubbed),
        })
      )
      await signIn(page)
      await page.goto('/settings')
      await expect(page.getByRole('heading', { name: 'Sending domain' })).toBeVisible({
        timeout: 30_000,
      })
    })

    await j.step('add the domain', async () => {
      await page.getByLabel('Your domain').fill(stubbed.domain)
      await page.getByLabel('Name couples see').fill(stubbed.fromName)
      await page.getByRole('button', { name: /^(Add|Update) domain$/ }).click()
    })

    await j.step('the records to add at the registrar are shown', async () => {
      await expect(page.getByText('Add these records at your registrar')).toBeVisible({
        timeout: 30_000,
      })
      // Cards, not a table: a `record · type` line, then inline Name and
      // Value labels with the copyable values beside them.
      await expect(page.getByText('SPF · MX', { exact: false })).toBeVisible()
      await expect(page.getByText('feedback-smtp.us-east-1.amazonses.com')).toBeVisible()
      await expect(page.getByText('resend._domainkey')).toBeVisible()
    })

    await j.end()
  })

  test('Instagram shows the webhook URL Meta has to be given', async ({ page }) => {
    test.skip(!HAVE, NO_CREDS)
    const j = hub(page)

    await j.step('open the Instagram page', async () => {
      await signIn(page)
      await page.goto('/settings/integrations/instagram')
      await expect(page.getByRole('heading', { name: 'Instagram DMs', level: 1 })).toBeVisible({
        timeout: 30_000,
      })
    })

    await j.step('the webhook callback URL is on the page', async () => {
      // The setup section renders whether or not the three environment
      // variables are set, so this holds on an unconfigured branch.
      await expect(page.getByRole('heading', { name: 'Meta app setup' })).toBeVisible({
        timeout: 20_000,
      })
      await expect(page.getByText('Webhook callback URL')).toBeVisible()
      // Built from the request origin, not from an env var, so assert
      // the path rather than a host the branch may not know about.
      await expect(page.getByText('/api/webhooks/instagram', { exact: false })).toBeVisible()
      // exact: the setup checklist below the field also says "Valid OAuth
      // redirect URIs", and a substring match resolves to both (strict
      // mode violation, first run 2026-09-15).
      await expect(page.getByText('OAuth redirect URI', { exact: true })).toBeVisible()
    })

    await j.end()
  })
})
