/**
 * demo-reseed — schema facts, read statically from `supabase/migrations/*.sql`.
 *
 * W72. The production incident this closes: the aux-rows generator wrote
 * `follow_up_sequence_templates` because migration 009 declares that
 * table, and nothing checked whether a LATER migration renamed it away.
 * Migration 040 does exactly that (`RENAME TO
 * _archived_follow_up_sequence_templates`), so the table has not existed
 * under its original name since. PostgREST answered "not in the schema
 * cache", which is a phantom-table error dressed up as a permissions
 * error, and it is a class of bug, not an instance: any generator that
 * trusts "a CREATE TABLE exists somewhere in migrations/" without asking
 * "and nothing later renamed or dropped it?" can make the same mistake
 * again on the next table.
 *
 * This module is a static reader, not a SQL parser. It understands
 * exactly the shapes this repo's migrations use:
 *
 *   - `CREATE TABLE (IF NOT EXISTS)? [public.]name (...)` — column defs,
 *     inline column-level `CHECK (...)`, and table-level `CHECK (...)` /
 *     `CONSTRAINT name CHECK (...)` entries in the column list.
 *   - `ALTER TABLE [ONLY] [public.]name <clause>[, <clause> ...]` where a
 *     clause is `ADD COLUMN (IF NOT EXISTS)? col type [CHECK (...)]`,
 *     `ADD CONSTRAINT name CHECK (...)`, `DROP CONSTRAINT (IF EXISTS)?
 *     name`, `DROP COLUMN (IF EXISTS)? col`, or `RENAME TO new_name`.
 *   - `DROP TABLE (IF EXISTS)? [public.]name (CASCADE)?`.
 *   - The DO-block guarded shape migration 243 uses (`DO $$ BEGIN IF NOT
 *     EXISTS (...) THEN ALTER TABLE ... ADD CONSTRAINT ... CHECK (...);
 *     END IF; END $$;`) — handled for free, because the scanner searches
 *     for `ALTER TABLE` / `CREATE TABLE` / `DROP TABLE` anywhere in a
 *     statement rather than requiring the statement to start with the
 *     keyword, so the `IF NOT EXISTS (...) THEN` guard text ahead of it is
 *     simply ignored.
 *
 * What "statement" means here: the file, with `--` comments stripped, is
 * split on `;` outside single-quoted strings. Nothing here protects
 * `$$ ... $$` dollar-quoted DO bodies from that split — deliberately. A DO
 * body's internal `ALTER TABLE ...;` still ends up as its own chunk (the
 * one semicolon after it is exactly where the real statement ends too),
 * and the plpgsql control-flow noise around it (`IF ... THEN`, `END IF;`,
 * `END $$;`) becomes small chunks with no ALTER/CREATE/DROP keyword in
 * them, which the scanner just ignores. Simpler than a real dollar-quote
 * tokenizer and, for the migrations actually in this repo, exactly as
 * correct.
 *
 * DROP CONSTRAINT resolves the column it names via the repo's own naming
 * convention: `<table>_<column>_check` (every named CHECK constraint in
 * this repo follows it — see migrations 243, 252, 297, 318). A DROP whose
 * name does not fit that shape, or whose column this module already
 * learned from the matching ADD CONSTRAINT, is resolved from that
 * knowledge instead. Either way the point is DROP CONSTRAINT + a later
 * re-ADD (297, 318) must leave the LATEST definition standing, not the
 * first one found.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface MigrationFile {
  name: string
  sql: string
}

export interface ColumnFact {
  /** True when some migration declares this column (CREATE TABLE column
   *  list or ADD COLUMN), regardless of whether it also carries a CHECK. */
  declared: boolean
  /** Allowed literal values from the latest CHECK constraint touching
   *  this column, in `col IN (...)` or `col IS NULL OR col IN (...)`
   *  shape. `null` means "no such CHECK known" — either genuinely
   *  unconstrained, or a CHECK exists in a shape this reader does not
   *  parse (a range, a regex, a cross-column comparison). A `null` here
   *  is therefore "cannot rule anything out", not "anything goes". */
  allowedValues: readonly string[] | null
  /** True when the column carries NOT NULL as the migrations leave it
   *  after every ALTER (CREATE TABLE inline, ADD COLUMN inline, or a
   *  later `ALTER COLUMN ... SET/DROP NOT NULL`). */
  notNull: boolean
  /** True when the column carries a DEFAULT as the migrations leave it
   *  after every ALTER (inline DEFAULT, or a later `ALTER COLUMN ...
   *  SET/DROP DEFAULT`). */
  hasDefault: boolean
  /** Name of the migration file whose ALTER (or the CREATE TABLE) most
   *  recently put this column into the "NOT NULL, no DEFAULT" state —
   *  i.e. the migration an insert that omits this column would need to
   *  cite as the cause of its NOT NULL violation. `null` when the
   *  column is not currently in that state. */
  requiredSinceMigration: string | null
}

