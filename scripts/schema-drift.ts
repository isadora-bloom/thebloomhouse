#!/usr/bin/env tsx
/**
 * schema-drift.ts: what the live database is missing, derived from the
 * migrations themselves rather than a hand-kept "pending" list.
 *
 *   npx tsx scripts/schema-drift.ts                      production (.env.local)
 *   npx tsx scripts/schema-drift.ts --env .env.test      the E2E project
 *   npx tsx scripts/schema-drift.ts --env .env.test --json
 *
 * Why this exists (2026-09-15): the E2E project had every migration in
 * `apply-pending-migrations.ts`'s list, yet was 17 tables and 40 columns
 * behind production. That list is curated by hand against production's
 * history; a project with a different history falls through the gaps
 * (291, 304-310, 373, 376, 377, 389, 391 were never on it). The seed
 * then failed one missing relation at a time.
 *
 * How: `readSchemaFacts` folds every migration into the tables and
 * columns they leave behind, each stamped with the migration that
 * introduced it. PostgREST's OpenAPI root lists what the live project
 * exposes. The difference, grouped by migration, is the ordered list to
 * apply. Read-only: one GET, nothing written.
 *
 * Exit 1 when anything is missing, so it can gate a deploy.
 */

import { readFileSync } from 'node:fs'
import { readSchemaFacts, sortMigrationFiles } from './demo-reseed/schema-facts'

const argv = process.argv.slice(2)
const envIdx = argv.indexOf('--env')
const ENV_PATH = envIdx >= 0 ? argv[envIdx + 1]! : '.env.local'
const JSON_OUT = argv.includes('--json')

function loadEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const i = line.indexOf('=')
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
  return out
}

export interface DriftReport {
  project: string
  missingTables: Array<{ table: string; migration: string | null }>
  missingColumns: Array<{ table: string; column: string; migration: string | null }>
  /** Migration files to apply, in numeric order, deduplicated. */
  migrationsToApply: string[]
  /** Live relations no migration creates (views, hand-made tables). Informational. */
  unexplained: string[]
}

export function computeDrift(
  facts: ReturnType<typeof readSchemaFacts>,
  live: ReadonlyMap<string, ReadonlySet<string>>,
  project: string,
): DriftReport {
  const missingTables: DriftReport['missingTables'] = []
  const missingColumns: DriftReport['missingColumns'] = []
  const needed = new Set<string>()

  for (const [table, fact] of facts.tables) {
    if (!fact.exists) continue
    const liveCols = live.get(table)
    if (!liveCols) {
      missingTables.push({ table, migration: fact.createdIn })
      if (fact.createdIn) needed.add(fact.createdIn)
      // Columns added by later ALTERs on a missing table need those
      // migrations too, or the next drift run finds them one at a time.
      for (const col of fact.columns.values()) if (col.declaredIn) needed.add(col.declaredIn)
      continue
    }
    for (const [column, col] of fact.columns) {
      if (!col.declared || liveCols.has(column)) continue
      missingColumns.push({ table, column, migration: col.declaredIn })
      if (col.declaredIn) needed.add(col.declaredIn)
    }
  }

  const unexplained = [...live.keys()].filter((t) => !facts.tables.get(t)?.exists).sort()
  return {
    project,
    missingTables,
    missingColumns,
    migrationsToApply: sortMigrationFiles([...needed]),
    unexplained,
  }
}

async function fetchLive(env: Record<string, string>): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const base = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL
  const key = env.SUPABASE_SERVICE_ROLE_KEY
  if (!base || !key) throw new Error(`${ENV_PATH} needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY`)
  const res = await fetch(`${base}/rest/v1/`, { headers: { apikey: key, Authorization: `Bearer ${key}` } })
  if (!res.ok) throw new Error(`OpenAPI root answered ${res.status}`)
  const json = (await res.json()) as { definitions?: Record<string, { properties?: Record<string, unknown> }> }
  const live = new Map<string, Set<string>>()
  for (const [table, def] of Object.entries(json.definitions ?? {})) {
    live.set(table, new Set(Object.keys(def.properties ?? {})))
  }
  if (live.size === 0) throw new Error('OpenAPI root exposed no relations (wrong key, or PostgREST schema cache cold)')
  return live
}

async function main(): Promise<void> {
  const env = loadEnv(ENV_PATH)
  const project = /https:\/\/([a-z0-9]+)\.supabase\.co/.exec(env.NEXT_PUBLIC_SUPABASE_URL ?? '')?.[1] ?? '?'
  const [facts, live] = [readSchemaFacts(), await fetchLive(env)]
  const report = computeDrift(facts, live, project)

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`\nschema drift for ${project} (${ENV_PATH}): live exposes ${live.size} relations\n`)
    if (report.missingTables.length) {
      console.log(`missing tables (${report.missingTables.length}):`)
      for (const m of report.missingTables) console.log(`  ${m.table.padEnd(36)} <- ${m.migration ?? '(no CREATE TABLE found)'}`)
    }
    if (report.missingColumns.length) {
      console.log(`\nmissing columns (${report.missingColumns.length}):`)
      for (const m of report.missingColumns)
        console.log(`  ${`${m.table}.${m.column}`.padEnd(52)} <- ${m.migration ?? '(no declaration found)'}`)
    }
    if (report.migrationsToApply.length) {
      console.log(`\napply in this order (${report.migrationsToApply.length}):`)
      for (const f of report.migrationsToApply) console.log(`  ${f}`)
      console.log(`\n  MIGRATION_ENV_FILE=${ENV_PATH} npx tsx scripts/run-migration.ts supabase/migrations/<file>`)
    } else {
      console.log('no drift: every migration-declared table and column is live.')
    }
    if (report.unexplained.length)
      console.log(`\nlive relations no migration creates (views, hand-made): ${report.unexplained.length}: ${report.unexplained.join(', ')}`)
    console.log('')
  }
  process.exit(report.migrationsToApply.length ? 1 : 0)
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/schema-drift.ts')
if (invokedDirectly) {
  main().catch((err) => {
    console.error('schema-drift failed:', err instanceof Error ? err.message : String(err))
    process.exit(2)
  })
}
