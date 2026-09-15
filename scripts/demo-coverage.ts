#!/usr/bin/env tsx
/**
 * Is the Crestwood demo data complete, current, and touching every table?
 *
 * Isadora's instruction before the e2e suite runs: "make sure that the
 * Crestwood data is complete, current and touching all tables with a
 * decent number of records". This script answers that, and it answers it
 * twice: what the seed files WOULD create (parsed statically, no database
 * anywhere near it), and what is actually there (`--live`, SELECT count
 * only).
 *
 * Read-only by construction. The only database call this file can make is
 * a `count: 'exact', head: true` select. There is no insert, update,
 * delete or RPC in it, so pointing it at production is safe and is the
 * default.
 *
 * Usage
 * -----
 *   npx tsx scripts/demo-coverage.ts                    # static only
 *   npx tsx scripts/demo-coverage.ts --live             # + live counts from .env.local
 *   npx tsx scripts/demo-coverage.ts --live --env .env.test
 *   npx tsx scripts/demo-coverage.ts --gaps             # only the tables that fail
 *   npx tsx scripts/demo-coverage.ts --json
 *
 * What counts as "a table the demo must fill"
 * -------------------------------------------
 * Every table in `supabase/migrations/` that carries `venue_id` or
 * `wedding_id`, minus the ones a later migration dropped, plus the spine
 * tables that key on `couple_id` instead (`couple_progression_events`).
 * `couples`, `touchpoints`, `fragments` and `candidate_matches` already
 * carry `venue_id`, so they arrive through the same scan.
 *
 * That list is long (250-odd) and most of it is job queues, provider
 * connections and telemetry that only a live integration fills. The `read`
 * column separates the two: a table is `read` when some file under `src/`
 * names it in a `.from('table')` call, which is the honest proxy for "a
 * surface, reader, tool source or cron job looks at this". The verdict
 * line at the bottom counts gaps among READ tables only; everything else
 * is listed for completeness and not held against the seed.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { splitSqlStatements } from './lib/sql-split.js'
import { generateDemoDataset, SEED_TODAY } from './demo-reseed/generate'
import { buildReseedPlan } from './demo-reseed/plan'
import { DEMO_VENUE_IDS } from './demo-reseed/roster'
import { progressionEventTypeFor } from '../src/lib/services/identity/progression'
import type { ReseedPlan } from './demo-reseed/types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Under this many rows and a surface has nothing to show. */
export const THIN_THRESHOLD = 5

/**
 * The seed files, in the order `scripts/e2e-seed.ts` applies them. Kept
 * here rather than imported so the coverage script stays a pure static
 * reader with no dependency on the seeder's env loading.
 */
export const SEED_SQL_FILES: readonly string[] = [
  'supabase/seed.sql',
  'supabase/seed-demo-rich.sql',
  'supabase/seed-marketing-spend-records.sql',
  'supabase/seed-commitments-demo.sql',
  'supabase/seed-contracts-demo.sql',
  'supabase/seed-ad-connections-demo.sql',
  'supabase/seed-reviews.sql',
  'supabase/seed-demo-venue-surfaces.sql',
]

/**
 * Spine tables that carry neither `venue_id` nor `wedding_id` but are the
 * demo's backbone all the same. `couple_progression_events` keys on
 * `couple_id` (migration 346).
 */
export const EXTRA_SPINE_TABLES: readonly string[] = ['couple_progression_events']

/**
 * Tables nothing this repo can seed, with the reason. They stay in the
 * output with verdict `n/a` so the gap count is honest rather than
 * padded, and so a future reader can see the reason without re-deriving
 * it.
 */
export const UNSEEDABLE: Readonly<Record<string, string>> = {
  gmail_connections: 'only a live Google OAuth grant writes a usable row',
  zoom_connections: 'only a live Zoom OAuth grant writes a usable row',
  openphone_connections: 'only a live OpenPhone API key writes a usable row',
  instagram_connections: 'only a live Meta OAuth grant writes a usable row',
  twilio_number_claims: 'claims a real Twilio number; cannot be faked',
  twilio_webhook_log: 'written only by an inbound Twilio delivery',
  zoom_webhook_log: 'written only by an inbound Zoom delivery',
  metered_events: 'written by Stripe metering on real usage',
  cron_runs: 'written by the cron runner; appears on the first scheduled run',
  api_costs: 'written by the model client on a real call',
  error_logs: 'written when something actually fails',
}

