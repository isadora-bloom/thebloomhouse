#!/usr/bin/env tsx
/**
 * isolation-battery.ts — two-venue isolation battery.
 *
 * NOVEMBER-PLAN.md wave 5, W38 ("Two-venue isolation battery: a script
 * that, given two venue ids, calls every canonical reader, every tool
 * source and every scope-aware route with each venue and asserts zero
 * rows from the other"). Week 7's gate is "zero cross-tenant reads".
 *
 * WHAT IT DOES
 * ------------
 * For venue A and venue B, in turn:
 *   1. Calls every canonical reader (src/lib/intel/canonical.ts — the
 *      five read functions; askIntel is the NLQ brain, not a data reader,
 *      and is out of scope here, matching the "five canonical readers"
 *      the tool-source registry itself refers to).
 *   2. Calls every registered tool source (src/lib/intel/tool-sources) —
 *      except one known to write; see WRITES below.
 *   3. Walks the returned JSON recursively and collects every `venue_id`
 *      field and every uuid-shaped string.
 *   4. Asserts every `venue_id` field equals the venue that was queried.
 *   5. Cross-checks every collected uuid against `couples` and
 *      `touchpoints` rows belonging to the OTHER venue — one `in` query
 *      per table, per call. A hit is a cross-tenant leak.
 *   6. Best-effort exercises the scope-aware helper
 *      (src/lib/api/resolve-platform-scope.ts) — see the SCOPE HELPER
 *      note below for why this is necessarily partial.
 *
 * WRITES
 * ------
 * Every Supabase call this script makes goes through a read-only guard
 * (guardReadOnly) whose .insert/.update/.upsert/.delete/.rpc throw
 * instead of running — including the client handed to every tool
 * source's run(venueId, args, deps) as deps.supabase. That covers this
 * script never writing by accident.
 *
 * One registered tool source, propose_follow_ups, is known to write
 * outside that client: runPropose calls composeFollowUpDraft, which
 * drives the inquiry brain, and the brain logs a cost row to api_costs
 * on every call (see the comment above runPropose in
 * src/lib/intel/tool-sources/follow-ups.ts — it says so itself: "composing
 * still runs the inquiry brain, which records its own cost row"). That is
 * a real write this script cannot see through deps.supabase, so it is
 * never invoked. It shows up in the table as REFUSED, not PASS. This is a
 * finding to fix in a future workstream, not something patched here.
 *
 * SCOPE HELPER
 * ------------
 * `resolveScopeVenueIds` (src/lib/api/resolve-platform-scope.ts) reads
 * cookies() and an authenticated Supabase session — both are Next.js
 * request-scoped and unavailable to a standalone script. Calling it here
 * throws by construction; the script tries anyway (in case a future
 * refactor makes it callable) and reports the expected failure as SKIP
 * with an explanation, rather than pretending to have tested it. As a
 * substitute, it checks the org-boundary the same function's group/company
 * branches rely on: venue A's org must not expand to include venue B
 * unless they share an org (the demo venues do — see the note in the
 * output when that happens). The venue-level branch itself
 * (`if (scope.level === 'venue') return [scope.venueId]`) takes no query
 * and is correct by construction.
 *
 * USAGE
 *   npx tsx scripts/isolation-battery.ts [--venue-a <uuid>] [--venue-b <uuid>] [--json] [--allow-prod]
 * Defaults: Hawthorne Manor / Crestwood Farm (supabase/seed.sql demo venues).
 * Env: ISOLATION_SUPABASE_URL / ISOLATION_SERVICE_KEY (CI secrets — see
 * .github/workflows/ci.yml), else mirrors .env.local (same pattern as
 * scripts/run-battery.ts).
 *
 * Exit 0 = clean skip (no credentials, or prod ref without --allow-prod)
 *   or every surface PASS/SKIP/REFUSED. Exit 1 = at least one FAIL.
 */

import { readFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { assertNotProd, parseSafetyFlags } from './_safety.mjs'

// ---------------------------------------------------------------------------
// Env — CI secrets first, then .env.local (mirrors scripts/run-battery.ts).
// ---------------------------------------------------------------------------

function loadEnv(): void {
  if (process.env.ISOLATION_SUPABASE_URL && process.env.ISOLATION_SERVICE_KEY) {
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.ISOLATION_SUPABASE_URL
    process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.ISOLATION_SERVICE_KEY
    return
  }
  if (!existsSync('.env.local')) return
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
      }),
  ) as Record<string, string>
  for (const [k, v] of Object.entries(env)) {
    if (!process.env[k]) process.env[k] = v
  }
}

// ---------------------------------------------------------------------------
// Defaults — supabase/seed.sql demo venues, same org (11111111-...-111111111111).
// ---------------------------------------------------------------------------

export const DEFAULT_VENUE_A = '22222222-2222-2222-2222-222222222201' // Hawthorne Manor
export const DEFAULT_VENUE_B = '22222222-2222-2222-2222-222222222202' // Crestwood Farm

// ---------------------------------------------------------------------------
// Read-only client guard — every write verb throws instead of running.
// ---------------------------------------------------------------------------

const WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'delete'])

export class ReadOnlyViolation extends Error {}

function guardBuilder<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === 'string' && WRITE_METHODS.has(prop)) {
        return () => {
          throw new ReadOnlyViolation(`isolation-battery: refused .${prop}() — read-only client`)
        }
      }
      const orig = Reflect.get(t, prop, receiver)
      if (typeof orig !== 'function') return orig
      // Don't re-wrap the thenable machinery itself — just bind it so
      // `await builder` still resolves the real underlying promise.
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return orig.bind(t)
      return (...args: unknown[]) => {
        const result = orig.apply(t, args)
        return result && typeof result === 'object' ? guardBuilder(result as object) : result
      }
    },
  }) as T
}

/**
 * Wraps a Supabase client so every mutating verb throws instead of
 * running: .insert/.update/.upsert/.delete on any `.from(table)` builder,
 * and .rpc directly. Used for every call this script makes, and passed as
 * deps.supabase into every tool source's run(). Defence in depth — the
 * substantive guarantee against propose_follow_ups is that it is simply
 * never called (see the file header).
 */
export function guardReadOnly(client: SupabaseClient): SupabaseClient {
  return new Proxy(client, {
    get(t, prop, receiver) {
      if (prop === 'rpc') {
        return () => {
          throw new ReadOnlyViolation('isolation-battery: refused .rpc() — read-only client')
        }
      }
      const orig = Reflect.get(t, prop, receiver)
      if (prop === 'from' && typeof orig === 'function') {
        return (...args: unknown[]) => guardBuilder(orig.apply(t, args))
      }
      return typeof orig === 'function' ? orig.bind(t) : orig
    },
  }) as SupabaseClient
}

// ---------------------------------------------------------------------------
// The walker — collects venue_id fields and uuid-shaped strings from any
// JSON-shaped reader/tool-source response.
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface VenueIdField {
  path: string
  value: string
}

export interface WalkResult {
  venueIdFields: VenueIdField[]
  uuids: Set<string>
  /** Rough "rows returned" figure — objects encountered that carry an
   *  `id` field, anywhere in the tree. */
  recordCount: number
}

export function walk(
  value: unknown,
  result: WalkResult = { venueIdFields: [], uuids: new Set(), recordCount: 0 },
  path = '$',
): WalkResult {
  if (value === null || value === undefined) return result
  if (typeof value === 'string') {
    if (UUID_RE.test(value)) result.uuids.add(value)
    return result
  }
  if (typeof value !== 'object') return result
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, result, `${path}[${i}]`))
    return result
  }
  const obj = value as Record<string, unknown>
  if (typeof obj.id === 'string') result.recordCount += 1
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'venue_id' && typeof v === 'string') {
      result.venueIdFields.push({ path: `${path}.${k}`, value: v })
    }
    walk(v, result, `${path}.${k}`)
  }
  return result
}

