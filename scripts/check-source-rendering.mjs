// T5-Rixey-DDD: CI guard — fail when a coordinator-facing page renders
// `wedding.source` / `lead.source` / `lead_source` / `currentSource`
// directly into JSX without going through the shared formatSourceLabel()
// utility.
//
// Why this exists
// ---------------
// Stream UU canonicalised source rendering with formatSourceLabel().
// Stream VV added the UNTRACKED_LABEL ('Untracked / Pre-Bloom') for
// null sources. Stream DDD merged both into formatSourceLabel itself so
// every render site automatically benefits. But the coordinator surfaces
// audit kept finding new leak sites in /intel/clients (raw 'Unknown
// source' string), /intel/identity-backtrack (`{wedding.source}`),
// /onboarding/identity-reconciliation (`{w.lead_source}`),
// /intel/company (chart label leak). Every leak makes the leads-list
// look like it's mixing two formatting conventions.
//
// What this catches
// -----------------
// JSX that interpolates a `source` / `lead_source` / `currentSource`
// property directly:
//   <span>source: {wedding.source}</span>           — flagged
//   <td>{lead.source}</td>                           — flagged
//   <span>{c.source}</span>                          — flagged
//   <span>{formatSourceLabel(wedding.source)}</span> — OK
//   <span>{formatSource(wedding.source)}</span>      — OK (page-local
//     wrapper around formatSourceLabel; allowlisted by name match)
//   const sourceBadge = sourceBadge(lead.source)     — OK (pill helper
//     that itself calls formatSourceLabel — sites that wrap with this
//     pattern are recognised)
//   <SourceBadgeEditable initialSource={wedding.source} ... /> — OK
//     (component goes through formatSourceLabel internally)
//
// Allowlist:
//   - `formatSourceLabel(...)` / `formatSource(...)` / `sourceBadge(...)`
//     wraps the read
//   - The read is a JSX prop pass-through to a component name ending in
//     'Source' or 'Badge' (e.g. SourceBadgeEditable, CandidateSignalEvidence)
//   - Inline marker `// source-render-ok: <reason>`
//
// Run:
//   node scripts/check-source-rendering.mjs
//
// Wired into .github/workflows/ci.yml alongside the LL guard.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SCAN_DIRS = [
  'src/app/(platform)',
  'src/components',
]

// Skip the formatter itself + page-local wrappers that re-export the
// formatter (e.g. /intel/sources/page.tsx's `formatSource` alias).
const SKIP_FILES = new Set([
  'src/lib/utils/format-source-label.ts',
])

const OPT_OUT_MARKER = /source-render-ok:/

// JSX interpolation of a *.source / *.lead_source / *.currentSource
// property. The pattern matches `{ident.source}` or `{ident.lead_source}`
// or `{ident.currentSource}` (with optional whitespace + optional `?? '...'`
// fallback). The capture group lets us disambiguate from non-source
// fields named similarly.
const JSX_SOURCE_INTERP = /\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\.(source|lead_source|currentSource)\b[^}]*\}/g