/**
 * Tables whose natural maximum is one row per venue: a config row, a
 * provider connection, a sync cursor. Four demo venues means four rows is
 * complete, and calling that "thin" would be a bug in this script rather
 * than a gap in the seed.
 */
export const ONE_PER_VENUE: readonly string[] = [
  'venue_config',
  'venue_ai_config',
  'venue_thesis',
  'email_sync_state',
  'heat_score_config',
  'multi_channel_inbox_settings',
  'digest_preferences',
  'google_ads_connections',
  'meta_ads_connections',
  'tiktok_ads_connections',
  'instagram_connections',
  'gmail_connections',
  'zoom_connections',
  'openphone_connections',
  'auto_send_rules',
  'venue_operational_state',
  'venue_health',
  'storefront',
  'onboarding_projects',
]

/**
 * A work queue or an audit trail. These fill when something runs, not
 * when something is seeded, and an empty one on a fresh branch is the
 * correct state rather than a gap. Counted separately so the gap number
 * at the bottom means something.
 */
export function isQueueTable(table: string): boolean {
  return /(_jobs|_job_state|_queue|_runs|_log|_logs|_history|_telemetry|_webhook_log)$/.test(table)
}

export type TableClass = 'core' | 'per-venue' | 'queue' | 'provider'

export function classify(table: string): TableClass {
  if (UNSEEDABLE[table]) return 'provider'
  if (ONE_PER_VENUE.includes(table)) return 'per-venue'
  if (isQueueTable(table)) return 'queue'
  return 'core'
}

// ---------------------------------------------------------------------------
// Static parser 1: which tables the demo is supposed to fill
// ---------------------------------------------------------------------------

export type TableKey = 'venue_id' | 'wedding_id' | 'couple_id'

export interface DemoTable {
  table: string
  keys: TableKey[]
}

/**
 * Scan migration SQL for tables carrying `venue_id` / `wedding_id`, drop
 * the ones a later migration removed, and add the spine tables that key
 * on `couple_id`.
 *
 * Same heuristic as `scripts/check-rls-on-venue-id.mjs`, deliberately:
 * one scan shape, two guards, so a table cannot be venue-scoped for RLS
 * purposes and invisible for coverage purposes.
 */