// ---------------------------------------------------------------------------
// Cross-check against the OTHER venue's spine rows.
// ---------------------------------------------------------------------------

export interface ForeignIdHit {
  table: string
  id: string
}

/** One `in` query per table, scoped to the OTHER venue. A hit means an id
 *  that appeared in the response actually belongs to the venue we did NOT
 *  ask about — a cross-tenant leak. */
export async function findForeignIds(
  supabase: SupabaseClient,
  otherVenueId: string,
  ids: string[],
): Promise<ForeignIdHit[]> {
  if (ids.length === 0) return []
  const hits: ForeignIdHit[] = []
  for (const table of ['couples', 'touchpoints'] as const) {
    const { data, error } = await supabase
      .from(table)
      .select('id')
      .eq('venue_id', otherVenueId)
      .in('id', ids)
    if (error) throw new Error(`isolation-battery: ${table} cross-check failed — ${error.message}`)
    for (const row of (data ?? []) as { id: string }[]) hits.push({ table, id: row.id })
  }
  return hits
}

// ---------------------------------------------------------------------------
// Surface result + the per-call checker (this is what the unit test in
// tests/isolation/isolation-battery.test.ts exercises directly).
// ---------------------------------------------------------------------------

export type SurfaceStatus = 'PASS' | 'FAIL' | 'SKIP' | 'REFUSED'

export interface SurfaceResult {
  surface: string
  venue: 'A' | 'B'
  venueId: string
  rows: number
  foreignIds: ForeignIdHit[]
  venueIdMismatches: VenueIdField[]
  status: SurfaceStatus
  note?: string
}

export async function checkSurface(params: {
  surface: string
  venue: 'A' | 'B'
  venueId: string
  otherVenueId: string
  supabase: SupabaseClient
  result: unknown
}): Promise<SurfaceResult> {
  const { surface, venue, venueId, otherVenueId, supabase, result } = params
  const walked = walk(result)
  const venueIdMismatches = walked.venueIdFields.filter((f) => f.value !== venueId)
  const foreignIds = await findForeignIds(supabase, otherVenueId, [...walked.uuids])
  const status: SurfaceStatus = venueIdMismatches.length === 0 && foreignIds.length === 0 ? 'PASS' : 'FAIL'
  return { surface, venue, venueId, rows: walked.recordCount, foreignIds, venueIdMismatches, status }
}

function skipResult(surface: string, venue: 'A' | 'B', venueId: string, note: string): SurfaceResult {
  return { surface, venue, venueId, rows: 0, foreignIds: [], venueIdMismatches: [], status: 'SKIP', note }
}

function refusedResult(surface: string, venue: 'A' | 'B', venueId: string, note: string): SurfaceResult {
  return { surface, venue, venueId, rows: 0, foreignIds: [], venueIdMismatches: [], status: 'REFUSED', note }
}

function failResult(surface: string, venue: 'A' | 'B', venueId: string, note: string): SurfaceResult {
  return { surface, venue, venueId, rows: 0, foreignIds: [], venueIdMismatches: [], status: 'FAIL', note }
}

// ---------------------------------------------------------------------------
// Known-write tool source — never invoked, reported instead.
// ---------------------------------------------------------------------------

const KNOWN_WRITE_SOURCES: Record<string, string> = {
  propose_follow_ups:
    'runPropose calls composeFollowUpDraft, which drives the inquiry brain; the brain logs a cost ' +
    'row to api_costs on every call (see the comment above runPropose in ' +
    'src/lib/intel/tool-sources/follow-ups.ts). That write happens outside the guarded client this ' +
    'script controls, so this source is never called. However, the api_costs row is an audit of spend, ' +
    'not product state, and is intentionally preserved even though this is a read tool.',
}