// Non-display contexts: React keys, form input values, refs, ids,
// style/className computations, event handlers, and JSX prop assignments
// of shape `someProp={ident.source}` (component is responsible for
// formatting). These are not coordinator-visible text renders.
//
// The pattern matches `<word>={ident.source}` where <word> is a JSX
// attribute name (alphanumeric, optional dashes for data-/aria-).
const JSX_PROP_ASSIGNMENT = /\b[a-zA-Z][a-zA-Z0-9_-]*\s*=\s*\{\s*[a-zA-Z_][a-zA-Z0-9_]*\.(?:source|lead_source|currentSource)\b/

// Template-string keys (React `key={`...`}`) and template-string
// computations (`${row.source}`) inside backticks are also not display.
// Only flag bare {ident.source} interpolations directly inside JSX
// children.
const TEMPLATE_LITERAL_USE = /\$\{[^}]*\.(?:source|lead_source|currentSource)/

// Allowlist: a wrapping call to formatSourceLabel / formatSource /
// sourceBadge / formatSeriesLabel on the same line. We also accept any
// identifier ending in 'SourceLabel' / 'SourceBadge' to catch future
// helpers.
const FORMATTER_PRESENT = /(?:formatSourceLabel|formatSource|sourceBadge|formatSeriesLabel|[a-zA-Z_]+SourceLabel|[a-zA-Z_]+SourceBadge)\s*\(/

// Allowlist: JSX prop pass-through to a recognised source-aware
// component. The pattern looks for `<XxxSource ... .source` or
// `<XxxBadge ... .source` — those components apply formatting internally.
const SOURCE_COMPONENT_PROP = /<\s*[A-Z][a-zA-Z0-9]*(?:Source|Badge|Evidence|Backtrace|Chip)[^>]*\.(?:source|lead_source|currentSource)/

// Properties named `source` / `lead_source` / `currentSource` that are
// NOT a wedding/lead source. Maintained per-domain so we don't false-
// positive on PulseSource (`item.source === 'notification'`),
// review-platform source ('google' / 'yelp' for review pages),
// regex.source (RegExp built-in), filter.source ('manual' | 'learned'),
// etc. Add to this list when CI flags a non-wedding-source field.
const NON_WEDDING_SOURCE_IDENTS = new Set([
  // Pulse feed source — 'notification' | 'anomaly' | 'insight'
  'item',
  // Inbox-filter source — 'manual' | 'learned'
  'f',
  // Review-platform source (different domain mapping in /intel/reviews)
  'review',
  // Anomaly card source — internal type discriminator
  'c',
  // RegExp built-in (re.source returns the pattern string)
  're',
  // Pricing / contract record source — different domain
  'rec',
  // Marketing-spend importer rows — already-formatted label
  'r',
])

function walk(dir) {
  const out = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const full = join(dir, name)
    let stats
    try {
      stats = statSync(full)
    } catch {
      continue
    }
    if (stats.isDirectory()) out.push(...walk(full))
    else if (/\.(tsx|ts)$/.test(name)) out.push(full)
  }
  return out
}

function isOptedOut(lines, lineIdx) {
  if (OPT_OUT_MARKER.test(lines[lineIdx] ?? '')) return true
  for (let i = 1; i <= 6; i++) {
    const line = lines[lineIdx - i]
    if (line === undefined) break
    const trimmed = line.trim()
    if (trimmed === '') break
    if (!trimmed.startsWith('//')) break
    if (OPT_OUT_MARKER.test(line)) return true
  }
  return false
}

const files = SCAN_DIRS.flatMap((d) => walk(d))
const violations = []

for (const file of files) {
  const normalized = file.replace(/\\/g, '/')
  if (SKIP_FILES.has(normalized)) continue

  const text = readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)

  // Track in-block-comment state across lines so /* ... */ + JSX
  // {/* ... */} don't trip the heuristic.
  let inBlockComment = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const startedInBlock = inBlockComment
    let scan = line
    let cursor = 0
    while (cursor < scan.length) {
      if (inBlockComment) {
        const close = scan.indexOf('*/', cursor)
        if (close === -1) { cursor = scan.length; break }
        cursor = close + 2
        inBlockComment = false
      } else {
        const open = scan.indexOf('/*', cursor)
        if (open === -1) break
        cursor = open + 2
        inBlockComment = true
      }
    }
    if (startedInBlock) continue

    const trimmedLine = line.trim()
    if (trimmedLine.startsWith('//')) continue
    if (trimmedLine.startsWith('*')) continue

    // Reset regex state per-line.
    JSX_SOURCE_INTERP.lastIndex = 0
    const matches = [...line.matchAll(JSX_SOURCE_INTERP)]
    if (matches.length === 0) continue

    for (const m of matches) {
      const ident = m[1]
      // Skip non-wedding-source identifiers (Pulse, inbox filters, etc.)
      if (ident && NON_WEDDING_SOURCE_IDENTS.has(ident)) continue

      // Allowlist: non-display contexts. JSX prop assignment
      // (`someProp={x.source}`) means the component owns formatting;
      // template-literal interpolation (`${x.source}`) is for keys /
      // backend ids / log strings, not coordinator-visible text.
      if (JSX_PROP_ASSIGNMENT.test(line)) continue
      if (TEMPLATE_LITERAL_USE.test(line)) continue

      // Allowlist: line wraps the read with a known source formatter.
      if (FORMATTER_PRESENT.test(line)) continue

      // Allowlist: JSX prop pass to a recognised source-aware component.
      if (SOURCE_COMPONENT_PROP.test(line)) continue

      // Allowlist: explicit opt-out marker.
      if (isOptedOut(lines, i)) continue

      violations.push({
        file: normalized,
        line: i + 1,
        ident: m[0],
        text: line.trim().slice(0, 140),
      })
      // Only one violation per line (multiple matches likely all the
      // same offence).
      break
    }
  }
}

if (violations.length > 0) {
  console.log(
    `\nFound ${violations.length} coordinator-facing source render(s) that bypass formatSourceLabel (T5-Rixey-DDD):`,
  )
  for (const v of violations) {
    console.log(`  ${v.file}:${v.line}`)
    console.log(`    ${v.text}`)
  }
  console.log(
    '\nFix: render through the shared formatter:',
  )
  console.log(
    "  import { formatSourceLabel } from '@/lib/utils/format-source-label'",
  )
  console.log(
    '  // ...',
  )
  console.log(
    '  <span>{formatSourceLabel(wedding.source)}</span>',
  )
  console.log(
    "\nThis ensures snake_case ('venue_calculator', 'calendly') gets",
  )
  console.log(
    "Title-Cased and null/empty/'unknown'/'(unknown)' surfaces as",
  )
  console.log(
    "'Untracked / Pre-Bloom' instead of '—' or 'Unknown'.",
  )
  console.log(
    '\nIf the field genuinely is NOT a wedding/lead source (e.g. Pulse',
  )
  console.log(
    "feed source, RegExp.source), tag with `// source-render-ok: <reason>`",
  )
  console.log(
    'or add the parent identifier to NON_WEDDING_SOURCE_IDENTS in this script.',
  )
  process.exit(1)
}

console.log('No coordinator-facing source renders bypass formatSourceLabel.')
