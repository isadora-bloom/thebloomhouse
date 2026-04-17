/**
 * Reads Playwright JSON results + screenshots and generates a single
 * markdown audit report ready to paste into Claude.
 *
 * Run: npx tsx e2e/generate-report.ts
 */
import * as fs from 'fs'
import * as path from 'path'

interface Issue {
  type: 'console-error' | 'bad-text' | 'failed-request' | 'broken-image' | 'empty-page'
  detail: string
}

interface TestResult {
  title: string
  fullTitle: string
  status: 'passed' | 'failed' | 'timedOut' | 'skipped'
  duration: number
  annotations: { type: string; description?: string }[]
  errors: { message: string }[]
}

interface Suite {
  title: string
  suites?: Suite[]
  specs?: { title: string; tests: TestResult[] }[]
}

interface PlaywrightReport {
  suites: Suite[]
  stats: {
    expected: number
    unexpected: number
    flaky: number
    skipped: number
    duration: number
  }
}

function extractTests(suite: Suite, section = ''): { section: string; name: string; result: TestResult }[] {
  const out: { section: string; name: string; result: TestResult }[] = []
  const currentSection = suite.title || section

  for (const spec of suite.specs || []) {
    for (const t of spec.tests) {
      out.push({ section: currentSection, name: spec.title, result: t })
    }
  }
  for (const child of suite.suites || []) {
    out.push(...extractTests(child, currentSection))
  }
  return out
}

