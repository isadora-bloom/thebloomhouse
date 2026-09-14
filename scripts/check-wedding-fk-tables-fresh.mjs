#!/usr/bin/env node
/**
 * Guard: the generated wedding cascade file is not behind the migrations.
 *
 * W60 (2026-09-14). Companion to check-merge-weddings-cascade.mjs, which
 * needs the database and therefore cannot run in CI. This one is pure
 * file reading, so it runs on every push.
 *
 * mergeWeddings iterates src/lib/services/identity/wedding-fk-tables.generated.json.
 * That file is generated from the live schema and records the migration
 * number it was generated at. If a later migration adds a wedding_id
 * column, or a new unique constraint on wedding_id, the file is stale and
 * the next merge leaves those rows on the losing wedding, which is the
 * exact failure this workstream exists to close.
 *
 * Checks
 * ------
 *   1. Freshness. Every migration numbered above the watermark is scanned
 *      for a new wedding_id column or a new unique key on wedding_id. Any
 *      hit fails, naming the migration and the fix.
 *   2. Shape. Every entry has a known strategy, a reason, and (where the
 *      strategy needs one) a primary key to move rows by.
 *   3. Wiring. resolver.ts imports the generated file and has no
 *      hand-written reassign('table') list left behind.
 *
 * Fix for a failure of check 1:
 *   npx tsx scripts/gen-wedding-fk-tables.ts
 * then commit the regenerated file.
 *
 * Run:  node scripts/check-wedding-fk-tables-fresh.mjs
 * CI:   .github/workflows/ci.yml, and npm run check:governance
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const GENERATED = 'src/lib/services/identity/wedding-fk-tables.generated.json'
const RESOLVER = 'src/lib/services/identity/resolver.ts'
const MIGRATION_DIR = 'supabase/migrations'

const KNOWN_STRATEGIES = new Set([
  'reassign',
  'merge_one_per_wedding',
  'trigger_covered',
  'skip_archived',
  'skip_view',
  'skip_history',
  'skip_self_reference',
])

const problems = []

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------
let doc
try {
  doc = JSON.parse(readFileSync(GENERATED, 'utf8'))
} catch (err) {
  console.error(`✗ cannot read ${GENERATED}: ${err.message}`)
  console.error('  Generate it: npx tsx scripts/gen-wedding-fk-tables.ts')
  process.exit(1)
}

const watermark = Number(doc.migration_watermark)
const tables = Array.isArray(doc.tables) ? doc.tables : []
if (!Number.isFinite(watermark) || watermark <= 0) {
  problems.push(`${GENERATED} has no usable migration_watermark`)
}
if (tables.length === 0) {
  problems.push(`${GENERATED} lists no tables`)
}

// ---------------------------------------------------------------------------
// 1. Freshness: migrations newer than the watermark
// ---------------------------------------------------------------------------
const newer = readdirSync(MIGRATION_DIR)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => ({ file: f, n: Number((f.match(/^(\d+)_/) ?? [])[1] ?? NaN) }))
  .filter((f) => Number.isFinite(f.n) && f.n > watermark)
  .sort((a, b) => a.n - b.n)

const stale = []
for (const { file } of newer) {
  const sql = readFileSync(join(MIGRATION_DIR, file), 'utf8')
  const reasons = []

  // ALTER TABLE x ADD COLUMN wedding_id ...
  const addCol =
    /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?([a-z0-9_]+)[\s\S]{0,120}?add\s+column\s+(?:if\s+not\s+exists\s+)?wedding_id\b/gi
  for (const m of sql.matchAll(addCol)) reasons.push(`adds ${m[1]}.wedding_id`)

  // CREATE TABLE x ( ... wedding_id ... )
  const createTable = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z0-9_]+)\s*\(([\s\S]*?)\n\)\s*;/gi
  for (const m of sql.matchAll(createTable)) {
    if (/^\s*wedding_id\b/im.test(m[2])) reasons.push(`creates ${m[1]} with a wedding_id column`)
  }

  // New unique key touching wedding_id changes the strategy, not just the list.
  const uniqIdx =
    /create\s+unique\s+index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?[a-z0-9_]+\s+on\s+(?:public\.)?([a-z0-9_]+)\s*\(([^)]*)\)/gi
  for (const m of sql.matchAll(uniqIdx)) {
    if (/\bwedding_id\b/i.test(m[2])) reasons.push(`adds a unique index on ${m[1]}(${m[2].trim()})`)
  }
  const uniqCon =
    /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?([a-z0-9_]+)[\s\S]{0,80}?add\s+constraint\s+[a-z0-9_]+\s+unique\s*\(([^)]*)\)/gi
  for (const m of sql.matchAll(uniqCon)) {
    if (/\bwedding_id\b/i.test(m[2])) reasons.push(`adds a unique constraint on ${m[1]}(${m[2].trim()})`)
  }

  if (reasons.length > 0) stale.push({ file, reasons })
}

// ---------------------------------------------------------------------------
// 2. Shape
// ---------------------------------------------------------------------------
const seen = new Set()
for (const t of tables) {
  const label = `${t.table}.${t.column}`
  if (seen.has(label)) problems.push(`${label} appears twice in the generated file`)
  seen.add(label)
  if (!KNOWN_STRATEGIES.has(t.strategy)) {
    problems.push(`${label} has unknown strategy '${t.strategy}'`)
  }
  if (!t.reason || String(t.reason).trim() === '') {
    problems.push(`${label} has no reason recorded`)
  }
  if (t.strategy === 'merge_one_per_wedding' && !t.pk) {
    problems.push(`${label} is one-per-wedding but has no primary key to move rows by`)
  }
}

// ---------------------------------------------------------------------------
// 3. Wiring
// ---------------------------------------------------------------------------
const resolver = readFileSync(RESOLVER, 'utf8')
if (!resolver.includes('wedding-fk-tables.generated.json')) {
  problems.push(`${RESOLVER} does not import the generated cascade file`)
}
const handList = [...resolver.matchAll(/await\s+reassign\(\s*['"][a-z0-9_]+['"]/gi)]
if (handList.length > 0) {
  problems.push(
    `${RESOLVER} still has ${handList.length} hand-written reassign('table') call(s); the list is generated now`,
  )
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log(`generated file: ${tables.length} wedding-keyed columns, watermark migration ${watermark}`)
console.log(`migrations newer than the watermark: ${newer.length}`)

let failed = false

if (stale.length > 0) {
  failed = true
  console.error('')
  console.error(`✗ STALE: ${stale.length} migration(s) newer than the watermark change the cascade:`)
  for (const s of stale) {
    console.error(`    ${s.file}`)
    for (const r of s.reasons) console.error(`        ${r}`)
  }
  console.error('')
  console.error('  Fix: npx tsx scripts/gen-wedding-fk-tables.ts   (then commit the file)')
}

if (problems.length > 0) {
  failed = true
  console.error('')
  console.error(`✗ ${problems.length} problem(s) in the generated file or its wiring:`)
  for (const p of problems) console.error(`    - ${p}`)
}

if (failed) process.exit(1)
console.log('✓ wedding cascade file is current and well-formed')
