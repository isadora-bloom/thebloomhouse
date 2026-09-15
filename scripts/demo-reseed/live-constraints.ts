/**
 * demo-reseed — live CHECK constraint reader. READ ONLY.
 *
 * W75. The class this closes: a CHECK constraint the migration-text
 * reader (`schema-facts.ts`) cannot see fails the seed at runtime, one
 * constraint at a time. The instance that showed it was migration 411,
 * which builds `CHECK (col IS NULL OR col ~ '^(META_ADS|...)_VENUE_...')`
 * inside a DO block via `format('... CHECK (%I IS NULL OR %I ~ %L) ...')`.
 * No text scanner sees a CHECK assembled by `format()`; the seven
 * `META_ADS_ACCESS_TOKEN` values in `seed-demo-venue-surfaces.sql` sailed
 * through `check:seed-sql` and died on `--apply` with 23514. Any future
 * CHECK written the same way, or in any other shape the scanner does not
 * parse, would do the same.
 *
 * So, when a database is to hand, ask it. `pg_constraint` holds every
 * CHECK exactly as Postgres will enforce it, and `pg_get_constraintdef`
 * deparses it to text this module can parse with the same
 * `parseCheckExpr` the migration reader uses. The live answer wins over
 * the migration-derived one wherever both exist.
 *
 * HOW IT READS
 * ------------
 * There is no DATABASE_URL and PostgREST does not expose pg_catalog. What
 * exists is `public.exec_sql` (migration 198), a service-role-only RPC
 * that runs one statement and returns `{ok, error, state}`, never rows.
 * So the read goes out as a DO block that SELECTs the whole answer into
 * one text variable and then deliberately raises with it, and the
 * answer comes back in the error message. Same probe trick as
 * `scripts/check-live-policies.mjs` `readScalar`. Nothing is written:
 * the block always aborts, and the only statement inside it is a
 * SELECT over the catalog.
 *
 * `fetch` is injectable so the tests never touch the network.
 */

import { readFileSync } from 'node:fs'
import { parseEnvFile } from '../../e2e/helpers/env'
import {
  parseCheckExpr,
  extractBalanced,
  setColumnAllowedValues,
  setColumnPattern,
  schemaFactsFromTables,
  type ParsedCheckExpr,
  type SchemaFacts,
  type TableFact,
} from './schema-facts'
import { posixEreToJs } from './posix-regex'

export interface LiveCheckConstraint {
  table: string
  /** The single column the constraint references, or `null` when it
   *  references several (or none): those are not per-column facts and
   *  the merge ignores them. */
  column: string | null
  name: string
  /** `pg_get_constraintdef(oid)` output, e.g.
   *  `CHECK (((col IS NULL) OR (col ~ '^X$'::text)))`. */
  definition: string
}

export interface LiveEnv {
  url: string
  serviceRoleKey: string
}

/** Same loader shape as the other operator scripts: a `KEY=value` file
 *  carrying NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and
 *  SUPABASE_SERVICE_ROLE_KEY. Throws when either is missing; the caller
 *  decides whether that is fatal. */
export function loadLiveEnv(envFilePath: string): LiveEnv {
  const values = parseEnvFile(readFileSync(envFilePath, 'utf8'))
  const url = values.NEXT_PUBLIC_SUPABASE_URL ?? values.SUPABASE_URL ?? ''
  const serviceRoleKey = values.SUPABASE_SERVICE_ROLE_KEY ?? ''
  if (!url || !serviceRoleKey) {
    throw new Error(
      `${envFilePath}: needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to read live constraints.`,
    )
  }
  return { url: url.replace(/\/+$/, ''), serviceRoleKey }
}

/** The marker the probe raises with. Kept distinct from
 *  check-live-policies' `CLPR:` so a log line says which script asked. */
export const PROBE_MARKER = 'CLPR:'

/** The catalog query, as a plpgsql probe. One SELECT, one RAISE. */
export const LIVE_CHECK_PROBE_SQL = `DO $probe$
DECLARE r text;
BEGIN
  SELECT coalesce(json_agg(json_build_object(
           'table', c.relname,
           'name', con.conname,
           'column', CASE WHEN array_length(con.conkey, 1) = 1 THEN a.attname END,
           'definition', pg_get_constraintdef(con.oid)
         ) ORDER BY c.relname, con.conname)::text, '[]')
    INTO r
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attribute a
      ON a.attrelid = con.conrelid
     AND array_length(con.conkey, 1) = 1
     AND a.attnum = con.conkey[1]
   WHERE con.contype = 'c'
     AND n.nspname = 'public';
  RAISE EXCEPTION '${PROBE_MARKER}%', r;
END $probe$;`

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Fetch every CHECK constraint on `public` tables. Read-only. */
export async function fetchLiveCheckConstraints(
  env: LiveEnv,
  fetchImpl: FetchLike = fetch,
): Promise<LiveCheckConstraint[]> {
  const res = await fetchImpl(`${env.url}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      apikey: env.serviceRoleKey,
      Authorization: `Bearer ${env.serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql: LIVE_CHECK_PROBE_SQL }),
  })
  if (!res.ok) {
    throw new Error(`live constraint probe: exec_sql answered HTTP ${res.status}`)
  }
  const body = (await res.json()) as { ok?: boolean; error?: string } | null
  if (!body || body.ok !== false || typeof body.error !== 'string') {
    throw new Error(
      'live constraint probe: exec_sql returned no probe payload (is migration 198 applied, ' +
        'and is the key the service role?)',
    )
  }
  const idx = body.error.indexOf(PROBE_MARKER)
  if (idx === -1) {
    throw new Error(`live constraint probe failed inside the database: ${body.error}`)
  }
  const payload = body.error.slice(idx + PROBE_MARKER.length)
  let rows: unknown
  try {
    rows = JSON.parse(payload)
  } catch {
    throw new Error(`live constraint probe: payload was not JSON (${payload.slice(0, 120)}...)`)
  }
  if (!Array.isArray(rows)) throw new Error('live constraint probe: payload was not an array')
  return rows.map((r) => {
    const row = r as Record<string, unknown>
    return {
      table: String(row.table),
      column: row.column == null ? null : String(row.column),
      name: String(row.name),
      definition: String(row.definition),
    }
  })
}

