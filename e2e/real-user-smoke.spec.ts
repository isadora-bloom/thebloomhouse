import { test, expect, Page } from '@playwright/test'

/**
 * Real authenticated user smoke test.
 * Logs in as a real coordinator (no demo cookie) and verifies
 * that key platform pages render without errors and with real data.
 */

const TEST_EMAIL = 'playwright-test@thebloomhouse.com'
const TEST_PASSWORD = 'TestPassword123!'

// Pages to verify after auth — not all 97, just the critical ones
// that depend on scope-aware queries + auth'd RLS
const REAL_USER_PAGES = [
  // Dashboard + core
  '/',
  // Agent (scope refactored)
  '/agent/inbox',
  '/agent/pipeline',
  '/agent/leads',
  '/agent/drafts',
  '/agent/codes',
  '/agent/sequences',
  // Intel
  '/intel/dashboard',
  '/intel/clients',
  '/intel/portfolio',
  '/intel/company',
  '/intel/lost-deals',
  '/intel/sources',
  '/intel/tours',
  '/intel/team',
  '/intel/capacity',
  '/intel/health',
  // Portal
  '/portal/weddings',
  '/portal/messages',
  '/portal/sage-queue',
  '/portal/kb',
  // Settings
  '/settings',
]

interface PageIssue {
  type: 'console-error' | 'bad-text' | 'failed-request' | 'broken-image' | 'empty-page'
  detail: string
}

const BAD_TEXT_PATTERNS = [
  /\bundefined\b/i,
  /\bNaN\b/,
  /\[object Object\]/,
  /Error:/i,
  /Something went wrong/i,
  /Unhandled Runtime Error/i,
  /Application error/i,
  /Internal Server Error/i,
]

async function auditPage(page: Page, path: string): Promise<PageIssue[]> {
  const issues: PageIssue[] = []

  const consoleErrors: string[] = []
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text()
      if (text.includes('Download the React DevTools')) return
      if (text.includes('Warning:')) return
      if (text.includes('hydration')) return
      consoleErrors.push(text)
    }
  })

  const failedRequests: string[] = []
  page.on('response', resp => {
    if (resp.status() >= 400 && !resp.url().includes('favicon') && !resp.url().includes('_next/static')) {
      failedRequests.push(`${resp.status()} ${resp.url()}`)
    }
  })

  await page.goto(path, { waitUntil: 'networkidle', timeout: 45_000 })
  await page.waitForTimeout(1500)

  const textContent = await page.evaluate(() => document.body?.innerText || '')
  const meaningfulText = textContent.replace(/\s+/g, ' ').trim()

  if (meaningfulText.length < 20) {
    issues.push({ type: 'empty-page', detail: `Only ${meaningfulText.length} chars of text` })
  }

  for (const pattern of BAD_TEXT_PATTERNS) {
    const match = meaningfulText.match(pattern)
    if (match) {
      const idx = meaningfulText.indexOf(match[0])
      const start = Math.max(0, idx - 40)
      const end = Math.min(meaningfulText.length, idx + match[0].length + 40)
      const context = meaningfulText.slice(start, end).replace(/\n/g, ' ')
      issues.push({ type: 'bad-text', detail: `"${match[0]}" → ...${context}...` })
    }
  }

  for (const err of consoleErrors) {
    issues.push({ type: 'console-error', detail: err.slice(0, 200) })
  }

  for (const req of failedRequests) {
    issues.push({ type: 'failed-request', detail: req })
  }

  return issues
}

test.describe('Real authenticated user flow', () => {
  test.describe.configure({ mode: 'serial' })

  test('login as real coordinator', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'networkidle' })
    await page.fill('input[type="email"]', TEST_EMAIL)
    await page.fill('input[type="password"]', TEST_PASSWORD)
    await page.click('button[type="submit"]')

    // Wait for redirect away from /login
    await page.waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 20_000 })

    // Should land on dashboard
    expect(page.url()).toContain('bloom-house-iota.vercel.app')
    expect(page.url()).not.toContain('/login')
  })

  for (const path of REAL_USER_PAGES) {
    test(`real user page: ${path}`, async ({ page }) => {
      // Sign in first (each test gets fresh context)
      await page.goto('/login', { waitUntil: 'networkidle' })
      await page.fill('input[type="email"]', TEST_EMAIL)
      await page.fill('input[type="password"]', TEST_PASSWORD)
      await page.click('button[type="submit"]')
      await page.waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 20_000 })

      // Now navigate to the target page
      const issues = await auditPage(page, path)

      // Attach issues for the report
      if (issues.length > 0) {
        test.info().annotations.push({
          type: 'issues',
          description: JSON.stringify(issues),
        })
      }

      // Fail only on critical issues
      const critical = issues.filter(i =>
        i.type === 'empty-page' ||
        (i.type === 'console-error' && i.detail.includes('Unhandled'))
      )
      expect(critical, `Critical issues on ${path}: ${JSON.stringify(critical)}`).toHaveLength(0)
    })
  }
})
