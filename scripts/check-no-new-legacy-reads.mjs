// W2 ratchet — legacy-table reads inside src/app may only fall.
//
// The problem this locks in
// -------------------------
// The six canonical readers in src/lib/intel/canonical.ts are real,
// tested, and read the identity spine. For months no page called them.
// Pages read `weddings`, `people`, `interactions`, `attribution_events`
// and `wedding_touchpoints` directly instead, each with its own idea of
// what a conversion rate is, which is how one question came to have
// three answers on three pages.
//
// Undoing that is a long job. This guard makes it a one-way job: the
// count of legacy reads under src/app is written down, and a change that
// raises it fails. Lowering it is expected, and the failure message tells
// you to lower the baseline with it.
//
// What counts
// -----------
// Any `.from('weddings')` (and the four siblings) in a .ts / .tsx file
// under src/app — pages, components and route handlers alike. Route
// handlers count on purpose: moving a legacy read from a page into an
// API route beside it is a tidier place to keep the same problem, not a
// fix. The fix is to read the spine.
//
// What does not count
// -------------------
//   - comment lines, so prose about the tables does not trip the guard;
//   - `.from('couples')`, `.from('touchpoints')` and the rest of the
//     spine — those are the destination, not the debt;
//   - anything outside src/app. Services and scripts have their own
//     migration path and their own guards.
//
// Opting a line out
// -----------------
// A genuinely irreducible read — one where the spine carries no
// equivalent column — can be tagged on the call line or in a comment
// within four lines above it:
//
//   // legacy-read-ok: raw_import_row has no spine equivalent
//
// Opt-outs are reported in the summary so they stay visible rather than
// accumulating in the dark.
//
// Run:
//   node scripts/check-no-new-legacy-reads.mjs
//   node scripts/check-no-new-legacy-reads.mjs --write   (update baseline)

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SCAN_DIR = 'src/app'
const BASELINE_PATH = 'scripts/legacy-reads-baseline.json'

/** The legacy stack. Everything the identity-first spine replaced. */
const LEGACY_TABLES = [
  'weddings',
  'people',
  'interactions',
  'attribution_events',
  'wedding_touchpoints',
]

const OPT_OUT_MARKER = /legacy-read-ok:/

function patternFor(table) {
  // `.from('weddings')` with any whitespace, single or double quoted.
  return new RegExp(`\\.\\s*from\\s*\\(\\s*['"]${table}['"]\\s*\\)`)
}

const PATTERNS = LEGACY_TABLES.map((t) => ({ table: t, re: patternFor(t) }))

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

const files = walk(SCAN_DIR)
const counts = Object.fromEntries(LEGACY_TABLES.map((t) => [t, 0]))
const sites = []
let optedOut = 0

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    // Pure-comment lines are prose, not reads.
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
    for (const { table, re } of PATTERNS) {
      if (!re.test(line)) continue
      if (isOptedOut(lines, i)) {
        optedOut++
        continue
      }
      counts[table]++
      sites.push({ file: file.replace(/\\/g, '/'), line: i + 1, table })
    }
  }
}

const total = Object.values(counts).reduce((a, b) => a + b, 0)

if (process.argv.includes('--write')) {
  const payload = {
    _comment:
      'W2 ratchet baseline. Counts of legacy-table reads under src/app. These numbers may only fall. Regenerate with: node scripts/check-no-new-legacy-reads.mjs --write',
    scanDir: SCAN_DIR,
    tables: counts,
    total,
    updatedAt: new Date().toISOString().slice(0, 10),
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  console.log(`Baseline written to ${BASELINE_PATH}: total ${total}`)
  process.exit(0)
}

let baseline
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
} catch {
  console.error(
    `Missing or unreadable ${BASELINE_PATH}. Create it with:\n  node scripts/check-no-new-legacy-reads.mjs --write`,
  )
  process.exit(1)
}

const rows = []
let regressed = false
let improved = false

for (const table of LEGACY_TABLES) {
  const current = counts[table]
  const budget = baseline.tables?.[table] ?? 0
  let status = 'at baseline'
  if (current > budget) {
    status = 'GREW'
    regressed = true
  } else if (current < budget) {
    status = 'fell'
    improved = true
  }
  rows.push({ table, current, budget, status })
}

console.log('\nLegacy reads under src/app (spine migration ratchet):\n')
console.log('  table                  current  baseline  status')
for (const r of rows) {
  console.log(
    `  ${r.table.padEnd(21)} ${String(r.current).padEnd(8)} ${String(r.budget).padEnd(9)} ${r.status}`,
  )
}
console.log(`  ${'TOTAL'.padEnd(21)} ${String(total).padEnd(8)} ${String(baseline.total ?? 0).padEnd(9)}`)
if (optedOut > 0) {
  console.log(`\n  ${optedOut} read(s) tagged legacy-read-ok and not counted.`)
}

if (regressed) {
  console.log('\nFAIL — a legacy read was added under src/app.')
  console.log(
    'A surface should read the spine through one of the six canonical readers',
  )
  console.log('in src/lib/intel/canonical.ts, not the legacy tables directly.')
  console.log('See INTEL-CANONICAL-API.md for which reader answers which question.')
  console.log('\nNew or moved sites, if you need to find them:')
  for (const s of sites.slice(0, 40)) {
    console.log(`  ${s.file}:${s.line}  (${s.table})`)
  }
  if (sites.length > 40) console.log(`  ... and ${sites.length - 40} more`)
  console.log(
    '\nIf the read is genuinely irreducible, tag the line:  // legacy-read-ok: <reason>',
  )
  process.exit(1)
}

if (improved) {
  console.log(
    '\nDebt fell. Lower the baseline so it cannot come back:\n  node scripts/check-no-new-legacy-reads.mjs --write',
  )
  process.exit(1)
}

console.log('\nOK — no new legacy reads under src/app.')
