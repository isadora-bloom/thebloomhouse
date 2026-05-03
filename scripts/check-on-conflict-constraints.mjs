// T5-Rixey-RR fix #4: catch ON CONFLICT / unique-constraint mismatches at CI.
//
// Background: NN's bug #3 was a `.upsert({ ..., onConflict:
// 'venue_id,source,period_start' })` call against `source_attribution`
// where no matching unique index existed. Postgres silently no-ops the
// conflict path → every upsert reduced to an INSERT that then failed
// the implicit constraint, and the writer recorded "success" with zero
// rows actually committed. NN added migration 180 to create the index;
// this guard prevents the next instance of the same class.
//
// Strategy:
//   1. Walk src/**/*.ts(x) for `.upsert({` blocks; extract the
//      `onConflict: '<columns>'` value and the table name (`from('X')`).
//   2. Walk supabase/migrations/*.sql for unique indexes / unique
//      constraints; build a set of (table, sorted_column_set) tuples
//      that DO have a matching unique guarantee.
//   3. For each upsert, look up the sorted set of columns; fail if no
//      matching unique constraint exists.
//
// Allow a per-call override: `// onConflict-skip-check: <reason>` on
// the same line OR within 6 lines above.
//
// Partial unique indexes (CREATE UNIQUE INDEX ... WHERE ...) are
// surfaced as "match by column-set, warning only" since we can't
// statically verify the upsert query restricts to that subset.
//
// Run:   node scripts/check-on-conflict-constraints.mjs
// CI:    .github/workflows/ci.yml

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SCAN_DIRS = ['src']
const MIGRATION_DIR = 'supabase/migrations'

// ---------------------------------------------------------------------------
// File walk helpers
// ---------------------------------------------------------------------------

function walk(dir, predicate) {
  const out = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const full = join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) {
      out.push(...walk(full, predicate))
    } else if (predicate(full)) {
      out.push(full)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Migration scan: build (table → list-of-{columns, partial}) map.
// ---------------------------------------------------------------------------

/**
 * Parse migration SQL. We're tolerant of formatting variations because
 * the migrations directory is human-written:
 *   - CREATE UNIQUE INDEX [IF NOT EXISTS] name ON [schema.]table (col, col, ...)
 *     [WHERE clause]
 *   - ALTER TABLE table ADD CONSTRAINT name UNIQUE (col, col, ...)
 *   - CREATE TABLE: inline UNIQUE (col, col, ...) (table-level)
 *   - PRIMARY KEY (col, col, ...) (also enforces uniqueness)
 *
 * Returns: Map<table, Array<{ columns: Set<string>, partial: boolean }>>.
 */
function buildUniqueIndexMap() {
  const map = new Map()
  const files = walk(MIGRATION_DIR, (f) => f.endsWith('.sql'))
  for (const file of files) {
    const sql = readFileSync(file, 'utf8')
    // CREATE UNIQUE INDEX ... ON [schema.]table (col1, col2, ...) [WHERE ...]
    {
      const re = /CREATE\s+UNIQUE\s+INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+\S+\s+ON\s+(?:\w+\.)?(\w+)\s*\(([^)]+)\)([^;]*)/gi
      let m
      while ((m = re.exec(sql))) {
        const table = m[1].toLowerCase()
        const cols = parseColumnList(m[2])
        const partial = /\bWHERE\b/i.test(m[3] ?? '')
        addEntry(map, table, cols, partial)
      }
    }
    // ALTER TABLE table ADD CONSTRAINT name UNIQUE (col1, col2, ...)
    {
      const re = /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:\w+\.)?(\w+)\s+ADD\s+CONSTRAINT\s+\S+\s+UNIQUE\s*\(([^)]+)\)/gi
      let m
      while ((m = re.exec(sql))) {
        addEntry(map, m[1].toLowerCase(), parseColumnList(m[2]), false)
      }
    }
    // CREATE TABLE [IF NOT EXISTS] table (... UNIQUE (col, col, ...) ...)
    // — also catch primary key + inline column UNIQUE.
    {
      // Match the create-table opening through to the body-end. The body
      // can contain nested parens (REFERENCES x(y), CHECK (...) etc) so
      // we use a balanced-paren walker rather than a non-greedy regex.
      const openRe = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:\w+\.)?(\w+)\s*\(/gi
      let m
      while ((m = openRe.exec(sql))) {
        const table = m[1].toLowerCase()
        const startBody = openRe.lastIndex
        // Walk through `sql` starting at startBody, tracking paren depth.
        let depth = 1
        let i = startBody
        while (i < sql.length && depth > 0) {
          const c = sql[i]
          if (c === '(') depth++
          else if (c === ')') depth--
          i++
        }
        if (depth !== 0) continue
        const body = sql.slice(startBody, i - 1)
        // Split body on top-level commas (commas not inside parens).
        const segments = splitTopLevelCommas(body)
        for (const seg of segments) {
          const trimmed = seg.trim()
          // Table-level UNIQUE (...) / PRIMARY KEY (...)
          const tableLevel = trimmed.match(/^(?:UNIQUE|PRIMARY\s+KEY)\s*\(([^)]+)\)/i)
          if (tableLevel) {
            addEntry(map, table, parseColumnList(tableLevel[1]), false)
            continue
          }
          // Table-level CONSTRAINT name UNIQUE (...) / PRIMARY KEY (...)
          const constraintLevel = trimmed.match(/^CONSTRAINT\s+\S+\s+(?:UNIQUE|PRIMARY\s+KEY)\s*\(([^)]+)\)/i)
          if (constraintLevel) {
            addEntry(map, table, parseColumnList(constraintLevel[1]), false)
            continue
          }
          // Column definition with inline UNIQUE / PRIMARY KEY.
          // First token is the column name.
          const colMatch = trimmed.match(/^(\w+)\s+/)
          if (colMatch && /\b(UNIQUE|PRIMARY\s+KEY)\b/i.test(trimmed)) {
            addEntry(map, table, new Set([colMatch[1].toLowerCase()]), false)
          }
        }
      }
    }
  }
  return map
}

