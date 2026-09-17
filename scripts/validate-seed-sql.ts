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
 *   5. (W75) Every literal value written to a column carrying a regex
 *      CHECK (`col ~ 'pattern'`) matches it. NULL passes, as in rule 3.
 *      The pattern can come from the migration text (migrations 124 and
 *      140 write `col ~ '...'` in plain sight) or, with `--live
 *      <envfile>`, from the database itself: migration 411 builds its
 *      three `_token_env_key_shape` regex CHECKs inside `format()`, which
 *      no text scanner can see, and the seed died on one of them at
 *      `--apply` with 23514 on 2026-09-15. `demo-reseed/live-constraints.ts`
 *      reads `pg_constraint` and merges what it finds over the
 *      migration-derived facts, live winning on conflict. Without
 *      `--live` (CI, `npm run check:seed-sql`) the run stays offline and
 *      rule 5 only sees the migration-text patterns.
 *
 * In scope: `INSERT INTO <table> (<cols>) VALUES (...)` and (W75)
 * `INSERT INTO <table> (<cols>) SELECT <list> [FROM ...] [WHERE ...]`,
 * optionally `public.`-qualified, optionally carrying an `ON CONFLICT
 * ...` tail. W74 skipped the SELECT shape as out of scope; the seven
 * rows that failed 411's regex CHECK were all `SELECT ... WHERE NOT
 * EXISTS (...)`, so it is not. A statement whose schema prefix is not
 * `public` (`auth.users`) is skipped: this reader only knows the
 * public-schema shape the repo's own migrations declare.
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
import { posixEreToJs } from './demo-reseed/posix-regex'
import {
  loadLiveEnv,
  fetchLiveCheckConstraints,
  mergeLiveConstraints,
  type FetchLike,
} from './demo-reseed/live-constraints'

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

/** Keywords that end a SELECT's select list when met at paren depth 0. */
const SELECT_LIST_END_RE =
  /^(FROM|WHERE|ON\s+CONFLICT|RETURNING|GROUP\s+BY|ORDER\s+BY|LIMIT|OFFSET|UNION|EXCEPT|INTERSECT)\b/i

/**
 * W75. The seed files' idempotent idiom is `INSERT INTO t (cols) SELECT
 * 'a', 'b', now() WHERE NOT EXISTS (SELECT 1 FROM t WHERE ...)`: one
 * row, spelled as a select list rather than a VALUES tuple, and W74's
 * reader skipped every one of them. The seven `META_ADS_ACCESS_TOKEN`
 * writes that failed migration 411's regex CHECK at `--apply` were all
 * this shape, so the regex rule alone would still have missed them.
 *
 * Returns the select list split into one raw token per column, or
 * `null` when the statement is not a SELECT, uses `*`, or has no list.
 * A top-level `FROM` does not disqualify the statement: literals in the
 * list are still literal writes, and a column reference classifies as
 * 'other' and is never checked. The `WHERE NOT EXISTS (SELECT 1 FROM
 * ...)` guard sits inside parentheses, so the depth-0 scan never sees
 * its keywords.
 */
export function parseSelectListRow(afterCols: string): string[] | null {
  const selectMatch = /^\s*SELECT\s+(?:(?:DISTINCT|ALL)\s+)?/i.exec(afterCols)
  if (!selectMatch) return null
  const body = afterCols.slice(selectMatch[0].length)

  let end = body.length
  let depth = 0
  let inQuote = false
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!
    if (inQuote) {
      if (c === "'") {
        if (body[i + 1] === "'") {
          i++
          continue
        }
        inQuote = false
      }
      continue
    }
    if (c === "'") {
      inQuote = true
      continue
    }
    if (c === '(' || c === '[') {
      depth++
      continue
    }
    if (c === ')' || c === ']') {
      depth--
      continue
    }
    if (depth === 0 && /[A-Za-z]/.test(c) && (i === 0 || /[\s,)]/.test(body[i - 1]!))) {
      if (SELECT_LIST_END_RE.test(body.slice(i))) {
        end = i
        break
      }
    }
  }

  const list = body.slice(0, end).trim()
  if (!list) return null
  const tokens = topLevelSplit(list, ',')
  if (tokens.some((t) => t === '*' || /\.\*$/.test(t))) return null
  return tokens
}

/**
 * Parse every `INSERT INTO <table> (<cols>) VALUES (...)` statement in one
 * seed file's raw SQL. Statements of any other shape (`INSERT ... SELECT`,
 * `DELETE`, comment-only chunks) are counted for `statementIndex` purposes
 * but otherwise skipped — not an error, just out of scope for these four
 * rules.
 */
export function parseSeedInserts(file: string, sql: string): SeedInsert[] {
  const out: SeedInsert[] = []
  // W75: comments come off BEFORE the split, as schema-facts.ts does for
  // migrations. W74 split the raw text first, so an apostrophe in a
  // prose comment ("the venue's") opened a quote that never closed and
  // every statement after it collapsed into one chunk the INSERT parser
  // never matched. seed-demo-venue-surfaces.sql lost 23 of its inserts
  // that way, the seven bad token_env_key writes among them.
  const statements = splitOnSemicolons(stripLineComments(sql))
  statements.forEach((raw, i) => {
    const statementIndex = i + 1
    const clean = raw.trim()
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
    if (!valuesMatch) {
      // W75: `INSERT INTO t (cols) SELECT <list> [FROM ...] [WHERE NOT
      // EXISTS (...)]`. The select list maps to the column list by
      // position exactly as a VALUES tuple does, so its literals are
      // checkable; a column reference or subquery in the list is
      // 'other' and never checked, same as `now()` in a VALUES row.
      const selectRow = parseSelectListRow(afterCols)
      if (!selectRow) return
      out.push({ file, statementIndex, schema, table, columns, rows: [selectRow] })
      return
    }

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
  | 'pattern-violation'
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
  /** Rule 5: the regex source the value failed, as Postgres holds it. */
  pattern?: string
  /** Rule 5: the constraint name, when known. */
  constraint?: string | null
  requiredSince?: string
  message: string
}

