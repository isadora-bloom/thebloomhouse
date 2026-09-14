#!/usr/bin/env node
/**
 * Guard: nothing under src/ may INSERT or UPSERT into `tangential_signals`.
 *
 * Wave 3 (W24) retired the tangential pool and migration 400 stamped
 * "DEPRECATED ... No new rows" on the table. The comment was aspirational.
 * A verification pass on 2026-09-14 found four live writers still filling
 * it: the website-pixel adapter, the storefront-activity adapter, the
 * web-form adapter and the universal platform-signals importer, which is
 * the widest CSV path in the product. So the platform still had two
 * identity systems and two answers to the same question, and the schema
 * said otherwise.
 *
 * W68 (wave 9) routed all four through `linkSignal` and corrected the
 * table comment in migration 412. This guard is the lockdown, per the
 * fix-the-class-then-guard-it rule: the fix is worth nothing if the next
 * adapter quietly adds a fifth writer.
 *
 * READS ARE FINE. The table keeps years of evidence and the correlation
 * engine, the journey narrative, the erasure sweep and several intel
 * surfaces read it on purpose. This guard only refuses NEW ROWS, which is
 * exactly what migration 400 and 412 promise.
 *
 * What it looks for, under src/ only:
 *   - `.from('tangential_signals')` followed by `.insert(` or `.upsert(`
 *     within a short window (the supabase-js builder chain spans lines).
 *   - `INSERT INTO tangential_signals` / `insert into tangential_signals`
 *     in a raw SQL string, so nobody routes round the client.
 *
 * Usage:
 *   node scripts/check-no-tangential-writes.mjs            # CI
 *   node scripts/check-no-tangential-writes.mjs --report    # list, exit 0
 *
 * Exit 0 = no writers. Exit 1 = a writer came back.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]):\//, '$1:/')
const SRC_DIR = join(REPO_ROOT, 'src')

const MODE = process.argv.includes('--report') ? 'report' : 'check'

/** How far after `.from('tangential_signals')` a write verb still counts as
 *  part of the same builder chain. Generous on purpose: the chains in this
 *  repo run to a dozen lines with comments interleaved. */
const CHAIN_WINDOW_LINES = 25

const TABLE = 'tangential_signals'
const FROM_RE = /\.from\(\s*['"`]tangential_signals['"`]\s*\)/
const WRITE_RE = /\.\s*(insert|upsert)\s*\(/
/** A terminating read verb: once the chain has clearly become a SELECT we
 *  stop looking, so a `.select(...).eq(...)` block cannot be tripped by an
 *  unrelated `.insert(` further down the file. */
const READ_TERMINATOR_RE = /\.\s*(select|delete|update)\s*\(/
const RAW_SQL_RE = new RegExp(`insert\\s+into\\s+(public\\.)?${TABLE}\\b`, 'i')

const violations = []

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue
      walk(full)
    } else if (st.isFile() && /\.(ts|tsx|mjs|js)$/.test(entry)) {
      scan(full)
    }
  }
}

function scan(file) {
  const rel = relative(REPO_ROOT, file).replace(/\\/g, '/')
  const lines = readFileSync(file, 'utf8').split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (RAW_SQL_RE.test(line)) {
      violations.push({ file: rel, line: i + 1, kind: 'raw SQL', text: line.trim() })
      continue
    }

    if (!FROM_RE.test(line)) continue

    // Same line, e.g. `supabase.from('tangential_signals').insert(rows)`.
    const after = line.slice(line.search(FROM_RE))
    if (WRITE_RE.test(after)) {
      violations.push({ file: rel, line: i + 1, kind: 'insert/upsert', text: line.trim() })
      continue
    }
    if (READ_TERMINATOR_RE.test(after)) continue

    for (let j = i + 1; j < Math.min(lines.length, i + 1 + CHAIN_WINDOW_LINES); j++) {
      const next = lines[j]
      if (WRITE_RE.test(next)) {
        violations.push({ file: rel, line: j + 1, kind: 'insert/upsert', text: next.trim() })
        break
      }
      if (READ_TERMINATOR_RE.test(next)) break
    }
  }
}

walk(SRC_DIR)

if (violations.length === 0) {
  console.log(`OK: no ${TABLE} insert or upsert under src/ (${MODE}).`)
  process.exit(0)
}

console.error(`\nFAIL: ${violations.length} write(s) into ${TABLE} under src/.\n`)
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  [${v.kind}]  ${v.text}`)
}
console.error(
  `\n${TABLE} is deprecated (migrations 400 and 412). It is a historical read` +
    '\nsurface and takes no new rows. Build a NormalizedSignal and call' +
    "\nlinkSignal instead — see src/lib/services/ingestion/tangential-signals.ts" +
    '\nfor the reference conversion, and HANDLE-IDENTITY-SPEC.md sections 4 and 5' +
    '\nfor why. Below threshold your signal becomes a fragment, which is the pool' +
    '\nthis table was reaching for, except fragments get promoted onto a couple.\n',
)
process.exit(MODE === 'report' ? 0 : 1)
