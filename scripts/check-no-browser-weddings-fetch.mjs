// T5-Rixey-JJJ: CI guard — fail when a coordinator surface fetches
// `weddings` via the canonical `getSupabase().from('weddings')`
// browser-client pattern. That exact pattern produced the
// /intel/sources Total Revenue = $0 demo bug: RLS denied the anon
// read so the page silently received zero rows even though Rixey had
// $794K of HoneyBook revenue.
//
// What this catches:
//   - Future refactors that re-introduce `getSupabase().from('weddings')`
//     on a coordinator-facing page in src/app/(platform)/.
//
// What this DOESN'T catch:
//   - `supabase.from('weddings')` style calls in portal-detail pages
//     where the coordinator owns the row (RLS allows the read because
//     the user has a matching venue_id). Those are NOT the bug shape.
//     If a stream wants to expand the guard to those reads, it must
//     also confirm none of them break — out of scope for JJJ.
//   - Server-side `createServiceClient().from('weddings')` calls.
//     Those are the FIX shape and bypass RLS by design.
//
// Allowlist for `getSupabase().from('weddings')`: EMPTY by design.
// After Stream JJJ, no coordinator surface should re-introduce the
// pattern. If a new genuine case appears, add an inline opt-out
// marker on the call line:
//   // browser-weddings-ok: <reason>
//
// Run:
//   node scripts/check-no-browser-weddings-fetch.mjs
//
// Wired into .github/workflows/ci.yml.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Coordinator-facing scope only. Couple-portal lives at
// src/app/(couple)/ and that audience hits a different RLS profile;
// the bug shape doesn't apply there.
const SCAN_DIRS = [
  'src/app/(platform)',
]

// Pattern matches the canonical bug shape — the EXACT call form that
// produced the $0 demo bug on /intel/sources.
const FROM_WEDDINGS = /getSupabase\s*\(\s*\)\s*\.\s*from\s*\(\s*['"]weddings['"]\s*\)/

// Marker that opts a single line out.
const OPT_OUT_MARKER = /browser-weddings-ok:/

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
  // Walk back up to 4 lines for an opt-out comment.
  for (let i = 1; i <= 4; i++) {
    const line = lines[lineIdx - i]
    if (line === undefined) break
    const trimmed = line.trim()
    if (OPT_OUT_MARKER.test(trimmed)) return true
    if (trimmed === '') continue
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
    break
  }
  return false
}

const files = SCAN_DIRS.flatMap((d) => walk(d))
const violations = []

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    // Skip pure-comment lines so prose like
    //   // `supabase.from('weddings')` was bitten by RLS
    // doesn't trip the guard.
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
    if (!FROM_WEDDINGS.test(line)) continue
    if (isOptedOut(lines, i)) continue
    violations.push({
      file: file.replace(/\\/g, '/'),
      line: i + 1,
      text: trimmed.slice(0, 140),
    })
  }
}

if (violations.length > 0) {
  console.log(
    `\nFound ${violations.length} browser-side weddings read(s) on coordinator surface(s) (T5-Rixey-JJJ):`,
  )
  for (const v of violations) {
    console.log(`  ${v.file}:${v.line}`)
    console.log(`    ${v.text}`)
  }
  console.log(
    '\nFix: move the read into a server-side route handler that uses',
  )
  console.log('createServiceClient(), then fetch() the route from the page.')
  console.log(
    '/api/intel/sources/wedding-rollup is the canonical example.',
  )
  console.log(
    '\nWhy this matters: RLS denies anon weddings reads for logged-out',
  )
  console.log('and cross-venue contexts, which made /intel/sources silently')
  console.log("display Total Revenue = $0 even though the database had $794K.")
  console.log(
    '\nIf the call is genuinely safe (e.g., portal wedding-detail page',
  )
  console.log('where the coordinator owns the row and RLS allows the read),')
  console.log('tag the line with `// browser-weddings-ok: <reason>`.')
  process.exit(1)
}

console.log('No browser-side weddings reads on coordinator surfaces.')