/** Compile a column's regex CHECK once per (pattern, flags). An
 *  untranslatable pattern compiles to `null` and rule 5 skips it; the
 *  note for that is printed by `patternNotes`, not raised as a finding. */
const regexCache = new Map<string, RegExp | null>()
function compilePattern(pattern: string, caseInsensitive: boolean): RegExp | null {
  const key = `${caseInsensitive ? 'i' : ''}|${pattern}`
  const cached = regexCache.get(key)
  if (cached !== undefined) return cached
  const t = posixEreToJs(pattern, caseInsensitive)
  const re = t.ok ? t.regex : null
  regexCache.set(key, re)
  return re
}

/** One line per regex CHECK the facts carry that rule 5 cannot enforce,
 *  so a clean run never silently means "the pattern was skipped". */
export function patternNotes(facts: SchemaFacts): string[] {
  const out: string[] = []
  for (const [table, t] of facts.tables) {
    for (const [column, col] of t.columns) {
      if (col.pattern === null) continue
      const tr = posixEreToJs(col.pattern, col.patternCaseInsensitive)
      if (tr.ok) continue
      out.push(
        `${table}.${column}${col.patternConstraint ? ` (${col.patternConstraint})` : ''}: pattern ` +
          `~ '${col.pattern}' not translated to JS (${tr.reason}), NOT checked`,
      )
    }
  }
  return out
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

/**
 * The auth.users columns GoTrue scans into Go strings and jsonb it
 * unmarshals. They have no DEFAULT, so a hand-written INSERT that leaves
 * them out stores NULL, and GoTrue then fails every admin listing that
 * reaches the row: `auth.admin.listUsers` answered "Database error
 * finding users" past a page size of 10 on both projects (2026-09-15),
 * which broke findAuthUserByEmail and so every team invitation for an
 * existing address. Migration 414 repaired the rows; this rule stops a
 * seed putting them back. `auth.admin.createUser` sets all of them.
 */
export const AUTH_USER_REQUIRED_COLUMNS = [
  'confirmation_token',
  'recovery_token',
  'email_change',
  'email_change_token_new',
  'raw_app_meta_data',
  'raw_user_meta_data',
] as const

export function validateSeedInsert(insert: SeedInsert, facts: SchemaFacts): SeedFinding[] {
  const findings: SeedFinding[] = []
  const { file, statementIndex, table } = insert

  // auth.users is the one non-public table a seed writes, and the only
  // thing this reader can hold it to is the shape GoTrue needs.
  if (insert.schema === 'auth' && table === 'users') {
    for (const column of AUTH_USER_REQUIRED_COLUMNS) {
      if (insert.columns.includes(column)) continue
      findings.push({
        kind: 'missing-required-column',
        file,
        statementIndex,
        table: 'auth.users',
        column,
        message:
          `${file}:${statementIndex} INSERT INTO auth.users leaves ${column} NULL. GoTrue reads it ` +
          `as a non-null value and one such row breaks auth.admin.listUsers for every caller; ` +
          `set it ('' for the token columns, '{}' or the provider object for the jsonb ones).`,
      })
    }
    return findings
  }

  // Out of scope: any other non-public schema.
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

      // Rule 5 — regex CHECK. Independent of rule 3: a column can carry
      // both, and a value must satisfy both.
      if (colFact?.pattern !== null && colFact?.pattern !== undefined) {
        const re = compilePattern(colFact.pattern, colFact.patternCaseInsensitive)
        if (re && !re.test(value.value)) {
          const op = colFact.patternCaseInsensitive ? '~*' : '~'
          const conName = colFact.patternConstraint
          findings.push({
            kind: 'pattern-violation',
            file,
            statementIndex,
            table,
            column,
            value: value.value,
            pattern: colFact.pattern,
            constraint: conName,
            message:
              `${file}:${statementIndex} INSERT INTO ${table}: row ${rowIdx + 1} sets ` +
              `"${column}" = '${value.value}', which fails CHECK constraint ` +
              `${conName ?? '(inline)'}: ${column} ${op} '${colFact.pattern}'. This fails with 23514.`,
          })
        }
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

export interface SeedFactsLoad {
  facts: SchemaFacts
  /** Where the facts came from, for the header line. */
  source: 'migrations' | 'migrations+live'
  /** Live-merge counters, present only when an env file was given. */
  live: { url: string; read: number; valuesApplied: number; patternsApplied: number } | null
  /** Notes to print: untranslatable patterns and live-merge skips. */
  notes: string[]
}

/**
 * Read the migration-derived facts and, when `liveEnvFile` is given,
 * merge the database's own CHECK constraints over them (W75). A live
 * read that fails throws: a caller who asked for the live rule must not
 * get a silently offline answer, because "offline" is exactly the state
 * that let migration 411's constraint through.
 */
export async function loadSeedFacts(
  liveEnvFile: string | null,
  fetchImpl?: FetchLike,
): Promise<SeedFactsLoad> {
  const facts = readSchemaFacts()
  if (!liveEnvFile) {
    return { facts, source: 'migrations', live: null, notes: patternNotes(facts) }
  }
  const env = loadLiveEnv(liveEnvFile)
  const constraints = await fetchLiveCheckConstraints(env, fetchImpl)
  const merged = mergeLiveConstraints(facts, constraints)
  return {
    facts: merged.facts,
    source: 'migrations+live',
    live: {
      url: env.url,
      read: merged.read,
      valuesApplied: merged.valuesApplied,
      patternsApplied: merged.patternsApplied,
    },
    notes: [...merged.notes, ...patternNotes(merged.facts)],
  }
}

/** `--live <envfile>` from argv, or null for the offline (CI) run. */
export function parseLiveArg(argv: readonly string[]): string | null {
  const idx = argv.indexOf('--live')
  if (idx === -1) return null
  const file = argv[idx + 1]
  if (!file || file.startsWith('--')) throw new Error('--live needs an env file path')
  return file
}

async function main(): Promise<void> {
  const liveEnvFile = parseLiveArg(process.argv.slice(2))
  const loaded = await loadSeedFacts(liveEnvFile)
  const findings = validateFiles(SEED_SQL_FILES, loaded.facts)
  console.log('')
  console.log('check:seed-sql')
  console.log('==============')
  console.log(`  files checked: ${SEED_SQL_FILES.length}`)
  console.log(`  facts from   : ${loaded.source}`)
  if (loaded.live) {
    console.log(`  live source  : ${loaded.live.url}`)
    console.log(
      `  live CHECKs  : ${loaded.live.read} read, ${loaded.live.valuesApplied} IN-list + ` +
        `${loaded.live.patternsApplied} regex applied`,
    )
  }
  if (loaded.notes.length > 0) {
    console.log('  notes:')
    for (const n of loaded.notes) console.log(`    - ${n}`)
  }
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
