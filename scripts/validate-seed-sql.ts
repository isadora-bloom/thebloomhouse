#!/usr/bin/env tsx
/**
 * W74. Validates the hand-written seed SQL against the same schema facts
 * W72's `demo-reseed/validate-plan.ts` already holds `scripts/e2e-seed.ts`'s
 * generated rows to.
 *
 * The production incident this closes: `scripts/e2e-seed.ts --apply` died
 * on its FIRST statement on the test branch because `supabase/seed.sql`
 * inserted `venues.plan_tier = 'intelligence'`, a value migration 215
 * retired in favour of a 5-tier vocabulary. Production never noticed
 * because those rows predate the constraint — a fresh test branch runs
 * every migration in order and finds out immediately. A second run turned
 * up `interactions.signal_class` missing entirely: migration 192 made the
 * column NOT NULL with no DEFAULT, and the seed row simply never declares
 * it, so Postgres refuses with 23502 before the CHECK on its value is
 * even reached.
 *
 * Both are the same root problem `demo-reseed/schema-facts.ts` already
 * fixed for the generated reseed rows: something describes a table's
 * shape by hand (here, seed SQL written years apart across many streams)
 * and nothing checks the description against what the migrations, read
 * as a whole, actually say today. This module is that check for the
 * seed files, not the reseed plan.
 *
 * Four rules, run per `INSERT INTO <table> (<cols>) VALUES (...)`:
 *
 *   1. The table exists (created by some migration, not later dropped or
 *      renamed away).
 *   2. Every column in the insert's column list is declared by some
 *      migration on that table.
 *   3. Every value written to a CHECK-constrained column is in the
 *      latest allowed set — literal SQL NULL is exempt, because Postgres
 *      CHECK constraints pass (not fail) on NULL by three-valued logic,
 *      regardless of whether the migration spelled the CHECK as `col IN
 *      (...)` or the more explicit `col IS NULL OR col IN (...)`.
 *   4. Every column that is NOT NULL with no DEFAULT, as the migrations
 *      leave it after every ALTER, is present in the insert's column
 *      list. A bonus half of the same rule: if such a column IS present
 *      but the row's value is a literal NULL, that is the identical
 *      23502 violation wearing a different shape, so it is reported
 *      too.
 *
 * Only `INSERT INTO <table> (<cols>) VALUES (...)` statements are in
 * scope, optionally `public.`-qualified, optionally carrying an `ON
 * CONFLICT ...` tail. `INSERT ... SELECT` (the `auth.users` rows in
 * these files use `SELECT ... WHERE NOT EXISTS (...)`, not VALUES) is
 * silently out of scope — it is not the shape migration 215 or 192
 * broke, and `auth.users` is not a table any migration in
 * `supabase/migrations/` declares in the first place. A statement whose
 * schema prefix is not `public` (again, `auth.*`) is skipped for the
 * same reason: this reader only knows the public-schema shape the repo's
 * own migrations declare.
 *
 * Not a general SQL parser — see `demo-reseed/schema-facts.ts` for the
 * same disclaimer about the migrations reader this module is built on.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  readSchemaFacts,
  stripLineComments,
  splitStatements as splitOnSemicolons,
  topLevelSplit,
  extractBalanced,
  type SchemaFacts,
} from './demo-reseed/schema-facts'

// ---------------------------------------------------------------------------
// The seed files scripts/e2e-seed.ts composes.
//
// Kept as a literal list rather than imported from e2e-seed.ts: that
// module calls its own `main()` unconditionally at the bottom (dry-run
// safe, but still a live run of the seeding plan-printer), so importing
// it just for the constant would run it. Extend both lists together —
// e2e-seed.ts's DEMO_SQL_FILES + DEMO_SQL_FILES_SUPERSEDED — when either
// changes.
// ---------------------------------------------------------------------------
export const SEED_SQL_FILES: readonly string[] = [
  'supabase/seed.sql',
  'supabase/seed-demo-rich.sql',
  'supabase/seed-marketing-spend-records.sql',
  'supabase/seed-contracts-demo.sql',
  'supabase/seed-ad-connections-demo.sql',
  'supabase/seed-reviews.sql',
  'supabase/seed-demo-venue-surfaces.sql',
  // Superseded (not applied by e2e-seed.ts — see its
  // DEMO_SQL_FILES_SUPERSEDED comment) but still shipped in the repo for
  // anyone running against a database with the old seed on it, so it
  // still needs to be valid SQL against the current schema.
  'supabase/seed-commitments-demo.sql',
]

// ---------------------------------------------------------------------------
// Parsing: INSERT INTO <table> (<cols>) VALUES (...), (...) [ON CONFLICT ...]
// ---------------------------------------------------------------------------

export interface SeedInsert {
  file: string
  /** 1-based position of this statement among every top-level statement
   *  in the file (as `splitStatements` returns them) — every statement
   *  counts, not just the ones that parse as a VALUES-insert, so the
   *  number a finding cites is the one a human would land on counting
   *  `;`-terminated statements down the file. */
  statementIndex: number
  /** Schema prefix if the statement qualified one (lowercased), else
   *  null. Only `null` and `'public'` are validated; anything else
   *  (`auth.users`) is out of scope — see the module header. */
  schema: string | null
  /** Table name, lowercased, unqualified. */
  table: string
  columns: string[]
  /** One entry per VALUES tuple; each entry is the tuple's raw value
   *  tokens (still SQL text — `'foo'`, `NULL`, `42`, `now()`, `'{}'::jsonb`
   *  — unparsed beyond top-level comma splitting). */
  rows: string[][]
}