export interface TableFact {
  /** True when some migration creates this table under this exact name,
   *  and no later migration drops it or renames it away. */
  exists: boolean
  columns: Map<string, ColumnFact>
}

export interface SchemaFacts {
  tables: ReadonlyMap<string, TableFact>
  tableExists(table: string): boolean
  columnDeclared(table: string, column: string): boolean
  allowedValues(table: string, column: string): readonly string[] | null
  /** True when the column is currently NOT NULL with no DEFAULT — an
   *  INSERT that does not supply it will fail with 23502. */
  columnRequired(table: string, column: string): boolean
  /** The migration file that put the column into the required state
   *  `columnRequired` reports, or `null` when it is not required (or the
   *  column is undeclared). */
  columnRequiredSince(table: string, column: string): string | null
}

// ---------------------------------------------------------------------------
// Small text-scanning primitives. All quote-aware; none paren-depth-aware
// beyond what `topLevelSplit` and `extractBalanced` need for their own job.
// ---------------------------------------------------------------------------

/** Strip `-- ...` line comments, respecting single-quoted strings (so a
 *  caption containing `--` cannot truncate a statement). */
export function stripLineComments(sql: string): string {
  let out = ''
  let inQuote = false
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!
    if (inQuote) {
      out += c
      if (c === "'") {
        if (sql[i + 1] === "'") {
          out += sql[++i]
          continue
        }
        inQuote = false
      }
      continue
    }
    if (c === "'") {
      inQuote = true
      out += c
      continue
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
      out += '\n'
      continue
    }
    out += c
  }
  return out
}

/** Split on `;` outside single-quoted strings. Does not special-case
 *  dollar-quoted DO bodies — see the file header for why that is fine
 *  here. */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!
    cur += c
    if (inQuote) {
      if (c === "'") {
        if (sql[i + 1] === "'") {
          cur += sql[++i]
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
    if (c === ';') {
      out.push(cur)
      cur = ''
    }
  }
  if (cur.trim()) out.push(cur)
  return out
}

/** Split on `sep` at paren/bracket-depth 0, outside single-quoted
 *  strings. Used for a CREATE TABLE column list, the comma-joined
 *  clauses of one ALTER TABLE statement, and (W74) a VALUES tuple —
 *  bracket depth matters there because a Postgres `ARRAY['a', 'b']`
 *  literal's commas must not be mistaken for tuple-value separators. No
 *  migration or seed file in this repo uses an unmatched `[`/`]`
 *  outside a string, so tracking bracket depth alongside paren depth is
 *  never wrong for the existing callers, only additionally correct for
 *  the new one. */
export function topLevelSplit(text: string, sep = ','): string[] {
  const out: string[] = []
  let cur = ''
  let depth = 0
  let inQuote = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (inQuote) {
      cur += c
      if (c === "'") {
        if (text[i + 1] === "'") {
          cur += text[++i]
          continue
        }
        inQuote = false
      }
      continue
    }
    if (c === "'") {
      inQuote = true
      cur += c
      continue
    }
    if (c === '(' || c === '[') {
      depth++
      cur += c
      continue
    }
    if (c === ')' || c === ']') {
      depth--
      cur += c
      continue
    }
    if (c === sep && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter((s) => s.length > 0)
}

/** Given the index of an opening `(`, return the text between it and its
 *  matching `)` (exclusive of both parens) plus the index just past the
 *  close. `null` when the parens never balance. */
export function extractBalanced(
  text: string,
  openIdx: number,
): { inner: string; end: number } | null {
  if (text[openIdx] !== '(') return null
  let depth = 0
  let inQuote = false
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i]!
    if (inQuote) {
      if (c === "'") {
        if (text[i + 1] === "'") {
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
    if (c === '(') {
      depth++
      continue
    }
    if (c === ')') {
      depth--
      if (depth === 0) return { inner: text.slice(openIdx + 1, i), end: i + 1 }
    }
  }
  return null
}

/** Unquote a SQL string literal (`'foo'` -> `foo`, `''` escape honoured).
 *  Returns the input unchanged when it is not a quoted literal — an enum
 *  value that is not a plain string is not a shape this reader expects,
 *  and passing it through unchanged is more honest than dropping it. */
function unquote(value: string): string {
  const m = /^'((?:[^']|'')*)'$/.exec(value)
  return m ? m[1].replace(/''/g, "'") : value
}

