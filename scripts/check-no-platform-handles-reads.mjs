#!/usr/bin/env node
/**
 * Guard: `people.platform_handles` is on its way out.
 *
 * Wave 3, HANDLE-IDENTITY-SPEC.md §1 + §6. A handle is now a first-class
 * identifier on the spine: `couples.handles` and `fragments.handles`
 * (migration 398), written only through `linkSignal`, matched by cascade
 * stage 1d. The legacy home for the same fact is `people.platform_handles`
 * (migration 255), written by the old candidate resolver and read by the
 * clusterer, the convergence sweep, the name-evidence route and its panel.
 *
 * Two stores for one fact is how they drift, and the spec says the legacy
 * one stops being written and readers move across. Nothing FORCES that
 * move, which is the same disease the cleanup-budget ratchet exists for.
 * So: this counts every mention of `platform_handles` under src/ against a
 * committed baseline and fails when the number goes UP. W23 and W24 lower
 * it as they move the social paths onto the spine; the target is zero.
 *
 * The probe counts MENTIONS, not just reads. A docstring referring to the
 * column counts too. That is deliberate. A comment about a column you have
 * stopped using should be deleted with the code, and counting loosely means
 * nobody can dodge the ratchet by moving a select into a string constant.
 *
 * Usage:
 *   node scripts/check-no-platform-handles-reads.mjs            # CI
 *   node scripts/check-no-platform-handles-reads.mjs --report   # list, exit 0
 *   node scripts/check-no-platform-handles-reads.mjs --update   # re-baseline
 *
 * Exit 0 = at or below baseline. Exit 1 = the count rose.
 */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]):\//, '$1:/')
const SRC_DIR = join(REPO_ROOT, 'src')
const BASELINE_PATH = join(REPO_ROOT, 'scripts', 'platform-handles-baseline.json')

const MODE =
  process.argv.includes('--update') ? 'update'
  : process.argv.includes('--report') ? 'report'
  : 'check'

const PATTERN = /platform_handles/g

const hits = []

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
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const matches = lines[i].match(PATTERN)
    if (matches) hits.push({ file: rel, line: i + 1, count: matches.length })
  }
}

walk(SRC_DIR)

const total = hits.reduce((s, h) => s + h.count, 0)
const byFile = new Map()
for (const h of hits) byFile.set(h.file, (byFile.get(h.file) ?? 0) + h.count)

if (MODE === 'update') {
  const snapshot = {
    _README:
      'Wave 3 ratchet (HANDLE-IDENTITY-SPEC.md §6). Mentions of people.platform_handles'
      + ' under src/. May only DECREASE. The spine home for a handle is couples.handles'
      + ' (migration 398). Target 0. Re-baseline deliberately with --update; the diff is'
      + ' the human decision point.',
    total,
    files: Object.fromEntries([...byFile.entries()].sort()),
  }
  writeFileSync(BASELINE_PATH, JSON.stringify(snapshot, null, 2) + '\n')
  console.log(`platform-handles-baseline.json snapshotted: total ${total} across ${byFile.size} files.`)
  process.exit(0)
}

if (!existsSync(BASELINE_PATH)) {
  console.error(
    `\nNo baseline at ${BASELINE_PATH}.\n`
      + 'Seed it once:\n  node scripts/check-no-platform-handles-reads.mjs --update\n'
      + 'then commit it.\n',
  )
  process.exit(1)
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
const budget = typeof baseline.total === 'number' ? baseline.total : Infinity

console.log(`\npeople.platform_handles mentions under src/: ${total} (baseline ${budget})`)

if (MODE === 'report' || total > budget) {
  const known = baseline.files ?? {}
  for (const [file, count] of [...byFile.entries()].sort((a, b) => b[1] - a[1])) {
    const was = known[file] ?? 0
    const mark = count > was ? ' ← ROSE' : count < was ? ' (down)' : ''
    console.log(`  ${String(count).padStart(3)}  ${file}${mark}`)
  }
  for (const file of Object.keys(known)) {
    if (!byFile.has(file)) console.log(`    0  ${file} (gone)`)
  }
}

if (MODE === 'report') process.exit(0)

if (total > budget) {
  console.error(
    '\nFAIL, reads of people.platform_handles grew.\n'
      + 'A handle lives on the spine now: couples.handles / fragments.handles\n'
      + '(migration 398), written through linkSignal and matched by cascade stage\n'
      + '1d. Read couples.handles instead. If a legacy read is genuinely still\n'
      + 'needed, raise the baseline deliberately with --update and say why in the\n'
      + 'commit. See HANDLE-IDENTITY-SPEC.md §1 + §6.\n',
  )
  process.exit(1)
}

console.log(
  total < budget
    ? 'OK, below baseline. Ratchet it down with --update so the gain cannot regress.'
    : 'OK, at baseline.',
)
process.exit(0)
