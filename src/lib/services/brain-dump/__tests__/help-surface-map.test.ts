/**
 * Bug 15 (2026-05-09). HELP_SURFACE_MAP drift guard.
 *
 * help.ts ships a hand-curated index of ~50 routes that the help-mode
 * Q&A answer service points coordinators to. As the app router evolves
 * (new pages, renamed routes, deletions), the map silently drifts and
 * the Q&A answer can suggest a dead link. This test asserts every
 * `href` in HELP_SURFACE_MAP corresponds to a real `page.tsx` under
 * src/app/, with the route group `(platform)` collapsed and `[slug]`
 * placeholders matched by directory presence (we don't materialise
 * slugs, we just check the parent directory has a `[slug]` segment).
 *
 * Failure mode: when this test breaks, either:
 *   - update HELP_SURFACE_MAP in help.ts to match the current routes
 *   - add the missing page.tsx under src/app/
 *   - deliberately remove the entry if the surface was retired
 *
 * The test is intentionally allow-list shaped (every entry must
 * resolve) rather than allow-set shaped (every page must be in the
 * map) — coverage is owned elsewhere; this guards correctness.
 */

import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { HELP_SURFACE_MAP } from '@/lib/services/brain-dump/help'

const APP_ROOT = path.resolve(__dirname, '../../../../app')

/**
 * Resolve an href to one or more candidate filesystem paths under
 * src/app/. Next.js App Router supports route groups in parentheses
 * that don't show up in the URL (e.g. (platform)/agent → /agent), so
 * an href like /agent/leads can live at either:
 *   src/app/agent/leads/page.tsx
 *   src/app/(platform)/agent/leads/page.tsx
 *
 * Bug 15 returns an array of candidates; the test passes when ANY one
 * resolves to an existing file. [slug] segments match by-directory
 * (we don't substitute a real slug; the directory just needs to exist).
 */
function candidatePathsFor(href: string): string[] {
  if (!href.startsWith('/')) return []
  const segments = href.slice(1).split('/').filter(Boolean)
  if (segments.length === 0) return [path.join(APP_ROOT, 'page.tsx')]

  // Possible route-group prefixes Bloom uses. Coupled to the actual
  // directory layout — keep in sync with src/app/.
  const groupPrefixes: string[][] = [
    [], // no group
    ['(platform)'],
    ['(auth)'],
  ]

  const candidates: string[] = []
  for (const prefix of groupPrefixes) {
    candidates.push(
      path.join(APP_ROOT, ...prefix, ...segments, 'page.tsx'),
    )
  }
  return candidates
}

describe('HELP_SURFACE_MAP', () => {
  it('every entry has a non-empty href and topic', () => {
    for (const entry of HELP_SURFACE_MAP) {
      expect(entry.topic, JSON.stringify(entry)).toBeTruthy()
      expect(entry.href, JSON.stringify(entry)).toMatch(/^\/[a-z0-9/_\-[\]]+$/i)
    }
  })

  it('every href resolves to a real page.tsx under src/app/', () => {
    const stale: Array<{ topic: string; href: string; tried: string[] }> = []
    for (const entry of HELP_SURFACE_MAP) {
      const candidates = candidatePathsFor(entry.href)
      const found = candidates.some((c) => existsSync(c))
      if (!found) {
        stale.push({ topic: entry.topic, href: entry.href, tried: candidates })
      }
    }
    if (stale.length > 0) {
      const message = stale
        .map(
          (s) =>
            `  - ${s.topic} (${s.href}) — tried:\n${s.tried.map((t) => `      ${t}`).join('\n')}`,
        )
        .join('\n')
      throw new Error(
        `HELP_SURFACE_MAP has ${stale.length} stale ${stale.length === 1 ? 'entry' : 'entries'}:\n${message}\n\nUpdate help.ts or add the missing page.tsx.`,
      )
    }
  })

  it('does not contain duplicate hrefs', () => {
    const seen = new Set<string>()
    const dupes: string[] = []
    for (const entry of HELP_SURFACE_MAP) {
      if (seen.has(entry.href)) dupes.push(entry.href)
      seen.add(entry.href)
    }
    expect(dupes, `duplicate hrefs in HELP_SURFACE_MAP: ${dupes.join(', ')}`).toEqual([])
  })
})