/** Parse a CHECK constraint expression of the shape this repo uses:
 *  `col IN (...)` or `col IS NULL OR col IN (...)`. Returns the column
 *  the CHECK is written against and its allowed values, or `null` when
 *  the expression is not an IN-list CHECK (a range check, a regex, a
 *  cross-column comparison — genuinely a different shape, not a bug to
 *  paper over). */
export function parseCheckExpr(expr: string): { column: string; values: string[] } | null {
  const colMatch = /^\s*"?(\w+)"?/.exec(expr)
  if (!colMatch) return null
  const inMatch = /\bIN\s*\(/i.exec(expr)
  if (!inMatch) return null
  const openIdx = inMatch.index + inMatch[0].length - 1
  const balanced = extractBalanced(expr, openIdx)
  if (!balanced) return null
  const values = topLevelSplit(balanced.inner, ',').map((v) => unquote(v.trim()))
  return { column: colMatch[1]!, values }
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

export function buildSchemaFacts(files: readonly MigrationFile[]): SchemaFacts {
  const tables = new Map<string, TableFact>()
  /** `${table}::${constraintName}` -> the column it was last known to
   *  constrain. Lets a later `DROP CONSTRAINT` find its column even when
   *  the name does not fit the `<table>_<col>_check` convention. */
  const constraintColumn = new Map<string, string>()

  const ensureTable = (name: string): TableFact => {
    let t = tables.get(name)
    if (!t) {
      t = { exists: false, columns: new Map() }
      tables.set(name, t)
    }
    return t
  }

  const blankColumn = (): ColumnFact => ({
    declared: true,
    allowedValues: null,
    notNull: false,
    hasDefault: false,
    requiredSinceMigration: null,
  })

  const setColumnDeclared = (table: string, column: string): void => {
    const t = ensureTable(table)
    const existing = t.columns.get(column)
    if (existing) existing.declared = true
    else t.columns.set(column, blankColumn())
  }

  const setColumnCheck = (table: string, column: string, values: string[] | null): void => {
    const t = ensureTable(table)
    const existing = t.columns.get(column)
    if (existing) existing.allowedValues = values
    else t.columns.set(column, { ...blankColumn(), allowedValues: values })
  }

  /** Recompute `requiredSinceMigration` from the column's current
   *  notNull/hasDefault state. Called after every change to either flag.
   *  A column becomes "required" the moment it is NOT NULL with no
   *  DEFAULT; it stops being required the moment either flag flips the
   *  other way, at which point the origin migration is forgotten (it is
   *  no longer the cause of anything). */
  const recomputeRequired = (table: string, column: string, migrationName: string): void => {
    const t = ensureTable(table)
    const col = t.columns.get(column)
    if (!col) return
    const nowRequired = col.notNull && !col.hasDefault
    if (nowRequired) {
      // Only stamp the migration name the moment the column transitions
      // INTO the required state, so re-processing an already-required
      // column (e.g. a second ADD COLUMN clause in the same statement)
      // does not overwrite the true origin with a later file.
      if (!col.requiredSinceMigration) col.requiredSinceMigration = migrationName
    } else {
      col.requiredSinceMigration = null
    }
  }

  const setColumnNotNull = (table: string, column: string, notNull: boolean, migrationName: string): void => {
    const t = ensureTable(table)
    const existing = t.columns.get(column)
    if (existing) existing.notNull = notNull
    else t.columns.set(column, { ...blankColumn(), notNull })
    recomputeRequired(table, column, migrationName)
  }

  const setColumnHasDefault = (table: string, column: string, hasDefault: boolean, migrationName: string): void => {
    const t = ensureTable(table)
    const existing = t.columns.get(column)
    if (existing) existing.hasDefault = hasDefault
    else t.columns.set(column, { ...blankColumn(), hasDefault })
    recomputeRequired(table, column, migrationName)
  }

  /** Scan a column definition fragment — everything after the column
   *  name, up to (but not including) any trailing CHECK — for `NOT
   *  NULL` and `DEFAULT`. Deliberately excludes the CHECK portion: a
   *  nullable-shape CHECK reads `col IS NULL OR col IN (...)`, and the
   *  substring "NOT NULL" never appears there, but a cross-column CHECK
   *  elsewhere in this repo could in principle contain "IS NOT NULL",
   *  which must not be mistaken for a column-level NOT NULL. */
  const detectNotNullAndDefault = (defText: string): { notNull: boolean; hasDefault: boolean } => {
    const checkIdx = defText.search(/\bCHECK\s*\(/i)
    const preCheck = checkIdx === -1 ? defText : defText.slice(0, checkIdx)
    return {
      notNull: /\bNOT\s+NULL\b/i.test(preCheck),
      hasDefault: /\bDEFAULT\b/i.test(preCheck),
    }
  }

  const renameTable = (from: string, to: string): void => {
    const src = tables.get(from)
    tables.set(from, { exists: false, columns: src?.columns ?? new Map() })
    const dst = tables.get(to)
    const merged = new Map(dst?.columns ?? [])
    if (src) for (const [k, v] of src.columns) merged.set(k, v)
    tables.set(to, { exists: true, columns: merged })
  }

  /** One entry of a CREATE TABLE's top-level-split column list: either a
   *  column definition, or a table-level CHECK/CONSTRAINT/PRIMARY
   *  KEY/UNIQUE/FOREIGN KEY entry. */
  const processColumnListSegment = (table: string, segment: string, migrationName: string): void => {
    const trimmed = segment.trim()
    if (!trimmed) return
    if (/^(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|EXCLUDE)\b/i.test(trimmed)) return

    const namedCheck = /^CONSTRAINT\s+"?(\w+)"?\s+CHECK\s*/i.exec(trimmed)
    if (namedCheck) {
      const openIdx = trimmed.indexOf('(', namedCheck[0]!.length)
      const bal = openIdx === -1 ? null : extractBalanced(trimmed, openIdx)
      const parsed = bal ? parseCheckExpr(bal.inner) : null
      if (parsed) {
        setColumnCheck(table, parsed.column, parsed.values)
        constraintColumn.set(`${table}::${namedCheck[1]}`, parsed.column)
      }
      return
    }

    if (/^CHECK\s*\(/i.test(trimmed)) {
      const openIdx = trimmed.indexOf('(')
      const bal = extractBalanced(trimmed, openIdx)
      const parsed = bal ? parseCheckExpr(bal.inner) : null
      if (parsed) setColumnCheck(table, parsed.column, parsed.values)
      return
    }

    const colMatch = /^"?(\w+)"?\s+/.exec(trimmed)
    if (!colMatch) return
    const column = colMatch[1]!
    setColumnDeclared(table, column)
    const rest = trimmed.slice(colMatch[0].length)
    // PRIMARY KEY inline on the column (e.g. `id uuid PRIMARY KEY`) is
    // NOT NULL by definition even though the words "NOT NULL" never
    // appear — most of this repo's PK columns also carry a DEFAULT
    // (gen_random_uuid()), so they are not flagged as required, but the
    // NOT NULL flag itself should still be accurate.
    const { notNull: explicitNotNull, hasDefault } = detectNotNullAndDefault(rest)
    const notNull = explicitNotNull || /\bPRIMARY\s+KEY\b/i.test(rest)
    setColumnNotNull(table, column, notNull, migrationName)
    setColumnHasDefault(table, column, hasDefault, migrationName)
    const checkIdx = rest.search(/\bCHECK\s*\(/i)
    if (checkIdx !== -1) {
      const openIdx = rest.indexOf('(', checkIdx)
      const bal = extractBalanced(rest, openIdx)
      const parsed = bal ? parseCheckExpr(bal.inner) : null
      if (parsed) setColumnCheck(table, parsed.column, parsed.values)
    }
  }

  const processAlterClause = (table: string, clause: string, migrationName: string): void => {
    const c = clause.trim()

    const rename = /^RENAME\s+TO\s+"?(\w+)"?/i.exec(c)
    if (rename) {
      renameTable(table, rename[1]!.toLowerCase())
      return
    }

    const alterColumnNotNull = /^ALTER\s+COLUMN\s+"?(\w+)"?\s+(SET|DROP)\s+NOT\s+NULL/i.exec(c)
    if (alterColumnNotNull) {
      setColumnNotNull(table, alterColumnNotNull[1]!, alterColumnNotNull[2]!.toUpperCase() === 'SET', migrationName)
      return
    }

    const alterColumnDefault = /^ALTER\s+COLUMN\s+"?(\w+)"?\s+SET\s+DEFAULT\b/i.exec(c)
    if (alterColumnDefault) {
      setColumnHasDefault(table, alterColumnDefault[1]!, true, migrationName)
      return
    }

    const alterColumnDropDefault = /^ALTER\s+COLUMN\s+"?(\w+)"?\s+DROP\s+DEFAULT\b/i.exec(c)
    if (alterColumnDropDefault) {
      setColumnHasDefault(table, alterColumnDropDefault[1]!, false, migrationName)
      return
    }

    const addColumn = /^ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?\s+([\s\S]*)$/i.exec(c)
    if (addColumn) {
      const column = addColumn[1]!
      setColumnDeclared(table, column)
      const rest = addColumn[2]!
      const { notNull, hasDefault } = detectNotNullAndDefault(rest)
      setColumnNotNull(table, column, notNull, migrationName)
      setColumnHasDefault(table, column, hasDefault, migrationName)
      const checkIdx = rest.search(/\bCHECK\s*\(/i)
      if (checkIdx !== -1) {
        const openIdx = rest.indexOf('(', checkIdx)
        const bal = extractBalanced(rest, openIdx)
        const parsed = bal ? parseCheckExpr(bal.inner) : null
        if (parsed) setColumnCheck(table, parsed.column, parsed.values)
      }
      return
    }

    const addConstraint = /^ADD\s+CONSTRAINT\s+"?(\w+)"?\s+CHECK\s*/i.exec(c)
    if (addConstraint) {
      const name = addConstraint[1]!
      const openIdx = c.indexOf('(', addConstraint[0]!.length)
      const bal = openIdx === -1 ? null : extractBalanced(c, openIdx)
      const parsed = bal ? parseCheckExpr(bal.inner) : null
      if (parsed) {
        setColumnCheck(table, parsed.column, parsed.values)
        constraintColumn.set(`${table}::${name}`, parsed.column)
      }
      return
    }

    const dropConstraint = /^DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/i.exec(c)
    if (dropConstraint) {
      const name = dropConstraint[1]!
      let column = constraintColumn.get(`${table}::${name}`) ?? null
      if (!column) {
        const prefix = `${table}_`
        const suffix = '_check'
        if (name.startsWith(prefix) && name.endsWith(suffix) && name.length > prefix.length + suffix.length) {
          column = name.slice(prefix.length, name.length - suffix.length)
        }
      }
      if (column) setColumnCheck(table, column, null)
      return
    }

    const dropColumn = /^DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/i.exec(c)
    if (dropColumn) {
      tables.get(table)?.columns.delete(dropColumn[1]!)
      return
    }

    // ENABLE/DISABLE ROW LEVEL SECURITY, ALTER COLUMN ... TYPE, OWNER TO,
    // and anything else this repo's migrations do in an ALTER TABLE
    // clause but that does not change table existence or column shape.
  }

  for (const file of files) {
    const sql = stripLineComments(file.sql)
    for (const stmt of splitStatements(sql)) {
      const dropIdx = stmt.search(/\bDROP\s+TABLE\b/i)
      if (dropIdx !== -1) {
        const m = /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?/i.exec(
          stmt.slice(dropIdx),
        )
        if (m) ensureTable(m[1]!.toLowerCase()).exists = false
        continue
      }

      const createIdx = stmt.search(/\bCREATE\s+TABLE\b/i)
      if (createIdx !== -1) {
        const tail = stmt.slice(createIdx)
        const head = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?\s*\(/i.exec(
          tail,
        )
        if (head) {
          const table = head[1]!.toLowerCase()
          const openIdx = createIdx + head.index + head[0].length - 1
          const bal = extractBalanced(stmt, openIdx)
          const t = ensureTable(table)
          t.exists = true
          if (bal) {
            for (const seg of topLevelSplit(bal.inner, ',')) processColumnListSegment(table, seg, file.name)
          }
        }
        continue
      }

      const alterIdx = stmt.search(/\bALTER\s+TABLE\b/i)
      if (alterIdx !== -1) {
        const tail = stmt.slice(alterIdx)
        const head =
          /\bALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?\s+([\s\S]*)$/i.exec(
            tail,
          )
        if (head) {
          const table = head[1]!.toLowerCase()
          for (const clause of topLevelSplit(head[2]!, ',')) processAlterClause(table, clause, file.name)
        }
        continue
      }
    }
  }

  return {
    tables,
    tableExists: (table) => tables.get(table.toLowerCase())?.exists === true,
    columnDeclared: (table, column) => tables.get(table.toLowerCase())?.columns.get(column)?.declared === true,
    allowedValues: (table, column) => tables.get(table.toLowerCase())?.columns.get(column)?.allowedValues ?? null,
    columnRequired: (table, column) =>
      tables.get(table.toLowerCase())?.columns.get(column)?.requiredSinceMigration != null,
    columnRequiredSince: (table, column) =>
      tables.get(table.toLowerCase())?.columns.get(column)?.requiredSinceMigration ?? null,
  }
}

// ---------------------------------------------------------------------------
// Reading the repo's real migrations
// ---------------------------------------------------------------------------

/** Migration filenames in this repo are `<digits>_description.sql`. Sort
 *  numerically on that prefix — a lexical sort would put migration 100
 *  before migration 25. */
export function sortMigrationFiles(names: readonly string[]): string[] {
  const withNum = names.map((name) => {
    const m = /^(\d+)_/.exec(name)
    return { name, num: m ? Number(m[1]) : Number.POSITIVE_INFINITY }
  })
  withNum.sort((a, b) => (a.num !== b.num ? a.num - b.num : a.name.localeCompare(b.name)))
  return withNum.map((w) => w.name)
}

export function readSchemaFacts(migrationsDir = join('supabase', 'migrations')): SchemaFacts {
  const names = sortMigrationFiles(readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')))
  const files: MigrationFile[] = names.map((name) => ({
    name,
    sql: readFileSync(join(migrationsDir, name), 'utf8'),
  }))
  return buildSchemaFacts(files)
}
