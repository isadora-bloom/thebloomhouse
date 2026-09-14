import { test, expect } from '@playwright/test'
import { loadE2EEnv, PROD_SUPABASE_REF } from '../helpers/env'

/**
 * Harness canary.
 *
 * The old version loaded /welcome and asserted the URL contained
 * '/welcome'. That passes against any running Next app, including the
 * production one — which is exactly how the suite spent its life seeding
 * and cleaning the live project without anybody noticing. A canary that
 * cannot fail is not a canary.
 *
 * This one asserts the three things that have to be true before any other
 * spec means anything:
 *
 *   1. the app under test is up,
 *   2. it is not pointed at the production Supabase project,
 *   3. an unauthenticated visitor to / is sent to /welcome, not into a
 *      dashboard — the post-wave-9 landing behaviour (/ redirects to
 *      /today once you are signed in).
 */

test('the app under test is up', async ({ page }) => {
  await page.goto('/welcome')
  await page.waitForLoadState('domcontentloaded')
  expect(page.url()).toContain('/welcome')
})

test('the harness is not pointed at production', () => {
  const env = loadE2EEnv()
  expect(
    env.found,
    `${env.envFile} was not found at ${env.envPath}. The suite needs the branch credentials.`
  ).toBe(true)
  expect(env.supabaseUrl, 'no NEXT_PUBLIC_SUPABASE_URL in the harness env').toBeTruthy()
  expect(
    env.supabaseUrl.includes(PROD_SUPABASE_REF),
    `the harness env names the production project (${env.supabaseUrl}).`
  ).toBe(false)
  expect(env.serviceRoleKey, 'no SUPABASE_SERVICE_ROLE_KEY in the harness env').toBeTruthy()
})

test('an unauthenticated visitor to / lands on /welcome', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  expect(
    new URL(page.url()).pathname,
    '/ must not render a dashboard to someone with no session'
  ).toBe('/welcome')
})
