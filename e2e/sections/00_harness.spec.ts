import { test, expect } from '@playwright/test'

/**
 * Harness smoke test. Verifies the dev server boots and the welcome page
 * renders. Serves as a canary for the Playwright config + webServer.
 */
test('welcome page loads', async ({ page }) => {
  await page.goto('/welcome')
  await page.waitForLoadState('domcontentloaded')
  expect(page.url()).toContain('/welcome')
})
