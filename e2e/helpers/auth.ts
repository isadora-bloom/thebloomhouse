/**
 * Auth helper for E2E tests.
 *
 * `loginAs(page, role, { email, password })` signs in via the UI at /login
 * (for platform roles) or /couple/{slug}/login (for couple role). If the
 * caller does not supply credentials, the caller is responsible for creating
 * the user first via seed.ts — this helper does NOT create users.
 */
import { Page, expect } from '@playwright/test'

export type LoginCreds = {
  email: string
  password: string
  slug?: string // required for couple role in dev (path-based routing)
}

export async function loginAs(
  page: Page,
  role: 'super_admin' | 'org_admin' | 'venue_manager' | 'coordinator' | 'readonly' | 'couple',
  creds: LoginCreds
): Promise<void> {
  if (role === 'couple') {
    // Couple uses /couple/login (dev path-based) or /couple/{slug}/login
    const path = creds.slug ? `/couple/${creds.slug}/login` : '/couple/login'
    await page.goto(path)
  } else {
    await page.goto('/login')
  }
  await page.waitForLoadState('domcontentloaded')

  // Form fields are not labelled with htmlFor-matching for role selectors; use id + placeholder
  await page.fill('input[type="email"]', creds.email)
  await page.fill('input[type="password"]', creds.password)
  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => null),
    page.click('button[type="submit"]'),
  ])

  // Wait until redirect completes (out of /login)
  await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 15_000 }).catch(() => null)
}

export async function logout(page: Page): Promise<void> {
  // Best-effort: call supabase sign-out cookie via client JS.
  await page.evaluate(async () => {
    try {
      // @ts-expect-error - runtime only
      const { createClient } = await import('/_next/static/chunks/supabase-client.js').catch(() => ({ createClient: null }))
      if (createClient) {
        const supabase = createClient()
        await supabase.auth.signOut()
      }
    } catch {
      /* noop */
    }
  })
  // Clear cookies as a fallback
  await page.context().clearCookies()
}

/**
 * Verify the current user is redirected (not allowed on target path).
 * Use for "forbidden route" tests.
 */
export async function expectForbidden(page: Page, path: string): Promise<void> {
  await page.goto(path)
  await page.waitForLoadState('domcontentloaded')
  // Either redirected to login/welcome, or a 403/forbidden state renders
  const url = page.url()
  const onAuthPage = /\/(login|welcome|couple\/[^/]+\/login)/.test(url)
  if (!onAuthPage) {
    // Fallback: check for forbidden text
    await expect(page.locator('body')).toContainText(/forbidden|unauthor|access denied|log in/i, { timeout: 5000 })
  }
}
