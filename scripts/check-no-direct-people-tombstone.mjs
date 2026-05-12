#!/usr/bin/env node
/**
 * Guard: no direct `.from('people').update({ ... merged_into_id ... })`
 * outside the canonical merge-people module.
 *
 * Companion to `src/lib/services/identity/merge-people.ts`. The trace
 * MERGED-INTO-ID-TRACE-2026-05-12.md found that `applyPhantomTombstone`
 * in `profile-to-people-sync.ts` was setting `merged_into_id` directly
 * without reassigning FK children — exactly the pattern the audit
 * IDENTITY-RESOLUTION-AUDIT-2026-05-12.md flagged as F5 (bypass paths
 * that re-implement subsets of canonical logic).
 *
 * The fix shape: `merge-people.ts` exports `mergePeople` (hard delete +
 * FK reassign) and `softTombstonePerson` (FK reassign + tombstone via
 * merged_into_id). Every writer of `people.merged_into_id` MUST go
 * through one of these. This script enforces that.
 *
 * Catches:
 *   - `.from('people').update({ merged_into_id: ... })`
 *   - `.from('people').update({ ... merged_into_id: ... })` (multi-key)
 *   - Same shape with double quotes / backticks / chained-on-newline
 *
 * Doesn't catch:
 *   - Raw SQL via supabase RPC or direct migration UPDATEs (rare; treat
 *     as a separate audit class).
 *   - Server actions that route through a write helper named something
 *     other than `merge-people` (none today).
 *
 * Usage:
 *
 *   node scripts/check-no-direct-people-tombstone.mjs
 *
 * Exit 0 = clean. Exit 1 = new direct tombstone site detected.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]):\//, '$1:/')
const SRC_DIR = join(REPO_ROOT, 'src')

// ---------------------------------------------------------------------------
// Canonical writers — allowed to set people.merged_into_id directly.
// ---------------------------------------------------------------------------
const CANONICAL = new Set([
  'src/lib/services/identity/merge-people.ts',
])

// ---------------------------------------------------------------------------
// Grandfathered call sites. Empty after the 2026-05-12 fix that routed
// applyPhantomTombstone through softTombstonePerson. If a legitimate
// new writer surfaces and you can defend its bypass, add it here with
// a comment explaining why — but the default answer is "use
// softTombstonePerson or mergePeople instead."
// ---------------------------------------------------------------------------
const GRANDFATHERED = new Set([])

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
  // + a newline + whitespace) by `.update(` and an open object that
  // mentions merged_into_id within ~200 chars. The 200-char window is
  // generous enough to catch multi-line update payloads but tight
  // enough to avoid false positives on adjacent unrelated update calls.
  const re = /\.from\(\s*['"`]people['"`]\s*\)\s*\n?\s*\.\s*update\s*\(\s*\{[^}]{0,400}merged_into_id/gs
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
  console.log('OK — no new direct people.merged_into_id writers detected.')
  process.exit(0)
}

// eslint-disable-next-line no-console
console.error(
  "\nFAIL — new direct `.from('people').update({ ... merged_into_id ... })` call sites detected:\n",
)
for (const o of OFFENDERS) {
  // eslint-disable-next-line no-console
  console.error(`  ${o.file}:${o.line}`)
}
// eslint-disable-next-line no-console
console.error(
  '\nUse `softTombstonePerson` or `mergePeople` from `src/lib/services/identity/merge-people.ts` instead.',
)
// eslint-disable-next-line no-console
console.error(
  'Setting merged_into_id directly skips FK child reassignment '
    + '(interactions, drafts, engagement_events, contacts, tangential_signals) '
    + 'and orphans them to a tombstoned parent.',
)
// eslint-disable-next-line no-console
console.error(
  'See MERGED-INTO-ID-TRACE-2026-05-12.md for the trace + rationale.\n',
)
process.exit(1)
