#!/usr/bin/env node
/**
 * Guard: no direct `.from('weddings').insert(...)` outside the canonical
 * paths.
 *
 * Companion to `src/lib/services/identity/mint-wedding.ts`. The audit
 * IDENTITY-RESOLUTION-AUDIT-2026-05-12.md F5 catalogued 8 call sites that
 * INSERT weddings directly, each one re-implementing identity matching
 * with slightly different defaults. The fix is one canonical helper
 * (`mintWedding`). This script keeps the bug class from regrowing — any
 * NEW direct INSERT outside the allowlist fails CI.
 *
 * The 8 historical call sites are grandfathered in via ALLOW. They get
 * migrated to `mintWedding` in the next sweep (see
 * `docs/IDENTITY-CHOKEPOINT-MIGRATION.md`). When a site is migrated,
 * remove it from ALLOW.
 *
 * Usage:
 *
 *   node scripts/check-no-direct-wedding-insert.mjs
 *
 * Exit code 0 = clean. Exit code 1 = new direct-INSERT site detected;
 * the script prints the offending file:line and exits non-zero so CI
 * fails.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]):\//, '$1:/')
const SRC_DIR = join(REPO_ROOT, 'src')

// ---------------------------------------------------------------------------
// Canonical writers — these files are allowed to call `.from('weddings').insert`
// directly. Everything else MUST route through `mintWedding`.
// ---------------------------------------------------------------------------
const CANONICAL = new Set([
  'src/lib/services/identity/resolver.ts',
  'src/lib/services/identity/mint-wedding.ts',
])

// ---------------------------------------------------------------------------
// Grandfathered call sites — these are scheduled for migration to
// `mintWedding` in the next sweep. Remove from this list as each one is
// migrated. Adding NEW entries here without an explicit migration plan
// defeats the purpose of the guard.
//
// 2026-05-12 sweep: 8 sites migrated (brain-dump/imports, data-import,
// crm-import/index, reprocess-form-relays, reprocess-orphans, the two
// portal/weddings/page.tsx INSERTs collapsed into one server endpoint,
// and that new /api/portal/mint-wedding route which is itself a
// mintWedding caller). The two pipeline.ts INSERTs are the only
// remaining direct writers, deferred for a separate soak. See
// docs/IDENTITY-CHOKEPOINT-MIGRATION.md.
// ---------------------------------------------------------------------------
const GRANDFATHERED = new Set([
  'src/lib/services/email/pipeline.ts',
])

// Walk src/ recursively, collect .ts + .tsx files, regex-match the
// chokepoint pattern. Multi-line so the `\n.insert` shape is caught.
const OFFENDERS = []

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue
      walk(full)
    } else if (st.isFile()) {
      if (!/\.(ts|tsx|mjs|js)$/.test(entry)) continue
      scan(full)
    }
  }
}

function scan(file) {
  const rel = relative(REPO_ROOT, file).replace(/\\/g, '/')
  if (CANONICAL.has(rel)) return
  const text = readFileSync(file, 'utf8')
  // Multi-line regex: `.from('weddings')` followed (within a few chars
  // + a newline + whitespace) by `.insert(`. Captures both the
  // single-line shape and the more common chained-on-newline shape.
  const re = /\.from\(\s*['"`]weddings['"`]\s*\)\s*\n?\s*\.\s*insert\s*\(/g
  let match
  while ((match = re.exec(text)) !== null) {
    // Compute line number for the offender.
    const upto = text.slice(0, match.index)
    const line = upto.split('\n').length
    if (GRANDFATHERED.has(rel)) {
      // Grandfathered — emit an informational line but don't fail.
      // Keeps the audit trail visible without blocking CI.
      // eslint-disable-next-line no-console
      console.log(`grandfathered: ${rel}:${line}`)
    } else {
      OFFENDERS.push({ file: rel, line })
    }
  }
}

walk(SRC_DIR)

if (OFFENDERS.length === 0) {
  // eslint-disable-next-line no-console
  console.log('OK — no new direct wedding INSERT sites detected.')
  process.exit(0)
}

// eslint-disable-next-line no-console
console.error('\nFAIL — new direct `.from(\'weddings\').insert(` call sites detected:\n')
for (const o of OFFENDERS) {
  // eslint-disable-next-line no-console
  console.error(`  ${o.file}:${o.line}`)
}
// eslint-disable-next-line no-console
console.error(
  '\nUse `mintWedding` from `src/lib/services/identity/mint-wedding.ts` instead.',
)
// eslint-disable-next-line no-console
console.error(
  'If this is a legitimate canonical writer, add it to CANONICAL in this script.',
)
// eslint-disable-next-line no-console
console.error(
  'See docs/IDENTITY-CHOKEPOINT-MIGRATION.md for the migration path.\n',
)
process.exit(1)