// ---------------------------------------------------------------------------
// Parsing a deparsed definition
// ---------------------------------------------------------------------------

export type ParsedLiveCheck =
  | { kind: 'values'; column: string; values: string[] }
  | { kind: 'pattern'; column: string; pattern: string; caseInsensitive: boolean; regex: RegExp }
  | { kind: 'untranslatable'; column: string; pattern: string; caseInsensitive: boolean; reason: string }
  | { kind: 'unrecognised' }

/** Parse one `pg_get_constraintdef` string. Strips the `CHECK (...)`
 *  wrapper and any trailing `NOT VALID`, then hands the expression to
 *  the shared `parseCheckExpr`. A regex that `posix-regex.ts` cannot
 *  map faithfully comes back `untranslatable` with the reason, so the
 *  caller can say so rather than guess. */
export function parseConstraintDefinition(definition: string): ParsedLiveCheck {
  const head = /^\s*CHECK\s*\(/i.exec(definition)
  if (!head) return { kind: 'unrecognised' }
  const bal = extractBalanced(definition, head[0].length - 1)
  if (!bal) return { kind: 'unrecognised' }
  const parsed: ParsedCheckExpr | null = parseCheckExpr(bal.inner)
  if (!parsed) return { kind: 'unrecognised' }
  if (parsed.values) return { kind: 'values', column: parsed.column, values: parsed.values }
  if (parsed.pattern !== null) {
    const t = posixEreToJs(parsed.pattern, parsed.patternCaseInsensitive)
    if (t.ok) {
      return {
        kind: 'pattern',
        column: parsed.column,
        pattern: parsed.pattern,
        caseInsensitive: parsed.patternCaseInsensitive,
        regex: t.regex,
      }
    }
    return {
      kind: 'untranslatable',
      column: parsed.column,
      pattern: parsed.pattern,
      caseInsensitive: parsed.patternCaseInsensitive,
      reason: t.reason,
    }
  }
  return { kind: 'unrecognised' }
}

// ---------------------------------------------------------------------------
// Merging over the migration-derived facts
// ---------------------------------------------------------------------------

export interface LiveMergeResult {
  facts: SchemaFacts
  /** Constraints read from the database. */
  read: number
  /** IN-list facts written. */
  valuesApplied: number
  /** Regex facts written. */
  patternsApplied: number
  /** Human-readable notes: untranslatable patterns, multi-column
   *  constraints skipped, column-name disagreements. Printed, not
   *  failed on. */
  notes: string[]
}

/**
 * Write the live constraints over `facts`. Live wins on conflict: a
 * column's `allowedValues` or `pattern` is replaced by what the database
 * holds. Facts the database has no opinion on (a column the migrations
 * constrain but the live table does not) are left as they were, on the
 * grounds that the migration reader's answer is still the safer one to
 * validate against than nothing.
 *
 * Tables the migration reader never saw are not created here: table
 * existence stays a migration-derived fact, and a constraint on an
 * unknown table has nothing to attach to.
 */
export function mergeLiveConstraints(facts: SchemaFacts, live: readonly LiveCheckConstraint[]): LiveMergeResult {
  const tables = facts.tables as Map<string, TableFact>
  const notes: string[] = []
  let valuesApplied = 0
  let patternsApplied = 0

  for (const con of live) {
    if (con.column === null) {
      // Multi-column (or expression-only) CHECK: not a per-column fact.
      continue
    }
    const t = tables.get(con.table.toLowerCase())
    if (!t) {
      notes.push(`${con.table}.${con.column} (${con.name}): table not known to the migration reader, skipped`)
      continue
    }
    const parsed = parseConstraintDefinition(con.definition)
    if (parsed.kind === 'unrecognised') continue
    if (parsed.column !== con.column) {
      notes.push(
        `${con.table} (${con.name}): definition names "${parsed.column}" but the catalog says ` +
          `"${con.column}", skipped`,
      )
      continue
    }
    if (parsed.kind === 'values') {
      setColumnAllowedValues(t, con.column, parsed.values)
      valuesApplied++
      continue
    }
    if (parsed.kind === 'untranslatable') {
      notes.push(
        `${con.table}.${con.column} (${con.name}): pattern ~ '${parsed.pattern}' not translated to JS ` +
          `(${parsed.reason}), NOT checked`,
      )
      continue
    }
    setColumnPattern(t, con.column, parsed.pattern, parsed.caseInsensitive, con.name)
    patternsApplied++
  }

  return { facts: schemaFactsFromTables(tables), read: live.length, valuesApplied, patternsApplied, notes }
}
