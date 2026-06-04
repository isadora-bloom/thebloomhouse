#!/usr/bin/env node
/**
 * Ratchet — swallowed Supabase writes in src/ (HARDENING-SCOPE Area 1).
 *
 * Counts statement-level awaited inserts/upserts whose result is discarded
 * and that are NOT wrapped in writeOrLog (i.e. a failed write is silent).
 * The count is baselined and may only DECREASE — same doctrine as
 * check-cleanup-budget.mjs / check-no-mirror-source.mjs. Migrating a site to
 * `await writeOrLog(x.insert(...), ctx)` drops the count by one.
 *
 * A "swallowed write" line: starts with `await ` (after indentation), is NOT
 * `await writeOrLog(...)`, and contains `.insert(` or `.upsert(`. Single-line
 * form only (the dominant shape); multiline awaited writes are not counted,
 * consistent with how the baseline was measured.
 *
 * Run: node scripts/check-swallowed-writes.mjs   (exit 0 ok / 1 regressed)
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')
const BASELINE_PATH = join(ROOT, 'scripts', 'swallowed-writes-baseline.json')

const SWALLOWED = /^\s*await\s+(?!writeOrLog\b)[A-Za-z_$][\w$.]*[\s\S]*\.(insert|upsert)\(/
// (per-line; [\s\S]* is within the single line)

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__') continue
      out.push(...walk(p))
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(p)
    }
  }
  return out
}

const hits = []
for (const file of walk(SRC)) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, i) => {
    if (SWALLOWED.test(line) && line.includes('.insert(') === false && line.includes('.upsert(') === false) return
    if (SWALLOWED.test(line)) hits.push(`${file.replace(ROOT + '\\', '').replace(ROOT + '/', '')}:${i + 1}`)
  })
}
const count = hits.length

const baseline = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).count
  : null

console.log(`[swallowed-writes] un-wrapped awaited insert/upsert in src/: ${count}`)
if (baseline === null) {
  console.log(`[swallowed-writes] no baseline yet — write scripts/swallowed-writes-baseline.json { "count": ${count} }`)
  process.exit(0)
}
console.log(`[swallowed-writes] baseline: ${baseline}`)
if (count > baseline) {
  console.error(`[swallowed-writes] REGRESSED — ${count} > ${baseline}. New swallowed writes must route through writeOrLog (src/lib/db/write-or-log.ts).`)
  console.error(hits.slice(0, 20).join('\n'))
  process.exit(1)
}
if (count < baseline) {
  console.log(`[swallowed-writes] ratchet DOWN ${baseline} → ${count}. Update the baseline to lock it.`)
}
process.exit(0)