// ---------------------------------------------------------------------------
// Default args per tool source. `null` means "cannot build valid args for
// this venue" (skip). Everything not listed takes {} — every other source's
// input_schema has no required fields.
// ---------------------------------------------------------------------------

function argsFor(toolName: string, coupleId: string | null): Record<string, unknown> | null {
  switch (toolName) {
    case 'get_time_series':
      return { metric: 'response_time_trend' }
    case 'get_operator_patterns':
      return { metric: 'reply_timing' }
    case 'get_follow_up_state':
      return coupleId ? { couple_ids: [coupleId] } : null
    default:
      return {}
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  venueA: string
  venueB: string
  json: boolean
  allowProd: boolean
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
  }
  const { allowProd } = parseSafetyFlags(argv)
  return {
    venueA: get('--venue-a', DEFAULT_VENUE_A),
    venueB: get('--venue-b', DEFAULT_VENUE_B),
    json: argv.includes('--json'),
    allowProd,
  }
}

async function findOneCoupleId(supabase: SupabaseClient, venueId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('couples')
    .select('id')
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
    .limit(1)
  if (error) throw new Error(`isolation-battery: couples lookup failed — ${error.message}`)
  const row = (data ?? [])[0] as { id: string } | undefined
  return row?.id ?? null
}

interface VenuePair {
  venue: 'A' | 'B'
  venueId: string
  otherVenueId: string
}