function splitTopLevelCommas(s) {
  const out = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i))
      start = i + 1
    }
  }
  out.push(s.slice(start))
  return out
}

function parseColumnList(s) {
  return new Set(
    s.split(',')
      .map((c) => c.trim().replace(/^"(.*)"$/, '$1').replace(/\s+(ASC|DESC)$/i, '').trim().toLowerCase())
      .filter(Boolean)
  )
}

function addEntry(map, table, columns, partial) {
  if (columns.size === 0) return
  if (!map.has(table)) map.set(table, [])
  map.get(table).push({ columns, partial })
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

// ---------------------------------------------------------------------------
// Source scan: find every `.upsert({ ...onConflict: '...' })` call site.
// ---------------------------------------------------------------------------

function findUpserts() {
  const files = walk(SCAN_DIRS[0], (f) => f.endsWith('.ts') || f.endsWith('.tsx'))
  const upserts = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    // Normalize CRLF — Windows checkouts have \r at end of every line, which
    // breaks `$`-anchored regexes below.
    const lines = text.split('\n').map((l) => l.replace(/\r$/, ''))
    // Find every '.upsert(' call. Then for each, scan forward up to 80
    // lines for an onConflict: 'a,b' string.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const upsertIdx = line.indexOf('.upsert(')
      if (upsertIdx < 0) continue
      // Walk back to find `from('table')` on the same chain. We allow up
      // to 30 lines back (chained query builders can span many lines).
      let table = null
      for (let b = i; b >= Math.max(0, i - 30); b--) {
        const prev = lines[b]
        const m = prev.match(/\.from\(['"]([a-z_]+)['"]\)/)
        if (m) { table = m[1]; break }
      }
      // Walk forward to find onConflict.
      let onConflict = null
      let onConflictLine = -1
      for (let f = i; f < Math.min(lines.length, i + 80); f++) {
        // Stop when the call clearly ends.
        const m = lines[f].match(/onConflict:\s*['"]([^'"]+)['"]/)
        if (m) { onConflict = m[1]; onConflictLine = f; break }
        if (f > i && /^\s*\.[a-zA-Z]/.test(lines[f])) {
          // hit a chained method like `.select(...)` — keep scanning;
          // onConflict can be in the upsert options object or in a
          // following `.select`-less options arg. Don't bail yet.
        }
      }
      if (!table || !onConflict) continue

      // Skip-check directive: same line as onConflict OR within 6 lines above.
      const start = Math.max(0, onConflictLine - 6)
      let skipReason = null
      for (let k = start; k <= onConflictLine; k++) {
        const dm = lines[k].match(/onConflict-skip-check:\s*(.+?)(?:\*\/|$)/)
        if (dm) { skipReason = dm[1].trim(); break }
      }

      const cols = parseColumnList(onConflict)
      upserts.push({
        file,
        line: onConflictLine + 1,
        table,
        onConflict,
        cols,
        skipReason,
      })
    }
  }
  return upserts
}

// ---------------------------------------------------------------------------
// Match: for each upsert, check that some unique index covers exactly
// the same column set on the same table.
// ---------------------------------------------------------------------------

function check() {
  const indexes = buildUniqueIndexMap()
  const upserts = findUpserts()

  const failures = []
  const warnings = []
  let skipped = 0
  let ok = 0

  for (const u of upserts) {
    if (u.skipReason) {
      skipped++
      continue
    }
    const tableIndexes = indexes.get(u.table) ?? []
    const exact = tableIndexes.find((idx) => !idx.partial && setsEqual(idx.columns, u.cols))
    if (exact) { ok++; continue }
    const partial = tableIndexes.find((idx) => idx.partial && setsEqual(idx.columns, u.cols))
    if (partial) {
      warnings.push({
        ...u,
        msg: `partial unique index match (WHERE clause not statically verified)`,
      })
      ok++
      continue
    }
    failures.push({
      ...u,
      candidates: tableIndexes.map((i) => `(${[...i.columns].sort().join(', ')})${i.partial ? ' [partial]' : ''}`),
    })
  }

  // Print summary
  console.log(`Scanned ${upserts.length} upsert call sites.`)
  console.log(`  ok:       ${ok}`)
  console.log(`  warn:     ${warnings.length}`)
  console.log(`  skip:     ${skipped}`)
  console.log(`  FAIL:     ${failures.length}`)
  console.log()

  for (const w of warnings) {
    console.log(`WARN  ${w.file}:${w.line}`)
    console.log(`      table=${w.table}  onConflict='${w.onConflict}'`)
    console.log(`      ${w.msg}`)
  }

  if (failures.length === 0) {
    console.log('OK — every onConflict has a matching unique constraint.')
    process.exit(0)
  }

  console.log()
  console.log('FAIL — onConflict columns have no matching unique constraint:')
  for (const f of failures) {
    console.log()
    console.log(`  ${f.file}:${f.line}`)
    console.log(`    table:           ${f.table}`)
    console.log(`    onConflict:      '${f.onConflict}'`)
    console.log(`    expected unique: (${[...f.cols].sort().join(', ')})`)
    if (f.candidates.length > 0) {
      console.log(`    table indexes:`)
      for (const c of f.candidates) console.log(`      - ${c}`)
    } else {
      console.log(`    table indexes:   <none found>`)
    }
    console.log(`    fix:`)
    console.log(`      EITHER add CREATE UNIQUE INDEX ... ON ${f.table} (${[...f.cols].sort().join(', ')})`)
    console.log(`      OR drop the .upsert() and use .insert() / explicit conflict handling.`)
    console.log(`      To override (rare): add comment // onConflict-skip-check: <reason>`)
    console.log(`      on the same line as onConflict or within 6 lines above.`)
  }

  process.exit(1)
}

check()
