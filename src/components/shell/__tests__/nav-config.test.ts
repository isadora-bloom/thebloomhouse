/**
 * Wave 5 W39 — every nav entry must resolve to a page that is not gated
 * behind the scaffold gate. A hidden page reached from the sidebar or
 * the gear menu would just 404 on click, which is worse than not
 * linking to it at all.
 *
 * Static check: for every href in nav-config.ts, find the corresponding
 * `page.tsx` under src/app/(platform) and assert it does not call
 * `assertNotScaffold(`. This mirrors what scripts/check-internal-links.mjs
 * does for link resolution, but for the hide gate specifically.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { MODES, GEAR_GROUPS } from '../nav-config'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const PLATFORM_DIR = path.join(REPO_ROOT, 'src', 'app', '(platform)')

function hrefToPageFile(href: string): string {
  const rel = href === '/' ? '' : href
  return path.join(PLATFORM_DIR, rel, 'page.tsx')
}

function collectAllHrefs(): string[] {
  const hrefs: string[] = []
  for (const mode of MODES) {
    for (const section of mode.sections) {
      for (const item of section.items) {
        hrefs.push(item.href)
      }
    }
  }
  for (const group of GEAR_GROUPS) {
    for (const item of group.items) {
      hrefs.push(item.href)
    }
  }
  return [...new Set(hrefs)]
}

describe('nav-config reachability', () => {
  const hrefs = collectAllHrefs()

  it('collected at least one nav href from each mode plus the gear menu', () => {
    expect(hrefs.length).toBeGreaterThan(50)
  })

  it.each(hrefs)('nav entry %s resolves to a page file that exists', (href) => {
    const file = hrefToPageFile(href)
    expect(existsSync(file)).toBe(true)
  })

  it.each(hrefs)('nav entry %s does not point at a scaffold-gated page', (href) => {
    const file = hrefToPageFile(href)
    if (!existsSync(file)) return // covered by the previous test
    const content = readFileSync(file, 'utf8')
    expect(content).not.toMatch(/assertNotScaffold\(/)
  })
})