/** Strip the outer quotes from a possibly-quoted SQL identifier. */
function unquoteIdent(ident: string): string {
  const m = /^"(.*)"$/.exec(ident.trim())
  return (m ? m[1] : ident.trim()).toLowerCase()
}

const INSERT_INTO_RE =
  /^INSERT\s+INTO\s+((?:"?[A-Za-z_][A-Za-z0-9_]*"?\.)?"?[A-Za-z_][A-Za-z0-9_]*"?)\s*\(/i

/**
 * Parse every `INSERT INTO <table> (<cols>) VALUES (...)` statement in one
 * seed file's raw SQL. Statements of any other shape (`INSERT ... SELECT`,
 * `DELETE`, comment-only chunks) are counted for `statementIndex` purposes
 * but otherwise skipped — not an error, just out of scope for these four
 * rules.
 */
export function parseSeedInserts(file: string, sql: string): SeedInsert[] {
  const out: SeedInsert[] = []
  const statements = splitOnSemicolons(sql)
  statements.forEach((raw, i) => {
    const statementIndex = i + 1
    const clean = stripLineComments(raw).trim()
    const head = INSERT_INTO_RE.exec(clean)
    if (!head) return

    const rawName = head[1]!
    const dotIdx = rawName.indexOf('.')
    const schema = dotIdx === -1 ? null : unquoteIdent(rawName.slice(0, dotIdx))
    const table = unquoteIdent(dotIdx === -1 ? rawName : rawName.slice(dotIdx + 1))

    const openIdx = head.index + head[0].length - 1 // position of the '(' the regex consumed
    const colsBal = extractBalanced(clean, openIdx)
    if (!colsBal) return
    const columns = topLevelSplit(colsBal.inner, ',').map(unquoteIdent)

    const afterCols = clean.slice(colsBal.end)
    const valuesMatch = /^\s*VALUES\s*/i.exec(afterCols)
    if (!valuesMatch) return // INSERT ... SELECT, or some other non-VALUES shape

    const rows: string[][] = []
    let pos = valuesMatch[0].length
    for (;;) {
      while (pos < afterCols.length && /\s/.test(afterCols[pos]!)) pos++
      if (afterCols[pos] !== '(') break
      const tupleBal = extractBalanced(afterCols, pos)
      if (!tupleBal) break
      rows.push(topLevelSplit(tupleBal.inner, ','))
      pos = tupleBal.end
      while (pos < afterCols.length && /\s/.test(afterCols[pos]!)) pos++
      if (afterCols[pos] === ',') {
        pos++
        continue
      }
      break
    }

    out.push({ file, statementIndex, schema, table, columns, rows })
  })
  return out
}

// ---------------------------------------------------------------------------
// Value classification
// ---------------------------------------------------------------------------

export type SeedValue =
  | { kind: 'null' }
  | { kind: 'string'; value: string }
  | { kind: 'other'; raw: string }

/** Classify one raw VALUES token. A quoted string is unquoted (`''`
 *  escape honoured) whether or not it carries a trailing `::type` cast —
 *  `'unclassified'::text` and `'unclassified'` read the same value.
 *  Anything else (a number, `NULL`, `now()`, a bare identifier such as a
 *  parameter) is `'other'` and is never checked against a CHECK set,
 *  matching `demo-reseed/validate-plan.ts`'s "only string values are
 *  checkable" rule. */
export function classifySeedValue(raw: string): SeedValue {
  const t = raw.trim()
  if (/^NULL$/i.test(t)) return { kind: 'null' }
  const m = /^'((?:[^']|'')*)'/.exec(t)
  if (m) {
    const tail = t.slice(m[0].length).trim()
    if (tail === '' || tail.startsWith('::')) {
      return { kind: 'string', value: m[1]!.replace(/''/g, "'") }
    }
  }
  return { kind: 'other', raw: t }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type SeedFindingKind =
  | 'missing-table'
  | 'undeclared-column'
  | 'check-violation'
  | 'missing-required-column'
  | 'null-in-required-column'
  | 'row-shape-mismatch'

export interface SeedFinding {
  kind: SeedFindingKind
  file: string
  statementIndex: number
  table: string
  column?: string
  value?: string
  allowed?: readonly string[]
  requiredSince?: string
  message: string
}

