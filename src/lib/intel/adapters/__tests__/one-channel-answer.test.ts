/**
 * One question, one answer: the channel figures.
 *
 * W64 DONE-WHEN 2. /intel/roi, /intel/sources and /intel/attribution all
 * print "how is this channel doing". They are only guaranteed to agree
 * while all three render the SAME component, which fetches the SAME
 * endpoint, which calls the SAME reader. Any one of those three links
 * can be broken by a well-meaning edit that adds a local fetch or a
 * local percentage, and nothing on screen would say so — the pages would
 * simply start disagreeing again, quietly, which is how this started.
 *
 * So the chain is asserted here rather than trusted. These are file
 * assertions on purpose: the failure being guarded against is
 * structural, not arithmetic, and no amount of fixture testing catches a
 * page growing its own query.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const SHARED_COMPONENT = 'src/app/(platform)/intel/_canonical/channel-truth.tsx'
const PAGES = [
  'src/app/(platform)/intel/roi/page.tsx',
  'src/app/(platform)/intel/sources/page.tsx',
  'src/app/(platform)/intel/attribution/page.tsx',
]

/** Legacy tables a channel figure must never be derived from again. */
const LEGACY = ['weddings', 'people', 'interactions', 'attribution_events', 'wedding_touchpoints']

describe('one channel answer', () => {
  it('every channel surface renders the one shared component', () => {
    for (const page of PAGES) {
      const src = read(page)
      expect(
        /from '(\.\.\/)*_canonical\/channel-truth'/.test(src),
        `${page} should import the shared channel-truth component`,
      ).toBe(true)
    }
  })

  it('the shared component derives its figures only from the channel-view adapter', () => {
    const src = read(SHARED_COMPONENT)
    expect(src).toContain("from '@/lib/intel/adapters/channel-view'")
    expect(src).toContain('buildChannelTruthView')
    // No queries of its own, of any kind.
    expect(src).not.toContain('.from(')
  })

  it('the component fetches exactly one endpoint for channel figures', () => {
    const src = read(SHARED_COMPONENT)
    const fetches = [...src.matchAll(/fetch\(\s*`([^`]+)`/g)].map((m) => m[1])
    expect(fetches.length).toBeGreaterThan(0)
    for (const url of fetches) {
      expect(url.startsWith('/api/intel/canonical/source-attribution')).toBe(true)
    }
  })

  it('that endpoint calls getSourceAttribution and nothing legacy', () => {
    const src = read('src/app/api/intel/canonical/source-attribution/route.ts')
    expect(src).toContain('getSourceAttribution')
    for (const table of LEGACY) {
      expect(src.includes(`.from('${table}')`), `route should not read ${table}`).toBe(false)
    }
  })

  it('the adapter recomputes nothing — it relabels what the reader returned', () => {
    const src = read('src/lib/intel/adapters/channel-view.ts')
    expect(src).not.toContain('.from(')
    // No arithmetic on the rates: the reader owns them.
    expect(src).not.toMatch(/\/\s*\w+\.(distinctCouples|weightedCouples)/)
  })

  it('the ROI page and the impact endpoint hold no queries of their own', () => {
    const page = read('src/app/(platform)/intel/roi/page.tsx')
    expect(page).not.toContain('.from(')
    expect(page).not.toContain('@/lib/supabase/client')

    const route = read('src/app/api/intel/canonical/impact/route.ts')
    for (const table of LEGACY) {
      expect(route.includes(`.from('${table}')`), `impact route should not read ${table}`).toBe(
        false,
      )
    }
    // Response time has one owner, and it is not this route.
    expect(route).toContain('getCohortFunnel')
  })
})