function main() {
  const resultsPath = path.join(__dirname, 'results.json')
  if (!fs.existsSync(resultsPath)) {
    console.error('No results.json found. Run tests first: npx playwright test')
    process.exit(1)
  }

  const report: PlaywrightReport = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'))
  const allTests = report.suites.flatMap(s => extractTests(s))

  // Group by section
  const sections = new Map<string, typeof allTests>()
  for (const t of allTests) {
    const arr = sections.get(t.section) || []
    arr.push(t)
    sections.set(t.section, arr)
  }

  const lines: string[] = []
  lines.push('# Bloom House — Automated Demo Audit Report')
  lines.push(`**Generated:** ${new Date().toISOString().split('T')[0]}`)
  lines.push(`**Target:** https://bloom-house-iota.vercel.app/demo/*`)
  lines.push(`**Method:** Playwright Chromium — full JS rendering, network monitoring, console capture`)
  lines.push('')

  // Summary
  const total = allTests.length
  const passed = allTests.filter(t => t.result.status === 'passed').length
  const failed = allTests.filter(t => t.result.status !== 'passed').length
  const withIssues = allTests.filter(t => {
    const ann = t.result.annotations.find(a => a.type === 'issues')
    return ann && ann.description && JSON.parse(ann.description).length > 0
  }).length

  lines.push('## Summary')
  lines.push(`| Metric | Count |`)
  lines.push(`|--------|-------|`)
  lines.push(`| Total pages tested | ${total} |`)
  lines.push(`| Passed (no critical issues) | ${passed} |`)
  lines.push(`| Failed (critical issues) | ${failed} |`)
  lines.push(`| Pages with warnings | ${withIssues} |`)
  lines.push('')

  // What was checked
  lines.push('## What Was Checked')
  lines.push('Each page was loaded in a real Chromium browser with full JavaScript execution. The following checks ran automatically:')
  lines.push('')
  lines.push('| Check | What it catches |')
  lines.push('|-------|----------------|')
  lines.push('| **Console errors** | Runtime JS crashes, unhandled promise rejections, failed imports |')
  lines.push('| **Bad text patterns** | Visible "undefined", "NaN", "null", "[object Object]", error messages, "Lorem ipsum" |')
  lines.push('| **Failed network requests** | Broken API calls (4xx/5xx), missing endpoints |')
  lines.push('| **Broken images** | Images that failed to load (naturalWidth === 0) |')
  lines.push('| **Empty pages** | Pages with < 20 characters of visible text (blank renders) |')
  lines.push('| **Screenshots** | Every page screenshotted for visual review |')
  lines.push('')

  // Issue type counts
  const allIssues: { section: string; page: string; issues: Issue[] }[] = []
  for (const t of allTests) {
    const ann = t.result.annotations.find(a => a.type === 'issues')
    if (ann?.description) {
      const issues: Issue[] = JSON.parse(ann.description)
      if (issues.length > 0) {
        allIssues.push({ section: t.section, page: t.name, issues })
      }
    }
  }

  const issueCounts: Record<string, number> = {}
  for (const { issues } of allIssues) {
    for (const i of issues) {
      issueCounts[i.type] = (issueCounts[i.type] || 0) + 1
    }
  }

  if (Object.keys(issueCounts).length > 0) {
    lines.push('## Issue Breakdown by Type')
    lines.push('| Type | Count |')
    lines.push('|------|-------|')
    for (const [type, count] of Object.entries(issueCounts).sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${type} | ${count} |`)
    }
    lines.push('')
  }

  // Per-section detail
  lines.push('---')
  lines.push('')
  lines.push('## Detailed Results by Section')
  lines.push('')

  for (const [section, tests] of sections) {
    const sectionPassed = tests.filter(t => t.result.status === 'passed').length
    const sectionFailed = tests.length - sectionPassed
    const sectionIssues = allIssues.filter(i => i.section === section)

    lines.push(`### ${section} (${tests.length} pages — ${sectionPassed} passed, ${sectionFailed} failed)`)
    lines.push('')

    // Table of all pages
    lines.push('| Page | Status | Duration | Issues |')
    lines.push('|------|--------|----------|--------|')
    for (const t of tests) {
      const status = t.result.status === 'passed' ? '✅' : '❌'
      const duration = `${(t.result.duration / 1000).toFixed(1)}s`
      const ann = t.result.annotations.find(a => a.type === 'issues')
      const issues: Issue[] = ann?.description ? JSON.parse(ann.description) : []
      const issueCount = issues.length > 0 ? `⚠️ ${issues.length}` : '—'
      lines.push(`| ${t.name} | ${status} ${t.result.status} | ${duration} | ${issueCount} |`)
    }
    lines.push('')

    // Detail for pages with issues
    if (sectionIssues.length > 0) {
      lines.push(`**Issues found in ${section}:**`)
      lines.push('')
      for (const { page, issues } of sectionIssues) {
        lines.push(`**${page}:**`)
        for (const issue of issues) {
          const icon = {
            'console-error': '🔴',
            'bad-text': '🟡',
            'failed-request': '🔴',
            'broken-image': '🟠',
            'empty-page': '🔴',
          }[issue.type] || '⚪'
          lines.push(`- ${icon} \`${issue.type}\`: ${issue.detail}`)
        }
        lines.push('')
      }
    }

    // Detail for failed tests
    const failedTests = tests.filter(t => t.result.status !== 'passed')
    if (failedTests.length > 0) {
      for (const t of failedTests) {
        if (t.result.errors.length > 0) {
          lines.push(`**${t.name} — error:**`)
          lines.push('```')
          lines.push(t.result.errors[0].message.slice(0, 500))
          lines.push('```')
          lines.push('')
        }
      }
    }
  }

  // Clean pages list
  lines.push('---')
  lines.push('')
  lines.push('## Clean Pages (No Issues Detected)')
  lines.push('')
  const cleanPages = allTests.filter(t => {
    const ann = t.result.annotations.find(a => a.type === 'issues')
    const issues: Issue[] = ann?.description ? JSON.parse(ann.description) : []
    return t.result.status === 'passed' && issues.length === 0
  })
  if (cleanPages.length > 0) {
    for (const t of cleanPages) {
      lines.push(`- ✅ ${t.section} / ${t.name}`)
    }
  } else {
    lines.push('No completely clean pages — every page had at least one warning.')
  }

  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('## Notes for Manual Review')
  lines.push('')
  lines.push('This automated audit catches **structural** issues only. The following still need manual verification:')
  lines.push('- Charts/graphs render with actual data (not empty containers)')
  lines.push('- Drag-and-drop interactions work (seating, timeline)')
  lines.push('- Form submissions save correctly')
  lines.push('- Sage AI chat responds coherently')
  lines.push('- Cross-page data consistency (portal config → couple portal display)')
  lines.push('- Mobile responsiveness')
  lines.push('- Correct venue branding per demo venue')
  lines.push('- Print/PDF export functionality')
  lines.push('')
  lines.push(`*Screenshots saved to: test-results/ directory*`)

  const reportText = lines.join('\n')
  const outPath = path.join(__dirname, '..', 'DEMO-AUDIT-REPORT.md')
  fs.writeFileSync(outPath, reportText, 'utf-8')
  console.log(`Report written to ${outPath}`)
  console.log(`${total} pages tested, ${passed} passed, ${failed} failed, ${withIssues} with warnings`)
}

main()
