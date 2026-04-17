import { test, expect, Page } from '@playwright/test'

// ---------------------------------------------------------------------------
// Every demo page grouped by product area
// ---------------------------------------------------------------------------
const PAGES: Record<string, string[]> = {
  'Agent': [
    '/demo/agent/inbox',
    '/demo/agent/pipeline',
    '/demo/agent/leads',
    '/demo/agent/drafts',
    '/demo/agent/sequences',
    '/demo/agent/relationships',
    '/demo/agent/analytics',
    '/demo/agent/codes',
    '/demo/agent/errors',
    '/demo/agent/knowledge-gaps',
    '/demo/agent/learning',
    '/demo/agent/notifications',
    '/demo/agent/rules',
    '/demo/agent/settings',
  ],
  'Intel': [
    '/demo/intel/dashboard',
    '/demo/intel/briefings',
    '/demo/intel/clients',
    '/demo/intel/tours',
    '/demo/intel/reviews',
    '/demo/intel/campaigns',
    '/demo/intel/capacity',
    '/demo/intel/company',
    '/demo/intel/forecasts',
    '/demo/intel/health',
    '/demo/intel/lost-deals',
    '/demo/intel/market-pulse',
    '/demo/intel/matching',
    '/demo/intel/nlq',
    '/demo/intel/portfolio',
    '/demo/intel/regions',
    '/demo/intel/social',
    '/demo/intel/sources',
    '/demo/intel/team',
    '/demo/intel/team-compare',
    '/demo/intel/trends',
    '/demo/intel/annotations',
  ],
  'Portal': [
    '/demo/portal/weddings',
    '/demo/portal/bar-config',
    '/demo/portal/checklist-config',
    '/demo/portal/decor-config',
    '/demo/portal/guest-care-config',
    '/demo/portal/kb',
    '/demo/portal/messages',
    '/demo/portal/rehearsal-config',
    '/demo/portal/rooms-config',
    '/demo/portal/sage-queue',
    '/demo/portal/seating-config',
    '/demo/portal/section-settings',
    '/demo/portal/shuttle-config',
    '/demo/portal/staffing-config',
    '/demo/portal/tables-config',
    '/demo/portal/vendors',
    '/demo/portal/wedding-details-config',
  ],
  'Couple': [
    '/demo/couple/hawthorne-manor',
    '/demo/couple/hawthorne-manor/getting-started',
    '/demo/couple/hawthorne-manor/chat',
    '/demo/couple/hawthorne-manor/messages',
    '/demo/couple/hawthorne-manor/checklist',
    '/demo/couple/hawthorne-manor/timeline',
    '/demo/couple/hawthorne-manor/budget',
    '/demo/couple/hawthorne-manor/contracts',
    '/demo/couple/hawthorne-manor/guests',
    '/demo/couple/hawthorne-manor/rsvp-settings',
    '/demo/couple/hawthorne-manor/seating',
    '/demo/couple/hawthorne-manor/tables',
    '/demo/couple/hawthorne-manor/party',
    '/demo/couple/hawthorne-manor/ceremony',
    '/demo/couple/hawthorne-manor/rehearsal',
    '/demo/couple/hawthorne-manor/bar',
    '/demo/couple/hawthorne-manor/decor',
    '/demo/couple/hawthorne-manor/photos',
    '/demo/couple/hawthorne-manor/couple-photo',
    '/demo/couple/hawthorne-manor/inspo',
    '/demo/couple/hawthorne-manor/picks',
    '/demo/couple/hawthorne-manor/beauty',
    '/demo/couple/hawthorne-manor/vendors',
    '/demo/couple/hawthorne-manor/preferred-vendors',
    '/demo/couple/hawthorne-manor/rooms',
    '/demo/couple/hawthorne-manor/stays',
    '/demo/couple/hawthorne-manor/transportation',
    '/demo/couple/hawthorne-manor/allergies',
    '/demo/couple/hawthorne-manor/guest-care',
    '/demo/couple/hawthorne-manor/staffing',
    '/demo/couple/hawthorne-manor/venue-inventory',
    '/demo/couple/hawthorne-manor/wedding-details',
    '/demo/couple/hawthorne-manor/worksheets',
    '/demo/couple/hawthorne-manor/downloads',
    '/demo/couple/hawthorne-manor/resources',
    '/demo/couple/hawthorne-manor/website',
    '/demo/couple/hawthorne-manor/booking',
    '/demo/couple/hawthorne-manor/final-review',
  ],
  'Settings': [
    '/demo/settings',
    '/demo/settings/personality',
    '/demo/settings/voice',
    '/demo/onboarding',
    '/demo/super-admin',
  ],
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PageIssue {
  type: 'console-error' | 'bad-text' | 'failed-request' | 'broken-image' | 'empty-page'
  detail: string
}

/** Bad patterns in visible text */
const BAD_TEXT_PATTERNS = [
  /\bundefined\b/i,
  /\bNaN\b/,
  /\bnull\b/,
  /\b\[object Object\]/,
  /Error:/i,
  /Something went wrong/i,
  /Unhandled Runtime Error/i,
  /Application error/i,
  /Internal Server Error/i,
  /404.*not found/i,
  /Lorem ipsum/i,
]

async function auditPage(page: Page, path: string): Promise<{ issues: PageIssue[]; textContent: string }> {
  const issues: PageIssue[] = []

  // Collect console errors
  const consoleErrors: string[] = []
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text()
      // Ignore noisy but harmless warnings
      if (text.includes('Download the React DevTools')) return
      if (text.includes('Warning:')) return
      if (text.includes('hydration')) return
      consoleErrors.push(text)
    }
  })

  // Collect failed network requests
  const failedRequests: string[] = []
  page.on('response', resp => {
    if (resp.status() >= 400 && !resp.url().includes('favicon')) {
      failedRequests.push(`${resp.status()} ${resp.url()}`)
    }
  })

  // Navigate (45s timeout — some intel pages with multiple slow Supabase queries)
  await page.goto(path, { waitUntil: 'networkidle', timeout: 45_000 })

  // Wait a beat for client-side rendering to finish
  await page.waitForTimeout(1500)

  // Get visible text
  const textContent = await page.evaluate(() => document.body?.innerText || '')

  // Check: empty page
  const meaningfulText = textContent.replace(/\s+/g, ' ').trim()
  if (meaningfulText.length < 20) {
    issues.push({ type: 'empty-page', detail: `Only ${meaningfulText.length} chars of text` })
  }

  // Check: bad text patterns
  for (const pattern of BAD_TEXT_PATTERNS) {
    const match = meaningfulText.match(pattern)
    if (match) {
      // Get surrounding context
      const idx = meaningfulText.indexOf(match[0])
      const start = Math.max(0, idx - 40)
      const end = Math.min(meaningfulText.length, idx + match[0].length + 40)
      const context = meaningfulText.slice(start, end).replace(/\n/g, ' ')
      issues.push({ type: 'bad-text', detail: `"${match[0]}" found → ...${context}...` })
    }
  }

  // Check: console errors
  for (const err of consoleErrors) {
    issues.push({ type: 'console-error', detail: err.slice(0, 200) })
  }

  // Check: failed requests
  for (const req of failedRequests) {
    issues.push({ type: 'failed-request', detail: req })
  }

  // Check: broken images
  const brokenImages = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img'))
    return imgs
      .filter(img => img.complete && img.naturalWidth === 0 && img.src)
      .map(img => img.src)
  })
  for (const src of brokenImages) {
    issues.push({ type: 'broken-image', detail: src })
  }

  return { issues, textContent: meaningfulText.slice(0, 500) }
}

// ---------------------------------------------------------------------------
// Tests — one per page, grouped by section
// ---------------------------------------------------------------------------

for (const [section, paths] of Object.entries(PAGES)) {
  test.describe(section, () => {
    for (const path of paths) {
      const shortName = path.replace('/demo/', '').replace('/couple/hawthorne-manor', '/couple/…')

      test(shortName, async ({ page }) => {
        const { issues } = await auditPage(page, path)

        // Attach issues as test annotation for the report
        if (issues.length > 0) {
          test.info().annotations.push({
            type: 'issues',
            description: JSON.stringify(issues),
          })
        }

        // Fail on critical issues — empty pages or runtime errors
        const critical = issues.filter(i =>
          i.type === 'empty-page' ||
          i.type === 'console-error' && i.detail.includes('Unhandled')
        )
        expect(critical, `Critical issues on ${path}: ${JSON.stringify(critical)}`).toHaveLength(0)
      })
    }
  })
}
