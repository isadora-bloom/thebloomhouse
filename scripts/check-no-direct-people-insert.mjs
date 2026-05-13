#!/usr/bin/env node
/**
 * Guard: no direct `.from('people').insert(...)` outside the canonical
 * paths.
 *
 * Companion to `src/lib/services/identity/mint-person.ts`. The people-side
 * mirror of `check-no-direct-wedding-insert.mjs`. Bloom's identity-
 * resolution doctrine (Step 5 / G3, 2026-05-13) says every people
 * creation MUST route through `mintPerson` so:
 *
 *   - the match chain runs first (no duplicate person rows for the
 *     same identity)
 *   - the venue self-loop guard fires (venue's own gmail can't become
 *     a lead)
 *   - the name-capture chokepoint shapes the row (no
 *     `Rosaliehoyle` from `rosaliehoyle@gmail.com`)
 *   - the source label / telemetry records provenance
 *
 * This script keeps the bug class from regrowing — any NEW direct INSERT
 * outside CANONICAL fails CI.
 *
 * The currently-known call sites (2026-05-13) are GRANDFATHERED in:
 * each will be migrated over the coming sessions per the doctrine
 * order-of-work. When a site is migrated to `mintPerson`, remove it
 * from GRANDFATHERED. The end-state is an empty GRANDFATHERED set, same
 * as the wedding-side guard reached on 2026-05-13.
 *
 * Usage:
 *
 *   node scripts/check-no-direct-people-insert.mjs
 *
 * Exit code 0 = clean. Exit code 1 = new direct-INSERT site detected.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]):\//, '$1:/')
const SRC_DIR = join(REPO_ROOT, 'src')

// ---------------------------------------------------------------------------
// Canonical writers — these files are allowed to call `.from('people').insert`
// directly. Everything else MUST route through `mintPerson`.
// ---------------------------------------------------------------------------
const CANONICAL = new Set([
  // resolver.createPerson — mintPerson delegates HERE for the actual INSERT.
  'src/lib/services/identity/resolver.ts',
  // mint-person.ts — the chokepoint itself.
  'src/lib/services/identity/mint-person.ts',
  // merge-people.ts — internal to the people-merge cascade; the row it
  // inserts is the canonical winner of a merge, not a fresh identity.
  'src/lib/services/identity/merge-people.ts',
  // profile-to-people-sync.ts — projects the forensic profile (the
  // source of truth per bloom-constitution.md) onto the legacy people
  // row. Not a fresh identity creation; it's mirroring the truth.
  'src/lib/services/identity/profile-to-people-sync.ts',
  // reconciliation.ts — Stream KK cross-source merge. INSERTs a clone
  // of a loser-wedding's person onto the winner during merge cascade.
  // Not a fresh identity creation; preserving continuity during merge.
  'src/lib/services/identity/reconciliation.ts',
])

// ---------------------------------------------------------------------------
// Grandfathered call sites — pre-2026-05-13 sites that haven't been
// migrated to `mintPerson` yet. Each entry is one file path. The guard
// emits an informational line for these (audit trail) but does NOT fail.
//
// Migration order (cheapest → riskiest):
//   1. brain-dump/imports.ts (offline batch — low risk)
//   2. portal/mint-wedding/route.ts (single-call, isolated)
//   3. data-integrity/remediation/wedding-has-people.ts (3 sites — backfill)
//   4. agent/reprocess-orphans/route.ts (already mintWedding-aware)
//   5. email/pipeline.ts (the hot path — G6 findOrCreateContact collapse)
//
// Any future addition to this set requires a memo entry in
// bloom-identity-resolution-doctrine.md.
// ---------------------------------------------------------------------------
const GRANDFATHERED = new Set([
  'src/app/api/agent/reprocess-orphans/route.ts',
  'src/app/api/portal/mint-wedding/route.ts',
  'src/lib/services/brain-dump/imports.ts',
  'src/lib/services/data-integrity/remediation/wedding-has-people.ts',
  'src/lib/services/email/pipeline.ts',
  // crm-import/index.ts has two INSERT sites for partner1/partner2
  // on CSV ingestion. Lives outside mintPerson scope today; planned
  // for the same migration pass that collapses findOrCreateContact.
  'src/lib/services/crm-import/index.ts',
  // data-import.ts has two INSERT sites (HoneyBook / Knot legacy CSV
  // ingestion). Same migration pass as crm-import.
  'src/lib/services/data-import.ts',
  // brain/router.ts:351 mints a person from in-thread evidence when
  // the resolver missed. Migrate alongside pipeline.ts:findOrCreateContact.
  'src/lib/services/brain/router.ts',
  // _couple-pages/addresses/page.tsx:121 inserts role='parent' rows
  // from the couple-side parent-address form. Out of mintPerson's
  // scope (parent address records, not identity matching). Will get
  // its own primitive if scope grows.
  'src/app/_couple-pages/addresses/page.tsx',
])

// ---------------------------------------------------------------------------
// Walk src/ recursively, collect .ts + .tsx files, regex-match the
// chokepoint pattern.
// ---------------------------------------------------------------------------
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
  // Multi-line regex: `.from('people')` followed (within a few chars
  // + a newline + whitespace) by `.insert(`. Captures both the
  // single-line shape and the more common chained-on-newline shape.
  const re = /\.from\(\s*['"`]people['"`]\s*\)\s*\n?\s*\.\s*insert\s*\(/g
  let match
  while ((match = re.exec(text)) !== null) {
    const upto = text.slice(0, match.index)
    const line = upto.split('\n').length
    if (GRANDFATHERED.has(rel)) {
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
  console.log('OK — no new direct people INSERT sites detected.')
  process.exit(0)
}

// eslint-disable-next-line no-console
console.error('\nFAIL — new direct `.from(\'people\').insert(` call sites detected:\n')
for (const o of OFFENDERS) {
  // eslint-disable-next-line no-console
  console.error(`  ${o.file}:${o.line}`)
}
// eslint-disable-next-line no-console
console.error(
  '\nUse `mintPerson` from `src/lib/services/identity/mint-person.ts` instead.',
)
// eslint-disable-next-line no-console
console.error(
  'If this is a legitimate canonical writer, add it to CANONICAL in this script.',
)
// eslint-disable-next-line no-console
console.error(
  'See bloom-identity-resolution-doctrine.md §"Order of work" step 5/G3.\n',
)
process.exit(1)
