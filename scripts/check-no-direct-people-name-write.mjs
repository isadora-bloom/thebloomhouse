#!/usr/bin/env node
/**
 * Guard: no direct `.from('people').update({ ... first_name OR last_name ... })`
 * outside the canonical name-capture / sync / resolver / merge writers.
 *
 * Companion to `src/lib/services/identity/name-capture.ts`. Sophie trace
 * (RM-1040 / 2026-05-12) surfaced that bypass writers were stamping
 * `people.first_name` / `people.last_name` directly without routing through
 * the `captureNameEvidence` chokepoint. The picker projects from
 * `name_evidence` → first_name/last_name/display_handle/name_confidence;
 * a direct column write skips the picker and leaves the evidence array
 * inconsistent with the displayed name. Every later signal then has to
 * fight the existing column instead of layering on top.
 *
 * The fix shape: every writer that wants to claim a name MUST flow through
 * `captureNameEvidence` so the evidence array is the source of truth and
 * the picker dual-writes the legacy columns. Canonical writers below own
 * the few legitimate direct-write paths (the chokepoint itself, the Wave-4
 * forensic profile sync, mergePeople field backfill, name-upgrade pipeline,
 * resolver's null-then-capture insert).
 *
 * Catches:
 *   - `.from('people').update({ first_name: ... })`
 *   - `.from('people').update({ last_name: ... })`
 *   - `.from('people').update({ ... first_name: ..., last_name: ... })`
 *   - Same shape with double quotes / backticks / chained-on-newline
 *
 * Doesn't catch:
 *   - `.update(updates)` where `updates` is a built-up variable. Those
 *     paths still bypass the chokepoint but the regex is intentionally
 *     conservative (false-positive cost > miss cost at this stage).
 *     Add named-variable tracing as a follow-up if the bypass class
 *     resurfaces.
 *   - Raw SQL via supabase RPC or direct migration UPDATEs (rare; treat
 *     as a separate audit class).
 *
 * Usage:
 *
 *   node scripts/check-no-direct-people-name-write.mjs
 *
 * Exit 0 = clean. Exit 1 = new direct first_name/last_name writer detected.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]):\//, '$1:/')
const SRC_DIR = join(REPO_ROOT, 'src')

// ---------------------------------------------------------------------------
// Canonical writers — allowed to set people.first_name / people.last_name
// directly because they ARE the chokepoint or its trusted projection peers.
// ---------------------------------------------------------------------------
const CANONICAL = new Set([
  // The chokepoint itself — dual-writes the legacy columns after the
  // picker runs over the updated evidence array.
  'src/lib/services/identity/name-capture.ts',
  // Legacy resolver, still in use. Canonical writer for NEW person
  // creation (inserts with null first/last, then captures every signal
  // through the chokepoint).
  'src/lib/services/identity/resolver.ts',
  // mergePeople / softTombstonePerson — reassigns first_name/last_name
  // from the merged row onto the kept row when kept's was null.
  'src/lib/services/identity/merge-people.ts',
  // Already chokepoint-aware — the form-bleed token blacklist + skip
  // rules ride above the legacy column write; the picker rerun is
  // wrapped in the same pass.
  'src/lib/services/identity/name-upgrade.ts',
  // Wave-4 forensic profile → people projection. The Sonnet judge in
  // reconstruct.ts is the source of truth; this sync writes the
  // partner1/partner2 first_name/last_name from `couple_identity_profile`
  // alongside an evidence row tagged source='reconstruction'.
  'src/lib/services/identity/profile-to-people-sync.ts',
])

// ---------------------------------------------------------------------------
// Grandfathered call sites. Each entry must carry an inline comment
// explaining why it can't route through the chokepoint. Default answer is
// "use captureNameEvidence instead" — only legitimate non-signal column
// writes belong here.
// ---------------------------------------------------------------------------
const GRANDFATHERED = new Map([
  [
    'src/app/api/admin/repair-form-bleed-names/route.ts',
    'One-shot JUNK-CLEAR endpoint: NULLs out first_name/last_name on rows where '
      + 'the legacy regex pipeline wrote Calendly form-bleed tokens. Not asserting a '
      + 'name — clearing junk so the reconstruct judge has a clean canvas. The '
      + 'chokepoint has no "clear" verb; null-write is the correct shape.',
  ],
  [
    'src/lib/services/compliance/erasure.ts',
    'CCPA / GDPR right-to-erasure — replaces first_name/last_name with the '
      + '[redacted] sentinel as part of a coordinated multi-table anonymisation. '
      + 'Not asserting an identity claim; the chokepoint would actively work '
      + 'against the erasure intent (it would record a "manual_override" '
      + 'evidence row containing the redaction sentinel).',
  ],
])

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
  // mentions first_name or last_name within ~400 chars. The 400-char
  // window is generous enough to catch multi-line update payloads but
  // tight enough to avoid false positives on adjacent unrelated update
  // calls.
  const re = /\.from\(\s*['"`]people['"`]\s*\)\s*\n?\s*\.\s*update\s*\(\s*\{[^}]{0,400}(first_name|last_name)/gs
  let match
  while ((match = re.exec(text)) !== null) {
    const upto = text.slice(0, match.index)
    const line = upto.split('\n').length
    if (GRANDFATHERED.has(rel)) {
      // eslint-disable-next-line no-console
      console.log(`grandfathered: ${rel}:${line} — ${GRANDFATHERED.get(rel)}`)
    } else {
      OFFENDERS.push({ file: rel, line })
    }
  }
}

walk(SRC_DIR)

if (OFFENDERS.length === 0) {
  // eslint-disable-next-line no-console
  console.log('OK — no new direct people.first_name / people.last_name writers detected.')
  process.exit(0)
}

// eslint-disable-next-line no-console
console.error(
  "\nFAIL — new direct `.from('people').update({ ... first_name OR last_name ... })` call sites detected:\n",
)
for (const o of OFFENDERS) {
  // eslint-disable-next-line no-console
  console.error(`  ${o.file}:${o.line}`)
}
// eslint-disable-next-line no-console
console.error(
  '\nRoute through `captureNameEvidence` from '
    + '`src/lib/services/identity/name-capture.ts` instead.',
)
// eslint-disable-next-line no-console
console.error(
  'Writing first_name / last_name directly skips the picker — '
    + 'the displayed name diverges from the name_evidence chain, '
    + 'and every later signal has to fight the existing column instead '
    + 'of layering on top.',
)
// eslint-disable-next-line no-console
console.error(
  'See bloom-constitution.md + name-capture.ts header comments for the '
    + 'chokepoint contract.\n',
)
process.exit(1)
