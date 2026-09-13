/**
 * Scaffold gate — Wave 5 W39.
 *
 * The 2026-09-08 audit counted 183 platform pages against the November
 * client path (`/today`, the agent daily surfaces, the kept `/intel/**`
 * surfaces, `/settings/**`, `/onboarding/**`, `/portal/weddings/**`, the
 * couple portal, the demo) and found a stack of pages that are built and
 * working but reach nobody: no nav entry, no link from a kept page. See
 * PLATFORM-PAGES-AUDIT.md for the full page-by-page verdicts.
 *
 * `assertNotScaffold(path)` is one line at the top of each "hide"
 * verdict page. It calls `notFound()` unless `SCAFFOLD_PAGES=1` is set,
 * so a normal venue never lands on the page but nothing is deleted —
 * the code, the route and the data underneath it all still work the
 * moment a workstream wires it onto a real nav entry and removes the
 * gate line.
 *
 * `path` is not used to decide anything — every hidden page behaves the
 * same way — it is there so a local `SCAFFOLD_PAGES` run and the dev
 * console both say which page was gated, which matters once there are
 * nine of these and a future workstream is trying to work out why one
 * of them 404s in a review build.
 */

import { notFound } from 'next/navigation'

export function assertNotScaffold(path: string): void {
  if (process.env.SCAFFOLD_PAGES === '1') return
  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console -- deliberate operator-facing note, not an error
    console.warn(
      `[scaffold-gate] ${path} is hidden behind SCAFFOLD_PAGES. Set SCAFFOLD_PAGES=1 to view it locally.`
    )
  }
  notFound()
}