function dedupe(findings: SeedFinding[]): SeedFinding[] {
  const seen = new Set<string>()
  const out: SeedFinding[] = []
  for (const f of findings) {
    const key = `${f.kind}|${f.file}|${f.statementIndex}|${f.table}|${f.column ?? ''}|${f.value ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }
  return out
}

export function validateSeedInsert(insert: SeedInsert, facts: SchemaFacts): SeedFinding[] {
  const findings: SeedFinding[] = []
  const { file, statementIndex, table } = insert

  // Out of scope: not the public schema this reader knows (auth.users et al).
  if (insert.schema && insert.schema !== 'public') return findings

  if (!facts.tableExists(table)) {
    findings.push({
      kind: 'missing-table',
      file,
      statementIndex,
      table,
      message:
        `${file}:${statementIndex} INSERT INTO ${table}: no migration creates this table, ` +
        `or a later migration drops or renames it away.`,
    })
    return findings // nothing else here is meaningful against a phantom table
  }

  for (const column of insert.columns) {
    if (!facts.columnDeclared(table, column)) {
      findings.push({
        kind: 'undeclared-column',
        file,
        statementIndex,
        table,
        column,
        message:
          `${file}:${statementIndex} INSERT INTO ${table}.${column}: no migration declares ` +
          `this column on ${table}.`,
      })
    }
  }

  // Rule 4 — every currently-required column must be in the column list.
  // Once per statement: a missing column is missing for every row alike.
  const tableFact = facts.tables.get(table)
  if (tableFact) {
    for (const [column, colFact] of tableFact.columns) {
      if (!colFact.requiredSinceMigration) continue
      if (insert.columns.includes(column)) continue
      findings.push({
        kind: 'missing-required-column',
        file,
        statementIndex,
        table,
        column,
        requiredSince: colFact.requiredSinceMigration,
        message:
          `${file}:${statementIndex} INSERT INTO ${table}: column "${column}" is NOT NULL with ` +
          `no DEFAULT (migration ${colFact.requiredSinceMigration}) but is missing from the ` +
          `column list — this fails with 23502.`,
      })
    }
  }

  insert.rows.forEach((row, rowIdx) => {
    if (row.length !== insert.columns.length) {
      findings.push({
        kind: 'row-shape-mismatch',
        file,
        statementIndex,
        table,
        message:
          `${file}:${statementIndex} INSERT INTO ${table}: row ${rowIdx + 1} has ${row.length} ` +
          `value(s) for ${insert.columns.length} column(s).`,
      })
      return
    }
    insert.columns.forEach((column, colIdx) => {
      const value = classifySeedValue(row[colIdx]!)
      const colFact = tableFact?.columns.get(column)

      if (value.kind === 'null') {
        // Postgres CHECK constraints pass on NULL by three-valued logic —
        // never a check-violation. NOT NULL is a different constraint,
        // and this IS the same 23502 class rule 4 catches by omission.
        if (colFact?.notNull) {
          findings.push({
            kind: 'null-in-required-column',
            file,
            statementIndex,
            table,
            column,
            message:
              `${file}:${statementIndex} INSERT INTO ${table}: row ${rowIdx + 1} sets ` +
              `"${column}" = NULL, but the column is NOT NULL — this fails with 23502.`,
          })
        }
        return
      }
      if (value.kind !== 'string') return

      const allowed = facts.allowedValues(table, column)
      if (allowed && !allowed.includes(value.value)) {
        findings.push({
          kind: 'check-violation',
          file,
          statementIndex,
          table,
          column,
          value: value.value,
          allowed,
          message:
            `${file}:${statementIndex} INSERT INTO ${table}: row ${rowIdx + 1} sets ` +
            `"${column}" = '${value.value}', outside the CHECK set: ${allowed.join(', ')}`,
        })
      }
    })
  })

  return findings
}

export function validateSeedSql(file: string, sql: string, facts: SchemaFacts): SeedFinding[] {
  const inserts = parseSeedInserts(file, sql)
  return dedupe(inserts.flatMap((ins) => validateSeedInsert(ins, facts)))
}

export function formatFindings(findings: readonly SeedFinding[]): string {
  if (findings.length === 0) return 'VALIDATION PASS — every seed INSERT matches the migrations.'
  const lines = [`VALIDATION FAIL — ${findings.length} finding(s)`]
  for (const f of findings) lines.push(`  - [${f.kind}] ${f.message}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function validateFiles(files: readonly string[], facts: SchemaFacts): SeedFinding[] {
  const all: SeedFinding[] = []
  for (const file of files) {
    const sql = readFileSync(resolve(process.cwd(), file), 'utf8')
    all.push(...validateSeedSql(file, sql, facts))
  }
  return all
}

async function main(): Promise<void> {
  const facts = readSchemaFacts()
  const findings = validateFiles(SEED_SQL_FILES, facts)
  console.log('')
  console.log('check:seed-sql')
  console.log('==============')
  console.log(`  files checked: ${SEED_SQL_FILES.length}`)
  console.log('')
  console.log(formatFindings(findings))
  console.log('')
  if (findings.length > 0) process.exitCode = 1
}

const isMain = (() => {
  if (!process.argv[1]) return false
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1])
  } catch {
    return false
  }
})()

if (isMain) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.stack ?? e.message : e)
    process.exit(1)
  })
}