async function runAndCheck(
  surface: string,
  p: VenuePair,
  supabase: SupabaseClient,
  fn: () => Promise<unknown>,
): Promise<SurfaceResult> {
  try {
    const raw = await fn()
    return await checkSurface({
      surface,
      venue: p.venue,
      venueId: p.venueId,
      otherVenueId: p.otherVenueId,
      supabase,
      result: raw,
    })
  } catch (err) {
    if (err instanceof ReadOnlyViolation) return refusedResult(surface, p.venue, p.venueId, err.message)
    return failResult(surface, p.venue, p.venueId, `threw: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Best-effort exercise of the scope-aware helper. See the SCOPE HELPER
 * note at the top of the file for why this is necessarily partial.
 */
async function checkScopeHelper(
  venueA: string,
  venueB: string,
  supabase: SupabaseClient,
): Promise<SurfaceResult[]> {
  const out: SurfaceResult[] = []

  try {
    const mod = await import('@/lib/api/resolve-platform-scope')
    await mod.resolveScopeVenueIds()
    out.push(
      skipResult(
        'resolveScopeVenueIds (live)',
        'A',
        venueA,
        'returned without throwing outside a Next.js request — unexpected; treat as informational, not a pass',
      ),
    )
  } catch (err) {
    out.push(
      skipResult(
        'resolveScopeVenueIds (live)',
        'A',
        venueA,
        'requires a live Next.js request (cookies() + an authenticated session); cannot run standalone ' +
          `— see src/lib/api/resolve-platform-scope.ts. (${err instanceof Error ? err.message : String(err)})`,
      ),
    )
  }

  const [{ data: va, error: errA }, { data: vb, error: errB }] = await Promise.all([
    supabase.from('venues').select('org_id').eq('id', venueA).maybeSingle(),
    supabase.from('venues').select('org_id').eq('id', venueB).maybeSingle(),
  ])
  if (errA || errB) {
    out.push(
      skipResult(
        'scope company-expansion (org boundary)',
        'A',
        venueA,
        `could not read venues.org_id — ${(errA ?? errB)?.message}`,
      ),
    )
    return out
  }
  const orgA = (va as { org_id: string | null } | null)?.org_id ?? null
  const orgB = (vb as { org_id: string | null } | null)?.org_id ?? null
  if (!orgA || !orgB) {
    out.push(
      skipResult(
        'scope company-expansion (org boundary)',
        'A',
        venueA,
        'one or both venues have no org_id on record',
      ),
    )
    return out
  }
  if (orgA === orgB) {
    out.push(
      skipResult(
        'scope company-expansion (org boundary)',
        'A',
        venueA,
        `venue A and B share org ${orgA} — company/group scope legitimately returns both, so this pair ` +
          "cannot test the expansion boundary. The venue-level branch (`if (scope.level === 'venue') " +
          'return [scope.venueId]`, resolve-platform-scope.ts) takes no query and is correct by ' +
          'construction. Re-run with --venue-a/--venue-b from two different orgs to exercise this check.',
      ),
    )
    return out
  }
  const { data: orgAVenues, error } = await supabase.from('venues').select('id').eq('org_id', orgA)
  if (error) throw new Error(`isolation-battery: venues org-scope check failed — ${error.message}`)
  const ids = ((orgAVenues ?? []) as { id: string }[]).map((r) => r.id)
  const leaked = ids.includes(venueB)
  out.push({
    surface: 'scope company-expansion (org boundary)',
    venue: 'A',
    venueId: venueA,
    rows: ids.length,
    foreignIds: leaked ? [{ table: 'venues', id: venueB }] : [],
    venueIdMismatches: [],
    status: leaked ? 'FAIL' : 'PASS',
    note: leaked
      ? 'venue B appears in the company-scope expansion for venue A org despite being in a different org'
      : "company-scope expansion for venue A's org does not include venue B",
  })
  return out
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printResults(venueA: string, venueB: string, results: SurfaceResult[], json: boolean): void {
  const summary = {
    pass: results.filter((r) => r.status === 'PASS').length,
    fail: results.filter((r) => r.status === 'FAIL').length,
    skip: results.filter((r) => r.status === 'SKIP').length,
    refused: results.filter((r) => r.status === 'REFUSED').length,
  }

  if (json) {
    console.log(JSON.stringify({ venueA, venueB, results, summary }, null, 2))
    return
  }

  console.log(`isolation-battery — venue A ${venueA} / venue B ${venueB}\n`)

  const rows = results.map((r) => ({
    surface: r.surface,
    venue: r.venue,
    rows: String(r.rows),
    foreignIds: String(r.foreignIds.length + r.venueIdMismatches.length),
    status: r.status,
  }))
  const header = { surface: 'surface', venue: 'venue', rows: 'rows', foreignIds: 'foreign ids', status: 'status' }
  const widths = {
    surface: Math.max(header.surface.length, ...rows.map((r) => r.surface.length)),
    venue: header.venue.length,
    rows: Math.max(header.rows.length, ...rows.map((r) => r.rows.length)),
    foreignIds: Math.max(header.foreignIds.length, ...rows.map((r) => r.foreignIds.length)),
    status: Math.max(header.status.length, ...rows.map((r) => r.status.length)),
  }
  const line = (c: typeof header) =>
    `${c.surface.padEnd(widths.surface)}  ${c.venue.padEnd(widths.venue)}  ${c.rows.padStart(widths.rows)}  ` +
    `${c.foreignIds.padStart(widths.foreignIds)}  ${c.status.padEnd(widths.status)}`
  console.log(line(header))
  console.log('-'.repeat(widths.surface + widths.venue + widths.rows + widths.foreignIds + widths.status + 8))
  for (const r of rows) console.log(line(r))

  for (const r of results) {
    if (r.note) console.log(`\n  ${r.surface} (${r.venue}): ${r.note}`)
    if (r.foreignIds.length) {
      console.log(`  ${r.surface} (${r.venue}) FOREIGN IDS: ${r.foreignIds.map((f) => `${f.table}:${f.id}`).join(', ')}`)
    }
    if (r.venueIdMismatches.length) {
      console.log(
        `  ${r.surface} (${r.venue}) VENUE_ID MISMATCH: ${r.venueIdMismatches.map((f) => `${f.path}=${f.value}`).join(', ')}`,
      )
    }
  }

  console.log(`\nPASS ${summary.pass}  FAIL ${summary.fail}  SKIP ${summary.skip}  REFUSED ${summary.refused}`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { venueA, venueB, json, allowProd } = parseArgs(process.argv.slice(2))
  loadEnv()

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log(
      '[isolation-battery] SKIPPED — no Supabase credentials. Set ISOLATION_SUPABASE_URL / ' +
        'ISOLATION_SERVICE_KEY, or run from the repo root with a .env.local present.',
    )
    process.exit(0)
  }
  assertNotProd(url, { allowProd }) // exits 0 itself if it refuses

  const rawClient = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  const supabase = guardReadOnly(rawClient)
  const today = new Date().toISOString().slice(0, 10)

  const [coupleA, coupleB] = await Promise.all([
    findOneCoupleId(supabase, venueA),
    findOneCoupleId(supabase, venueB),
  ])
  const coupleIdByVenue: Record<string, string | null> = { [venueA]: coupleA, [venueB]: coupleB }

  const canonical = await import('@/lib/intel/canonical')
  const { TOOL_SOURCES } = await import('@/lib/intel/tool-sources')

  const venuePairs: VenuePair[] = [
    { venue: 'A', venueId: venueA, otherVenueId: venueB },
    { venue: 'B', venueId: venueB, otherVenueId: venueA },
  ]

  const results: SurfaceResult[] = []

  // The four readers that take only a venueId.
  const simpleReaders: Array<{ name: string; call: (venueId: string) => Promise<unknown> }> = [
    { name: 'getVenueOverview', call: (v) => canonical.getVenueOverview(v) },
    { name: 'getSourceAttribution', call: (v) => canonical.getSourceAttribution(v) },
    { name: 'getCohortFunnel', call: (v) => canonical.getCohortFunnel(v) },
    { name: 'getDailyList', call: (v) => canonical.getDailyList(v) },
  ]
  for (const reader of simpleReaders) {
    for (const p of venuePairs) {
      results.push(await runAndCheck(reader.name, p, supabase, () => reader.call(p.venueId)))
    }
  }

  // getCoupleJourney needs a couple id from the venue being queried.
  for (const p of venuePairs) {
    const coupleId = coupleIdByVenue[p.venueId]
    if (!coupleId) {
      results.push(skipResult('getCoupleJourney', p.venue, p.venueId, 'no couple on record for this venue'))
      continue
    }
    results.push(
      await runAndCheck('getCoupleJourney', p, supabase, () => canonical.getCoupleJourney(p.venueId, coupleId)),
    )
  }

  // Every registered tool source.
  for (const source of TOOL_SOURCES) {
    const name = source.tool.name
    for (const p of venuePairs) {
      const writeReason = KNOWN_WRITE_SOURCES[name]
      if (writeReason) {
        results.push(refusedResult(name, p.venue, p.venueId, writeReason))
        continue
      }
      const args = argsFor(name, coupleIdByVenue[p.venueId] ?? null)
      if (args === null) {
        results.push(
          skipResult(name, p.venue, p.venueId, 'no couple on record for this venue to pass as couple_ids'),
        )
        continue
      }
      results.push(
        await runAndCheck(name, p, supabase, () => source.run(p.venueId, args, { supabase, today })),
      )
    }
  }

  results.push(...(await checkScopeHelper(venueA, venueB, supabase)))

  printResults(venueA, venueB, results, json)

  const anyFail = results.some((r) => r.status === 'FAIL')
  process.exit(anyFail ? 1 : 0)
}

const isDirectRun = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1] as string).href
  } catch {
    return false
  }
})()

if (isDirectRun) {
  main().catch((err) => {
    console.error('[isolation-battery] fatal:', err)
    process.exit(1)
  })
}
