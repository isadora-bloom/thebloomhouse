// W56 (NOVEMBER-PLAN.md wave 8): CI guard. Keep the cross-venue benchmark
// off the client.
//
// Same family as check-no-browser-weddings-fetch.mjs, and for a sharper
// reason. That guard exists because a browser read of `weddings` returned
// zero rows and made a page lie. This one exists because the benchmark
// query deliberately reads rows belonging to OTHER venues, as service
// role. A single 'use client' import of it would put another tenant's
// data in a browser bundle, which is the one failure the identity-first
// tenant rules do not tolerate.
//
// What this checks
// ----------------
//   1. Neither protected module carries a 'use client' directive.
//   2. No file that carries a 'use client' directive imports either of
//      them, by alias or by relative path.
//   3. The service module still contains its runtime browser assertion,
//      so a later edit cannot quietly remove the second line of defence
//      and leave only this static scan.
//
// What this does NOT check
// ------------------------
// Transitive imports. A client component that imports a server-only
// module through two hops is not caught here. Next.js would fail that
// build on the service-role client's own env access long before the
// import mattered, and a full module-graph walk is a different tool.
//
// There is no allowlist and there should never be one. If a surface needs
// benchmark numbers in the browser, it fetches them from a server route
// that has already authorised the caller.
//
// Run:
//   node scripts/check-no-browser-benchmark-import.mjs
//
// Wired into `npm run check:governance`.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SCAN_DIRS = ['src']

/** The modules that may only ever run on the server. */
const PROTECTED = [
  {
    path: 'src/lib/services/cohort/benchmark.ts',
    aliases: ['@/lib/services/cohort/benchmark'],
    basename: 'benchmark',
    dir: 'src/lib/services/cohort',
  },
  {
    path: 'src/lib/intel/adapters/benchmark-view.ts',
    aliases: ['@/lib/intel/adapters/benchmark-view'],
    basename: 'benchmark-view',
    dir: 'src/lib/intel/adapters',
  },
]

/** The runtime assertion that must survive in the service module. */
const RUNTIME_ASSERTION = 'assertServerOnly'

const USE_CLIENT = /^\s*['"]use client['"]\s*;?\s*$/

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

/** The 'use client' directive is only a directive when it leads the file,
 *  ahead of everything but comments and blank lines. */
function isClientFile(lines) {
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue
    return USE_CLIENT.test(line)
  }
  return false
}

/** Every module specifier this file imports, static or dynamic. */
function importSpecifiers(text) {
  const out = []
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(text)) !== null) out.push(m[1])
  }
  return out
}

function resolvesToProtected(spec, fileDir, target) {
  const bare = spec.replace(/\.(ts|tsx|js|jsx)$/, '')
  if (target.aliases.includes(bare)) return true
  if (!bare.startsWith('.')) return false
  // Relative import: compare the resolved path against the target's.
  const resolved = join(fileDir, bare).replace(/\\/g, '/')
  const targetNoExt = target.path.replace(/\.ts$/, '')
  return resolved === targetNoExt || resolved.endsWith(`/${targetNoExt}`)
}

const violations = []

// 1 + 3. The protected modules themselves.
for (const target of PROTECTED) {
  let text
  try {
    text = readFileSync(target.path, 'utf8')
  } catch {
    violations.push({
      file: target.path,
      line: 0,
      why: 'protected module is missing. The guard cannot protect a file that is not there.',
    })
    continue
  }
  if (isClientFile(text.split(/\r?\n/))) {
    violations.push({
      file: target.path,
      line: 1,
      why: "carries a 'use client' directive. This module reads other venues as service role and must stay on the server.",
    })
  }
}

try {
  const serviceText = readFileSync(PROTECTED[0].path, 'utf8')
  if (!serviceText.includes(RUNTIME_ASSERTION)) {
    violations.push({
      file: PROTECTED[0].path,
      line: 0,
      why: `no longer calls ${RUNTIME_ASSERTION}(). The runtime browser check is the second line of defence behind this static guard and must stay.`,
    })
  }
} catch {
  // Already reported above.
}

// 2. Client files importing either module.
const files = SCAN_DIRS.flatMap((d) => walk(d))
for (const file of files) {
  const normalised = file.replace(/\\/g, '/')
  if (PROTECTED.some((p) => p.path === normalised)) continue
  const text = readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  if (!isClientFile(lines)) continue

  const fileDir = normalised.slice(0, normalised.lastIndexOf('/'))
  for (const spec of importSpecifiers(text)) {
    for (const target of PROTECTED) {
      if (!resolvesToProtected(spec, fileDir, target)) continue
      const idx = lines.findIndex((l) => l.includes(spec))
      violations.push({
        file: normalised,
        line: idx >= 0 ? idx + 1 : 0,
        why: `is a client component and imports ${target.path}. The benchmark reads other venues as service role; it may never reach a browser bundle.`,
      })
    }
  }
}

if (violations.length > 0) {
  console.log(`\nFound ${violations.length} benchmark server-only violation(s):`)
  for (const v of violations) {
    console.log(`  ${v.file}${v.line ? `:${v.line}` : ''}`)
    console.log(`    ${v.why}`)
  }
  console.log(
    '\nFix: render the benchmark from a server component (the pattern at',
  )
  console.log("src/app/(platform)/intel/benchmark/page.tsx), or fetch it from a")
  console.log('server route that has already authorised the caller. There is no')
  console.log('opt-out marker for this guard on purpose.')
  process.exit(1)
}

console.log('Benchmark stays server-only: no client import, assertion intact.')
