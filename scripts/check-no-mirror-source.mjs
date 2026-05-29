#!/usr/bin/env node
/**
 * Guard: ingestion adapters read ORIGIN, never our own derived tables
 * (Non-negotiable N3 / ORIGIN-INGESTION-SPEC.md / Phase 1.1).
 *
 * The deepest flaw the audit found: the Backwards Tracer rebuilds the
 * spine by reading DB MIRRORS (`interactions`, `tours`,
 * `candidate_identities`, `weddings`, `people`), so any extraction
 * defect is laundered into the spine as if it were ground truth, and
 * `interactions` can never be deleted (circular — gap G1).
 *
 * This guard scans the ingestion adapter surface and flags any read of
 * a derived/mirror table. The end state (Phase 1.1 complete) is ZERO:
 * adapters pull only from external origins (Gmail API, Calendly API,
 * CSV exports, webhooks) and write only through `linkSignal`.
 *
 * RATCHET: like check-rls-on-venue-id, the violation count is baselined
 * (`mirror-source-baseline.json`) and may only DECREASE. It starts
 * non-zero (the 5 Tracer adapters) and the fold drives it to 0, at
 * which point this guard flips to "must be 0" and the
 * `sources/{gmail,calendly,knot,instagram,anchors}.ts` adapters are
 * deleted.
 *
 *   node scripts/check-no-mirror-source.mjs            # enforce vs baseline
 *   node scripts/check-no-mirror-source.mjs --report   # list, exit 0
 *   node scripts/check-no-mirror-source.mjs --update    # snapshot baseline
 *
 * Companion: ORIGIN-INGESTION-SPEC.md, PHASE-1.1-TRACER-FOLD.md,
 * BLOOM-CONSOLIDATION-GAP-REGISTER.md (G1/N3).
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]):\//, '$1:/')
const BASELINE_PATH = join(REPO_ROOT, 'scripts', 'mirror-source-baseline.json')
const REPORT = process.argv.includes('--report')
const UPDATE = process.argv.includes('--update')

// The ingestion-adapter surface that must be origin-only.
const SCAN_DIRS = [
  join(REPO_ROOT, 'src', 'lib', 'services', 'identity', 'sources'),
  // add more adapter dirs here as the origin-ingestion surface grows
]

// Derived/mirror tables an adapter must NEVER read (it is rebuilt FROM
// the spine, or it IS the legacy spine). Reading any = laundering a
// derivation into "ground truth".
const MIRROR_TABLES = [
  'interactions',
  'tours',
  'candidate_identities',
  'weddings',
  'people',
  'wedding_touchpoints',
  'attribution_events',
]

// `.from('<table>')` read (we don't distinguish select vs insert here —
// an adapter should not TOUCH a mirror at all).
const fromPattern = (t) => new RegExp(`\\.from\\(\\s*['"\`]${t}['"\`]\\s*\\)`, 'g')

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir)) {
    const full = join(dir, e)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|mjs|js)$/.test(e) && !e.endsWith('.test.ts')) out.push(full)
  }
  return out
}

const violations = []
for (const dir of SCAN_DIRS) {
  for (const file of walk(dir)) {
    const rel = file.replace(REPO_ROOT, '').replace(/\\/g, '/').replace(/^\//, '')
    const text = readFileSync(file, 'utf8')
    for (const t of MIRROR_TABLES) {
      let m
      const re = fromPattern(t)
      while ((m = re.exec(text)) !== null) {
        const line = text.slice(0, m.index).split('\n').length
        violations.push({ file: rel, line, table: t })
      }
    }
  }
}

console.log(`check-no-mirror-source: ${violations.length} mirror-read(s) in the ingestion-adapter surface.`)

if (UPDATE) {
  writeFileSync(BASELINE_PATH, JSON.stringify({ reads: violations.length }, null, 2) + '\n')
  console.log(`mirror-source-baseline.json set to { reads: ${violations.length} }. Commit it; the count may only fall (target 0).`)
  process.exit(0)
}

const log = REPORT ? console.log : console.error
if (violations.length) {
  log('\nadapters reading derived/mirror tables (must pull from ORIGIN — N3):\n')
  for (const v of violations) log(`  ${v.file}:${v.line} — .from('${v.table}')`)
  log('\nReplace with an external-origin pull (Gmail/Calendly API, CSV export, webhook) routed through linkSignal. See PHASE-1.1-TRACER-FOLD.md.\n')
}

if (REPORT) process.exit(0)
if (violations.length === 0) { console.log('OK — no mirror reads. Origin-only ingestion achieved (N3).'); process.exit(0) }

const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).reads : null
if (baseline === null) {
  console.error('No mirror-source-baseline.json — seed once: node scripts/check-no-mirror-source.mjs --update, then commit.\n')
  process.exit(1)
}
if (violations.length > baseline) {
  console.error(`FAIL — mirror reads rose ${baseline} → ${violations.length}. A new adapter is reading a derived table. Pull from origin instead.\n`)
  process.exit(1)
}
console.log(`\nOK — ${violations.length} mirror read(s), at/below baseline ${baseline}.`
  + (violations.length < baseline ? ' Some retired — run --update to ratchet down.' : ' (Phase 1.1 drives this to 0.)'))
process.exit(0)