export function enumerateDemoTables(migrationSql: string): DemoTable[] {
  const venue = new Set<string>()
  const wedding = new Set<string>()
  const dropped = new Set<string>()

  for (const m of migrationSql.matchAll(
    /create\s+table\s+(?:if\s+not\s+exists\s+)?["']?(?:public\.)?(\w+)["']?\s*\(([\s\S]*?)\n\s*\)\s*;/gi,
  )) {
    const [, table, body] = m
    if (/\bvenue_id\b/i.test(body)) venue.add(table)
    if (/\bwedding_id\b/i.test(body)) wedding.add(table)
  }

  for (const m of migrationSql.matchAll(
    /alter\s+table\s+(?:if\s+exists\s+)?["']?(?:public\.)?(\w+)["']?\s+add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?["']?(venue_id|wedding_id)\b/gi,
  )) {
    if (m[2].toLowerCase() === 'venue_id') venue.add(m[1])
    else wedding.add(m[1])
  }

  for (const m of migrationSql.matchAll(
    /drop\s+table\s+(?:if\s+exists\s+)?["']?(?:public\.)?(\w+)/gi,
  )) {
    dropped.add(m[1])
  }

  const out = new Map<string, DemoTable>()
  const add = (table: string, key: TableKey): void => {
    if (dropped.has(table)) return
    const row = out.get(table) ?? { table, keys: [] }
    if (!row.keys.includes(key)) row.keys.push(key)
    out.set(table, row)
  }
  for (const t of venue) add(t, 'venue_id')
  for (const t of wedding) add(t, 'wedding_id')
  for (const t of EXTRA_SPINE_TABLES) add(t, 'couple_id')

  return [...out.values()].sort((a, b) => (a.table < b.table ? -1 : 1))
}

// ---------------------------------------------------------------------------
// Static parser 2: how many rows the seed SQL would write
// ---------------------------------------------------------------------------

export interface SeedParseResult {
  /** table to the number of VALUES tuples the file inserts. */
  counts: Record<string, number>
  /** Tables reached only by `INSERT ... SELECT`, whose row count cannot
   *  be known without running the query. */
  dynamic: Set<string>
}

const INSERT_HEAD =
  /^\s*insert\s+into\s+(?:only\s+)?["']?(?:public\.)?["']?(\w+)["']?/i

/**
 * Drop leading comments and blank lines from a split statement.
 *
 * `splitSqlStatements` cuts on semicolons, so every chunk carries the
 * comment block that sat between the previous statement and this one. An
 * anchored `^INSERT` would miss almost every insert in the seed files,
 * which are heavily commented, and the coverage report would read as
 * empty for tables that are in fact seeded. Found exactly that way.
 */
export function stripLeadingComments(statement: string): string {
  let i = 0
  const n = statement.length
  for (;;) {
    while (i < n && /\s/.test(statement[i]!)) i++
    if (statement[i] === '-' && statement[i + 1] === '-') {
      while (i < n && statement[i] !== '\n') i++
      continue
    }
    if (statement[i] === '/' && statement[i + 1] === '*') {
      const end = statement.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    return statement.slice(i)
  }
}

/**
 * True when an `INSERT ... SELECT` selects from nothing: a literal row
 * list with a `WHERE NOT EXISTS (...)` guard, which is how the wave 7 and
 * 8 seed files write an insert-if-absent. Exactly one row, statically.
 * A top-level `FROM` means it reads a table and the count is unknowable.
 */
export function isSingleRowSelect(statement: string): boolean {
  let depth = 0
  let i = 0
  const n = statement.length
  const lower = statement.toLowerCase()
  while (i < n) {
    const c = statement[i]!
    if (c === "'") {
      i++
      while (i < n) {
        if (statement[i] === "'") {
          if (statement[i + 1] === "'") {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }
    if (c === '-' && statement[i + 1] === '-') {
      while (i < n && statement[i] !== '\n') i++
      continue
    }
    if (c === '(') {
      depth++
      i++
      continue
    }
    if (c === ')') {
      depth--
      i++
      continue
    }
    if (depth === 0 && lower.startsWith('from', i)) {
      const before = i === 0 ? ' ' : statement[i - 1]!
      const after = statement[i + 4] ?? ' '
      if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)) return false
    }
    i++
  }
  return true
}

/**
 * Count the top-level `(...)` tuples in the VALUES clause of one INSERT.
 *
 * Returns null when the statement has no VALUES clause, which means it is
 * an `INSERT ... SELECT` and the count is not statically knowable.
 *
 * The scan tracks single-quoted literals (with the `''` escape),
 * dollar-quoted bodies and comments, so a `(` inside a string or a
 * `-- note (see above)` comment cannot open a phantom tuple. It stops at
 * the first top-level `ON CONFLICT` / `RETURNING`, because those clauses
 * carry parens of their own.
 */
export function countValuesTuples(statement: string): number | null {
  const lower = statement.toLowerCase()

  // Find `values` at paren depth 0, outside any literal or comment.
  let depth = 0
  let i = 0
  let valuesAt = -1
  const n = statement.length

  const skipLiteral = (): void => {
    // Positioned on the opening quote.
    i++
    while (i < n) {
      if (statement[i] === "'") {
        if (statement[i + 1] === "'") {
          i += 2
          continue
        }
        i++
        return
      }
      i++
    }
  }

  const skipDollar = (tag: string): void => {
    const closer = `$${tag}$`
    const at = statement.indexOf(closer, i + closer.length)
    i = at === -1 ? n : at + closer.length
  }

  const dollarTagAt = (pos: number): string | null => {
    if (statement[pos] !== '$') return null
    let j = pos + 1
    while (j < n && /[A-Za-z0-9_]/.test(statement[j]!)) j++
    if (j >= n || statement[j] !== '$') return null
    return statement.slice(pos + 1, j)
  }

  while (i < n) {
    const c = statement[i]!
    if (c === "'") {
      skipLiteral()
      continue
    }
    if (c === '$') {
      const tag = dollarTagAt(i)
      if (tag !== null) {
        skipDollar(tag)
        continue
      }
    }
    if (c === '-' && statement[i + 1] === '-') {
      while (i < n && statement[i] !== '\n') i++
      continue
    }
    if (c === '/' && statement[i + 1] === '*') {
      const end = statement.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    if (c === '(') {
      depth++
      i++
      continue
    }
    if (c === ')') {
      depth--
      i++
      continue
    }
    if (depth === 0 && /[vV]/.test(c) && lower.startsWith('values', i)) {
      const before = i === 0 ? ' ' : statement[i - 1]!
      const after = statement[i + 6] ?? ' '
      if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)) {
        valuesAt = i + 6
        break
      }
    }
    i++
  }

  if (valuesAt === -1) return null

  // Walk the VALUES clause, counting tuples that open at depth 0.
  let tuples = 0
  depth = 0
  i = valuesAt
  while (i < n) {
    const c = statement[i]!
    if (c === "'") {
      skipLiteral()
      continue
    }
    if (c === '$') {
      const tag = dollarTagAt(i)
      if (tag !== null) {
        skipDollar(tag)
        continue
      }
    }
    if (c === '-' && statement[i + 1] === '-') {
      while (i < n && statement[i] !== '\n') i++
      continue
    }
    if (c === '/' && statement[i + 1] === '*') {
      const end = statement.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    if (c === '(') {
      if (depth === 0) tuples++
      depth++
      i++
      continue
    }
    if (c === ')') {
      depth--
      i++
      continue
    }
    if (depth === 0) {
      if (lower.startsWith('on conflict', i) || lower.startsWith('returning', i)) break
    }
    i++
  }

  return tuples
}

/** Parse one or many seed SQL scripts into per-table row counts. */
export function parseSeedRows(sql: string): SeedParseResult {
  const counts: Record<string, number> = {}
  const dynamic = new Set<string>()
  for (const raw of splitSqlStatements(sql)) {
    const statement = stripLeadingComments(raw)
    const head = INSERT_HEAD.exec(statement)
    if (!head) continue
    const table = head[1]
    const tuples = countValuesTuples(statement)
    if (tuples === null) {
      if (isSingleRowSelect(statement)) {
        counts[table] = (counts[table] ?? 0) + 1
      } else {
        dynamic.add(table)
      }
      continue
    }
    counts[table] = (counts[table] ?? 0) + tuples
  }
  return { counts, dynamic }
}

// ---------------------------------------------------------------------------
// Static parser 3: how many rows the reseed generator would write
// ---------------------------------------------------------------------------

/**
 * Per-table row counts for a reseed plan, derived from the step kinds.
 *
 * `mint_wedding` creates the `weddings` row and the `people` rows behind
 * it (one per named partner). `mirror_couple` creates the `couples` row.
 * `link_signal` writes one `touchpoint`, and, when the signal is
 * progression-eligible, one `couple_progression_events` row, decided by
 * the real mapper rather than a copy of its rules, so the two cannot
 * drift.
 */
export function reseedTableRows(plan: ReseedPlan): Record<string, number> {
  const out: Record<string, number> = {}
  const bump = (table: string, n = 1): void => {
    out[table] = (out[table] ?? 0) + n
  }
  // Dedup key for couple_progression_events, whose PK is
  // (couple_id, occurred_at, event_type).
  const progressionSeen = new Set<string>()

  for (const step of plan.steps) {
    switch (step.kind) {
      case 'mint_wedding':
        bump('weddings')
        bump('people', 2)
        break
      case 'mirror_couple':
        bump('couples')
        break
      case 'link_signal': {
        if (!step.signal) break
        bump('touchpoints')
        const eventType = progressionEventTypeFor(step.signal)
        if (eventType) {
          const key = `${step.storyKey}|${step.signal.occurred_at}|${eventType}`
          if (!progressionSeen.has(key)) {
            progressionSeen.add(key)
            bump('couple_progression_events')
          }
        }
        break
      }
      case 'heat_events':
        bump('engagement_events', step.heatEvents?.length ?? 0)
        break
      case 'tour_row':
        bump('tours')
        break
      case 'lost_deal_row':
        bump('lost_deals')
        break
      case 'aux_rows':
        bump(step.table ?? 'unknown', step.rows?.length ?? 0)
        break
      case 'hero_contact_sync':
      case 'wedding_state':
        break
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Which tables an application surface actually reads
// ---------------------------------------------------------------------------

const FROM_CALL = /\.from\(\s*['"`]([A-Za-z0-9_]+)['"`]/g

/** Walk `src/` and collect every table named in a `.from('x')` call. */
export function collectReadTables(root: string): Set<string> {
  const out = new Set<string>()
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue
      const full = join(dir, entry)
      const st = statSync(full)
      if (st.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue
      const raw = readFileSync(full, 'utf8')
      for (const m of raw.matchAll(FROM_CALL)) out.add(m[1])
    }
  }
  walk(root)
  return out
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export type Verdict = 'empty' | 'thin' | 'ok' | 'n/a'

/** Four demo venues, so a one-row-per-venue table is complete at four. */
export const DEMO_VENUE_COUNT = 4

export function verdictFor(rows: number, table: string): Verdict {
  const kind = classify(table)
  if (kind === 'provider') return 'n/a'
  if (rows === 0) return 'empty'
  const bar = kind === 'per-venue' ? DEMO_VENUE_COUNT : THIN_THRESHOLD
  if (rows < bar) return 'thin'
  return 'ok'
}

export interface CoverageRow {
  table: string
  keys: TableKey[]
  kind: TableClass
  read: boolean
  seeded: number
  /** True when at least one INSERT ... SELECT reaches this table, so the
   *  static number is a floor rather than the whole story. */
  dynamic: boolean
  live: number | null
  liveNote: string | null
  verdict: Verdict
}

export interface CoverageOptions {
  repoRoot: string
  /** Defaults to SEED_TODAY so the numbers are reproducible. */
  today?: string
}

/** Everything the static half of the script knows, without any IO beyond
 *  reading the repo. */
export function buildStaticCoverage(options: CoverageOptions): CoverageRow[] {
  const { repoRoot } = options
  const migDir = join(repoRoot, 'supabase', 'migrations')
  const migrationSql = readdirSync(migDir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(migDir, f), 'utf8'))
    .join('\n')

  const tables = enumerateDemoTables(migrationSql)

  let seedSql = ''
  for (const file of SEED_SQL_FILES) {
    const full = join(repoRoot, file)
    if (!existsSync(full)) continue
    seedSql += `\n${readFileSync(full, 'utf8')}`
  }
  const parsed = parseSeedRows(seedSql)

  const dataset = generateDemoDataset({ today: options.today ?? SEED_TODAY })
  const plan = buildReseedPlan(dataset)
  const fromReseed = reseedTableRows(plan)

  const read = collectReadTables(join(repoRoot, 'src'))

  return tables.map((t) => {
    // The reseed clears and rewrites the spine, so for a table it owns
    // its count REPLACES the seed SQL's rather than adding to it.
    const seeded = fromReseed[t.table] ?? parsed.counts[t.table] ?? 0
    return {
      table: t.table,
      keys: t.keys,
      kind: classify(t.table),
      read: read.has(t.table),
      seeded,
      dynamic: parsed.dynamic.has(t.table),
      live: null,
      liveNote: null,
      verdict: verdictFor(seeded, t.table),
    }
  })
}

// ---------------------------------------------------------------------------
// Live counts. SELECT count only.
// ---------------------------------------------------------------------------

interface LiveEnv {
  url: string
  serviceRoleKey: string
  file: string
}

function loadEnvFile(path: string): LiveEnv {
  const full = resolve(path)
  if (!existsSync(full)) {
    throw new Error(`--live needs an env file; ${full} does not exist. Pass --env <path>.`)
  }
  const values: Record<string, string> = {}
  for (const line of readFileSync(full, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx === -1) continue
    let value = trimmed.slice(idx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    values[trimmed.slice(0, idx).trim()] = value
  }
  const url = values.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const key = values.SUPABASE_SERVICE_ROLE_KEY ?? ''
  if (!url || !key) {
    throw new Error(`${full} is missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.`)
  }
  return { url, serviceRoleKey: key, file: full }
}

/** Chunk a long id list so the `in.(...)` filter stays inside the URL
 *  length PostgREST will accept. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

async function addLiveCounts(rows: CoverageRow[], env: LiveEnv): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js')
  const sb = createClient(env.url, env.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // The demo weddings and couples, so wedding-keyed and couple-keyed
  // tables can be counted without a join.
  const weddingIds: string[] = []
  for (let page = 0; page < 40; page++) {
    const { data, error } = await sb
      .from('weddings')
      .select('id')
      .in('venue_id', DEMO_VENUE_IDS as string[])
      .range(page * 1000, page * 1000 + 999)
    if (error) break
    weddingIds.push(...(data ?? []).map((r) => r.id as string))
    if (!data || data.length < 1000) break
  }
  const coupleIds: string[] = []
  for (let page = 0; page < 40; page++) {
    const { data, error } = await sb
      .from('couples')
      .select('id')
      .in('venue_id', DEMO_VENUE_IDS as string[])
      .range(page * 1000, page * 1000 + 999)
    if (error) break
    coupleIds.push(...(data ?? []).map((r) => r.id as string))
    if (!data || data.length < 1000) break
  }

  const countBy = async (
    table: string,
    column: string,
    ids: readonly string[],
  ): Promise<{ n: number | null; note: string | null }> => {
    if (ids.length === 0) return { n: 0, note: 'no parent rows' }
    let total = 0
    for (const part of chunk(ids, 150)) {
      const { count, error } = await sb
        .from(table)
        .select('*', { count: 'exact', head: true })
        .in(column, part as string[])
      if (error) return { n: null, note: error.message.slice(0, 60) }
      total += count ?? 0
    }
    return { n: total, note: null }
  }

  const queue = rows.slice()
  const workers = Array.from({ length: 6 }, async () => {
    for (;;) {
      const row = queue.shift()
      if (!row) return
      if (row.keys.includes('venue_id')) {
        const { count, error } = await sb
          .from(row.table)
          .select('*', { count: 'exact', head: true })
          .in('venue_id', DEMO_VENUE_IDS as string[])
        if (error) {
          row.live = null
          row.liveNote = error.message.slice(0, 60)
        } else {
          row.live = count ?? 0
        }
        continue
      }
      if (row.keys.includes('wedding_id')) {
        const { n, note } = await countBy(row.table, 'wedding_id', weddingIds)
        row.live = n
        row.liveNote = note
        continue
      }
      const { n, note } = await countBy(row.table, 'couple_id', coupleIds)
      row.live = n
      row.liveNote = note
    }
  })
  await Promise.all(workers)
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderTable(rows: CoverageRow[], withLive: boolean): string {
  const header = withLive
    ? ['table', 'key', 'class', 'read', 'seeded', 'live', 'verdict']
    : ['table', 'key', 'class', 'read', 'seeded', 'verdict']
  const body = rows.map((r) => {
    const key = r.keys.map((k) => k.replace('_id', '')).join('+')
    const seeded = `${r.seeded}${r.dynamic ? '+' : ''}`
    const live = r.live === null ? (r.liveNote ? 'err' : '-') : String(r.live)
    return withLive
      ? [r.table, key, r.kind, r.read ? 'yes' : '', seeded, live, r.verdict]
      : [r.table, key, r.kind, r.read ? 'yes' : '', seeded, r.verdict]
  })
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((b) => b[i].length)),
  )
  const line = (cells: string[]): string =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ')
  const rule = widths.map((w) => '-'.repeat(w)).join('  ')

  const totalSeeded = rows.reduce((s, r) => s + r.seeded, 0)
  const totalLive = rows.reduce((s, r) => s + (r.live ?? 0), 0)
  const totalRow = withLive
    ? ['TOTAL', '', '', '', String(totalSeeded), String(totalLive), '']
    : ['TOTAL', '', '', '', String(totalSeeded), '']

  return [line(header), rule, ...body.map(line), rule, line(totalRow)].join('\n')
}

export interface CoverageSummary {
  tables: number
  readTables: number
  /** Read by a surface AND not a queue or a provider table. This is the
   *  set the seed is answerable for. */
  coreTables: number
  ok: number
  thin: number
  empty: number
  queues: number
  providers: number
  seededTotal: number
}

export function summarise(rows: CoverageRow[]): CoverageSummary {
  const read = rows.filter((r) => r.read)
  const core = read.filter((r) => r.kind === 'core' || r.kind === 'per-venue')
  return {
    tables: rows.length,
    readTables: read.length,
    coreTables: core.length,
    ok: core.filter((r) => r.verdict === 'ok').length,
    thin: core.filter((r) => r.verdict === 'thin').length,
    empty: core.filter((r) => r.verdict === 'empty').length,
    queues: read.filter((r) => r.kind === 'queue').length,
    providers: read.filter((r) => r.kind === 'provider').length,
    seededTotal: rows.reduce((s, r) => s + r.seeded, 0),
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  if (i === -1) return null
  return process.argv[i + 1] ?? null
}

async function main(): Promise<void> {
  const live = process.argv.includes('--live')
  const gapsOnly = process.argv.includes('--gaps')
  const asJson = process.argv.includes('--json')
  const envFile = argValue('--env') ?? '.env.local'
  const repoRoot = process.cwd()

  let rows = buildStaticCoverage({ repoRoot })

  let envUsed: LiveEnv | null = null
  if (live) {
    envUsed = loadEnvFile(envFile)
    await addLiveCounts(rows, envUsed)
  }

  const summary = summarise(rows)
  const shown = gapsOnly
    ? rows.filter(
        (r) =>
          r.read &&
          (r.kind === 'core' || r.kind === 'per-venue') &&
          (r.verdict === 'empty' || r.verdict === 'thin'),
      )
    : rows

  if (asJson) {
    console.log(JSON.stringify({ seedToday: SEED_TODAY, summary, rows: shown }, null, 2))
    return
  }

  console.log('')
  console.log('Crestwood demo coverage')
  console.log('=======================')
  console.log(`  seed today : ${SEED_TODAY}`)
  console.log(`  venues     : ${DEMO_VENUE_IDS.length} (Crestwood Collection)`)
  console.log(
    `  live       : ${envUsed ? `${envUsed.url} via ${envFile}` : 'not read (pass --live)'}`,
  )
  console.log('')
  console.log(renderTable(shown, live))
  console.log('')
  console.log(
    `  ${summary.tables} venue/wedding/couple-keyed tables, ` +
      `${summary.readTables} read by a surface, of which ${summary.coreTables} the seed ` +
      'is answerable for.',
  )
  console.log(
    `  Of those: ${summary.ok} ok, ${summary.thin} thin (<${THIN_THRESHOLD}, or <` +
      `${DEMO_VENUE_COUNT} on a one-row-per-venue table), ${summary.empty} empty.`,
  )
  console.log(
    `  Set aside: ${summary.queues} work queues and audit trails (fill when something ` +
      `runs), ${summary.providers} filled only by a live provider.`,
  )
  console.log(`  ${summary.seededTotal} rows across the seed set.`)
  console.log('')
  if (summary.empty + summary.thin > 0 && !gapsOnly) {
    console.log('  Re-run with --gaps to list only the tables that fail.')
    console.log('')
  }
}

// `import.meta.url` is undefined under some CJS transpiles; the guard
// keeps the module importable from a test either way.
const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  /demo-coverage\.(ts|js)$/.test(process.argv[1])

if (invokedDirectly) {
  main().catch((e) => {
    console.error(`demo-coverage failed: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  })
}
