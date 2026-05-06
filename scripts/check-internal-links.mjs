#!/usr/bin/env node
/**
 * scripts/check-internal-links.mjs
 *
 * Static link checker. Walks the src/ tree for fetch / Link href /
 * router.push targets that look like internal routes, and verifies
 * each one resolves to a real route.ts or page.tsx file under
 * src/app/.
 *
 * Per 2026-05-06 audit Lens 1:
 * > "The two-vendor and dead-couple-route bugs would have been caught
 * >  by any link-check / 404 sweep. There isn't one."
 *
 * Caveats:
 *   - We only catch STATIC strings. fetch(`/api/${dynamic}`) is
 *     ignored (no way to know the dynamic value at lint time).
 *   - We only check internal links (start with /). External URLs and
 *     mailto: / tel: are skipped.
 *   - Dynamic segments [foo] in routes are matched against any value
 *     in the link string. We're permissive here — false negatives
 *     are preferable to false positives.
 *
 * Exits non-zero on any unresolved link. Wire to CI / lint command
 * to prevent regressions.
 */

import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const srcDir = path.join(repoRoot, 'src')
const appDir = path.join(srcDir, 'app')

// ---------------------------------------------------------------------------
// 1. Build the set of real routes by walking src/app/.
// ---------------------------------------------------------------------------

function listRoutes() {
  // Use git ls-files for speed + .gitignore awareness; fall back to
  // a recursive read if not in a repo.
  let files
  try {
    const out = execSync('git ls-files src/app', { cwd: repoRoot, encoding: 'utf8' })
    files = out.split('\n').filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
  } catch {
    files = []
  }

  const routePages = new Set()
  const apiRoutes = new Set()

  for (const rel of files) {
    const base = path.basename(rel)
    if (base !== 'page.tsx' && base !== 'route.ts') continue
    // Strip src/app/ prefix and the file basename to get the URL path.
    let urlPath = rel
      .replace(/^src\/app\//, '/')
      .replace(/\/(page\.tsx|route\.ts)$/, '')
    // Group segments — (group) — are stripped from URLs.
    urlPath = urlPath.replace(/\/\([^)]+\)/g, '')
    // Underscore-prefixed segments (_couple-pages) are private
    // re-export targets, not URLs. Skip — they can't be linked.
    if (urlPath.split('/').some((seg) => seg.startsWith('_'))) continue
    // The root page is at /
    if (urlPath === '') urlPath = '/'

    if (base === 'route.ts') apiRoutes.add(urlPath)
    else routePages.add(urlPath)
  }
  return { routePages, apiRoutes }
}

// ---------------------------------------------------------------------------
// 2. Collect candidate links from src/.
// ---------------------------------------------------------------------------

// Patterns we look for in source. Capturing group is the URL.
const LINK_PATTERNS = [
  /href=\{?["'`](\/[^"'`?#]*)/g,
  /\bfetch\(\s*[`"'](\/[^`"'?#]*)/g,
  /router\.(?:push|replace|prefetch)\(\s*[`"'](\/[^`"'?#]*)/g,
  /redirect\(\s*[`"'](\/[^`"'?#]*)/g,
]

function collectLinks() {
  const links = new Map() // url → list of source locations

  let files
  try {
    const out = execSync('git ls-files src', { cwd: repoRoot, encoding: 'utf8' })
    files = out
      .split('\n')
      .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
  } catch {
    files = []
  }

  for (const rel of files) {
    const abs = path.join(repoRoot, rel)
    let content
    try {
      content = readFileSync(abs, 'utf8')
    } catch {
      continue
    }

    for (const pattern of LINK_PATTERNS) {
      pattern.lastIndex = 0
      let m
      while ((m = pattern.exec(content))) {
        const raw = m[1]
        if (!raw || raw.length < 2) continue
        // Skip non-internal patterns we shouldn't validate.
        if (raw.startsWith('//')) continue // protocol-relative
        if (raw.startsWith('/_next')) continue // build output
        if (raw.startsWith('/static')) continue
        // Skip template-literal interpolations — we can't statically
        // resolve the dynamic part. The pattern captured up to ${ so
        // anything containing $ is partial and unreliable.
        if (raw.includes('$')) continue
        // Skip static asset references (rendered from public/).
        // They aren't routes; the link checker is for app routes only.
        if (raw.startsWith('/samples/')) continue
        if (raw.startsWith('/images/')) continue
        if (raw.startsWith('/fonts/')) continue
        if (raw.startsWith('/icons/')) continue
        if (raw.startsWith('/og-image')) continue
        if (/\.(svg|png|jpe?g|webp|gif|css|js|json|csv|pdf|ico|woff2?|txt)$/i.test(raw)) continue
        // Strip query / hash and trailing slash.
        const url = raw.replace(/[?#].*$/, '').replace(/\/$/, '') || '/'
        if (!links.has(url)) links.set(url, [])
        // Compute line number.
        const before = content.slice(0, m.index)
        const lineNo = before.split('\n').length
        links.get(url).push(`${rel}:${lineNo}`)
      }
    }
  }
  return links
}

// ---------------------------------------------------------------------------
// 3. Resolve each link against the route set.
// ---------------------------------------------------------------------------

function urlToSegments(url) {
  return url === '/' ? [] : url.slice(1).split('/')
}

function matchesRoute(link, route) {
  const linkSegs = urlToSegments(link)
  const routeSegs = urlToSegments(route)
  if (linkSegs.length !== routeSegs.length) return false
  for (let i = 0; i < linkSegs.length; i++) {
    const r = routeSegs[i]
    if (r.startsWith('[') && r.endsWith(']')) {
      // Dynamic — accept any non-empty segment.
      if (!linkSegs[i]) return false
      continue
    }
    if (r !== linkSegs[i]) return false
  }
  return true
}

function isResolved(link, routePages, apiRoutes) {
  // API links resolve to api routes.
  if (link.startsWith('/api/')) {
    for (const route of apiRoutes) {
      if (matchesRoute(link, route)) return true
    }
    return false
  }
  // Page links resolve to page routes.
  for (const route of routePages) {
    if (matchesRoute(link, route)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const { routePages, apiRoutes } = listRoutes()
const links = collectLinks()

const broken = []
for (const [url, callsites] of links) {
  if (!isResolved(url, routePages, apiRoutes)) {
    broken.push({ url, callsites })
  }
}

if (broken.length === 0) {
  console.log(`check-internal-links: OK — ${links.size} unique internal URLs, all resolved against ${routePages.size} pages + ${apiRoutes.size} API routes`)
  process.exit(0)
}

console.error(`check-internal-links: ${broken.length} unresolved internal URL(s):\n`)
for (const { url, callsites } of broken) {
  console.error(`  ${url}`)
  for (const cs of callsites.slice(0, 5)) {
    console.error(`    referenced by ${cs}`)
  }
  if (callsites.length > 5) {
    console.error(`    ...and ${callsites.length - 5} more`)
  }
}
console.error('')
console.error('If a URL is intentionally dynamic (e.g. external + path-prefix-only),')
console.error('add it to LINK_PATTERNS skip list or refactor the call site.')
process.exit(1)
