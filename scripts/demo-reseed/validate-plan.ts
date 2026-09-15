/**
 * demo-reseed — validate a generated plan against what the migrations
 * actually declare, before anything is written.
 *
 * W72. The 2026-09-15 production run wrote the spine correctly (VERIFY
 * PASS) and then the aux step threw 13 errors in three classes: a table
 * that migration 040 renamed away, a value outside a CHECK set on
 * `anomaly_alerts`, and another on `brand_assets`. All three are the same
 * root problem — the generator in `mirror-rows.ts` describes tables and
 * values by hand, and nothing checked the description against the
 * migrations before the plan reached `--apply`. This module is that
 * check, run over the whole plan rather than the three tables that
 * happened to fail first.
 *
 * Static half: every `aux_rows` step's table must exist (created by some
 * migration, not later dropped or renamed away — see `schema-facts.ts`),
 * every column a row writes must be declared, and every value written to
 * a column with a CHECK-derived allowed set must be in that set. The
 * delete list gets the same table-existence check, because a delete
 * against a phantom table fails exactly the same way an insert does — it
 * is the same class of bug wearing a different verb.
 *
 * Live half (opt-in, `confirmTablesLive`): the static check answers "do
 * the migrations, read as a whole, still declare this table" — it cannot
 * answer "and did that migration actually run against THIS database".
 * Migration 383 tries to enable RLS on `follow_up_sequence_templates`
 * with no existence guard at all, which only makes sense if migration 040
 * had not renamed the table away by the time 383 ran on production, or if
 * 383 partially failed there — either way, static analysis of the
 * migration files cannot tell us what production's schema cache actually
 * holds today. `confirmTablesLive` asks the database directly with a
 * `select('*').limit(0)`: zero rows, no writes, and PostgREST answers with
 * an error (not in the schema cache) precisely when the table is a
 * phantom on that environment specifically.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { SchemaFacts } from './schema-facts'
import type { ReseedPlan } from './types'

export type ValidationFindingKind = 'missing-table' | 'undeclared-column' | 'check-violation'

export interface ValidationFinding {
  kind: ValidationFindingKind
  table: string
  column?: string
  storyKey?: string
  message: string
}

export interface ValidationResult {
  pass: boolean
  findings: ValidationFinding[]
}

/** A `<wedding:key>` or `<couple:key>` placeholder, substituted for a real
 *  id at apply time (see `apply.ts`'s `substituteRefs`). Never a value to
 *  hold against a CHECK set — it is a foreign key, not an enum. */
const REF_PLACEHOLDER_RE = /^<(?:wedding|couple):.+>$/

function dedupe(findings: ValidationFinding[]): ValidationFinding[] {
  const seen = new Set<string>()
  const out: ValidationFinding[] = []
  for (const f of findings) {
    const key = `${f.kind}|${f.table}|${f.column ?? ''}|${f.message}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }
  return out
}

/**
 * Validate every delete target and every `aux_rows` step in a plan.
 *
 * Pure — takes the `SchemaFacts` the caller already built, reads nothing
 * else, writes nothing. Safe to run on every dry run and inside the
 * determinism test.
 */
export function validatePlan(plan: ReseedPlan, facts: SchemaFacts): ValidationResult {
  const findings: ValidationFinding[] = []

  const requireTable = (table: string, context: string, storyKey?: string): boolean => {
    if (facts.tableExists(table)) return true
    findings.push({
      kind: 'missing-table',
      table,
      storyKey,
      message:
        `${context}: table "${table}" is not created by the migrations, or a later ` +
        `migration drops or renames it away. Writing (or deleting from) it will fail ` +
        `on a real database with "not in the schema cache".`,
    })
    return false
  }

  for (const del of plan.deletes) {
    requireTable(del.table, 'delete')
  }

  for (const step of plan.steps) {
    if (step.kind !== 'aux_rows') continue
    const table = step.table ?? ''
    if (!table) continue
    if (!requireTable(table, 'aux_rows', step.storyKey)) continue

    for (const row of step.rows ?? []) {
      for (const [column, value] of Object.entries(row)) {
        if (!facts.columnDeclared(table, column)) {
          findings.push({
            kind: 'undeclared-column',
            table,
            column,
            storyKey: step.storyKey,
            message:
              `aux_rows ${table}.${column} (story ${step.storyKey}): no migration declares ` +
              `this column on ${table}.`,
          })
          continue
        }
        if (typeof value !== 'string' || REF_PLACEHOLDER_RE.test(value)) continue
        const allowed = facts.allowedValues(table, column)
        if (allowed && !allowed.includes(value)) {
          findings.push({
            kind: 'check-violation',
            table,
            column,
            storyKey: step.storyKey,
            message:
              `aux_rows ${table}.${column} = '${value}' (story ${step.storyKey}) is outside ` +
              `the CHECK set: ${allowed.join(', ')}`,
          })
        }
      }
    }
  }

  return { pass: findings.length === 0, findings: dedupe(findings) }
}

export function formatValidationReport(result: ValidationResult): string {
  if (result.pass) return 'VALIDATION PASS'
  const lines = [`VALIDATION FAIL — ${result.findings.length} finding(s)`]
  for (const f of result.findings) lines.push(`  - ${f.message}`)
  return lines.join('\n')
}

/** Every table name the plan touches, delete or aux insert, deduplicated.
 *  What `--live` needs to probe. */
export function tablesInPlan(plan: ReseedPlan): string[] {
  const out = new Set<string>()
  for (const del of plan.deletes) out.add(del.table)
  for (const step of plan.steps) {
    if (step.kind === 'aux_rows' && step.table) out.add(step.table)
  }
  return [...out]
}

export interface LiveTableCheck {
  table: string
  /** True when the table is declared by the migrations (or the caller
   *  did not know that and skipped the static check) but the live
   *  database has no such relation — the exact shape of the incident
   *  this module exists to catch before it reaches `--apply`. */
  phantom: boolean
  error: string | null
}

/**
 * Ask the live database, table by table, "does this exist". Read-only:
 * `select('*').limit(0)` returns zero rows and performs no write. Safe to
 * run against production.
 */
export async function confirmTablesLive(
  supabase: SupabaseClient,
  tables: readonly string[],
): Promise<LiveTableCheck[]> {
  const unique = [...new Set(tables)]
  const out: LiveTableCheck[] = []
  for (const table of unique) {
    const { error } = await supabase.from(table).select('*').limit(0)
    out.push({ table, phantom: Boolean(error), error: error ? error.message : null })
  }
  return out
}

export function formatLiveReport(checks: readonly LiveTableCheck[]): string {
  const phantoms = checks.filter((c) => c.phantom)
  if (phantoms.length === 0) {
    return `LIVE CHECK PASS — ${checks.length} table(s) confirmed on the target database.`
  }
  const lines = [`LIVE CHECK FAIL — ${phantoms.length} phantom table(s) of ${checks.length}:`]
  for (const p of phantoms) lines.push(`  - ${p.table}: ${p.error ?? 'unknown error'}`)
  return lines.join('\n')
}
