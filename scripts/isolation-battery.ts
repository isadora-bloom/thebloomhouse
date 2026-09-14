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
 *   7. Checks the correlation engine's `tours` channel by day rather than
 *      by id (NOVEMBER-PLAN.md wave 7, W47 — "add W47's new channel to
 *      the wave 5 isolation battery's coverage"). A daily count series
 *      carries no uuids, so the walker above cannot see a leak in it. See
 *      TOURS SERIES below.
 *   8. Asks mergeWeddings to merge a wedding from the other venue and
 *      asserts it refuses before writing anything (W60). That is the one
 *      identity write that could move one venue's rows to another.
 *   9. Walks the cross-venue benchmark reader (wave 8, W56). It is the
 *      only reader that queries other venues deliberately, so the walker
 *      is asserting the opposite thing there: that after reading them, it
 *      returns no peer id, no peer name and no peer's own numbers.
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
 * TOURS SERIES
 * ------------
 * `tours` is a count per day, so there is no id in it for the walker to
 * catch, and comparing one venue's counts against the other's proves
 * nothing on its own: a leaked count and a legitimate count look the same.
 * What separates them is whose couples produced them. loadTourDayCounts
 * returns the couple ids it grouped, and those go through the same
 * findForeignIds cross-check against `couples` as everything else here.
 * A tour of venue B's appearing in venue A's series means one of B's
 * couples is behind one of A's counts, and that is a FAIL. A venue with
 * no tours in the window is a SKIP with the reason, not a pass it did
 * not earn.
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

function passResult(surface: string, venue: 'A' | 'B', venueId: string, note: string): SurfaceResult {
  return { surface, venue, venueId, rows: 0, foreignIds: [], venueIdMismatches: [], status: 'PASS', note }
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

async function findOneWeddingId(supabase: SupabaseClient, venueId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('weddings')
    .select('id')
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
    .limit(1)
  if (error) throw new Error(`isolation-battery: weddings lookup failed — ${error.message}`)
  const row = (data ?? [])[0] as { id: string } | undefined
  return row?.id ?? null
}

/**
 * The one write path in the identity layer that could cross a tenant
 * boundary: mergeWeddings (W60). A merge re-points every wedding-keyed row
 * from the loser to the winner, so a merge across two venues would hand one
 * venue's rows to another — the worst shape of leak this battery looks for,
 * and the only one that is a write rather than a read.
 *
 * mergeWeddings reads both weddings and refuses on a venue mismatch before
 * it touches anything, so calling it here is safe: the refusal happens
 * during the two SELECTs. If it ever got as far as a write, the read-only
 * client would throw ReadOnlyViolation, and that is reported as a FAIL
 * rather than a REFUSED, because reaching a write at all means the venue
 * check moved or went missing.
 */
async function checkMergeVenueIsolation(
  venueA: string,
  venueB: string,
  supabase: SupabaseClient,
): Promise<SurfaceResult[]> {
  const surface = 'mergeWeddings (cross-venue refusal)'
  const out: SurfaceResult[] = []
  const [weddingA, weddingB] = await Promise.all([
    findOneWeddingId(supabase, venueA),
    findOneWeddingId(supabase, venueB),
  ])
  if (!weddingA || !weddingB) {
    out.push(skipResult(surface, 'A', venueA, 'needs one live wedding in each venue; one of them has none'))
    return out
  }

  const { mergeWeddings } = await import('@/lib/services/identity/resolver')
  const attempts: Array<{ venue: 'A' | 'B'; venueId: string; canonical: string; duplicate: string }> = [
    { venue: 'A', venueId: venueA, canonical: weddingA, duplicate: weddingB },
    { venue: 'B', venueId: venueB, canonical: weddingB, duplicate: weddingA },
  ]
  for (const a of attempts) {
    try {
      await mergeWeddings(a.canonical, a.duplicate, { supabase, reason: 'isolation-battery probe' })
      out.push(failResult(surface, a.venue, a.venueId, 'merged a wedding from the other venue instead of refusing'))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (err instanceof ReadOnlyViolation) {
        out.push(failResult(surface, a.venue, a.venueId, `reached a write before checking the venue: ${msg}`))
      } else if (msg.includes('refusing to merge across venues')) {
        out.push(passResult(surface, a.venue, a.venueId, 'refused before any write'))
      } else {
        out.push(failResult(surface, a.venue, a.venueId, `threw something other than the venue refusal: ${msg}`))
      }
    }
  }
  return out
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
 * The correlation engine's `tours` channel, checked by day. See the TOURS
 * SERIES note at the top of the file.
 *
 * The window matches the engine's own default of 90 days. Hard-coded
 * rather than imported because WINDOW_DAYS is private to the engine and
 * exporting it only for a script would be the wrong direction of
 * dependency; if the engine's default ever changes, this check still
 * proves the same property over a slightly different window.
 */
const TOURS_WINDOW_DAYS = 90

export function toursIsolationVerdict(args: {
  venue: 'A' | 'B'
  venueId: string
  /** The tours series itself — days to counts. Reported, not asserted on;
   *  the assertion is on whose couples produced it. */
  held: Map<string, number>
  /** The couples the series was built from. */
  coupleIds: readonly string[]
  /** Those couple ids that turned out to belong to the OTHER venue. */
  foreignIds: ForeignIdHit[]
}): SurfaceResult {
  const { venue, venueId, held, coupleIds, foreignIds } = args

  if (coupleIds.length === 0) {
    return skipResult(
      'correlation tours series',
      venue,
      venueId,
      'no tour touchpoints on the spine for this venue in the window, so the series is empty and ' +
        'there is nothing to attribute. Re-run against a venue with tours on record.',
    )
  }

  const toursCounted = [...held.values()].reduce((a, b) => a + b, 0)
  return {
    surface: 'correlation tours series',
    venue,
    venueId,
    rows: coupleIds.length,
    foreignIds,
    venueIdMismatches: [],
    status: foreignIds.length === 0 ? 'PASS' : 'FAIL',
    note:
      foreignIds.length === 0
        ? `${toursCounted} tour(s) across ${held.size} day(s), from ${coupleIds.length} couple(s), ` +
          'none of which belong to the other venue'
        : `${foreignIds.length} couple(s) behind this series belong to the other venue`,
  }
}

async function checkToursSeries(
  venueA: string,
  venueB: string,
  supabase: SupabaseClient,
): Promise<SurfaceResult[]> {
  try {
    const { loadTourDayCounts } = await import('@/lib/services/intel/correlation-engine')
    const end = new Date()
    const start = new Date(end.getTime() - TOURS_WINDOW_DAYS * 86400e3)
    const pairs: VenuePair[] = [
      { venue: 'A', venueId: venueA, otherVenueId: venueB },
      { venue: 'B', venueId: venueB, otherVenueId: venueA },
    ]
    const out: SurfaceResult[] = []
    for (const p of pairs) {
      const counts = await loadTourDayCounts(supabase, p.venueId, start, end)
      const foreignIds = await findForeignIds(supabase, p.otherVenueId, counts.coupleIds)
      out.push(
        toursIsolationVerdict({
          venue: p.venue,
          venueId: p.venueId,
          held: counts.held,
          coupleIds: counts.coupleIds,
          foreignIds,
        }),
      )
    }
    return out
  } catch (err) {
    return [
      failResult(
        'correlation tours series',
        'A',
        venueA,
        `threw: ${err instanceof Error ? err.message : String(err)}`,
      ),
    ]
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

/**
 * W50's writers and their reader.
 *
 * Wave 7 added two writers that land couple-facing content: planning
 * notes lifted out of coordinator-venue conversations
 * (`services/intel/planning-extraction.ts`), and the nightly commitment
 * reconciliation (`services/commitments/reconcile.ts`). Both are
 * venue-scoped by argument rather than by RLS, because both run under
 * the service key, which means a missing `.eq('venue_id', …)` would not
 * be caught by a policy. That is exactly the class this battery exists
 * for.
 *
 * Three checks, all read-only:
 *
 *   1. Every stored `commitment_reconciliation` row for venue A carries
 *      venue A. A row with the wrong venue is a leak already written.
 *
 *   2. `gatherCommitments` — the reader both the sweep and the queue sit
 *      on — returns nothing when handed venue A with a wedding that
 *      belongs to venue B. This is the check that proves the filter
 *      bites rather than merely being present in the source.
 *
 *   3. Every planning note written from a conversation
 *      (`source_interaction_id IS NOT NULL`) for venue A belongs to a
 *      wedding of venue A.
 */
async function checkCommitmentWriters(
  venueA: string,
  venueB: string,
  supabase: SupabaseClient,
): Promise<SurfaceResult[]> {
  const out: SurfaceResult[] = []

  // 1. Stored reconciliation rows carry the venue that owns them.
  for (const p of [
    { venue: 'A' as const, venueId: venueA, other: venueB },
    { venue: 'B' as const, venueId: venueB, other: venueA },
  ]) {
    const { data, error } = await supabase
      .from('commitment_reconciliation')
      .select('id, venue_id, wedding_id')
      .eq('venue_id', p.venueId)
      .limit(500)

    if (error) {
      out.push(
        skipResult(
          'commitment_reconciliation (stored rows)',
          p.venue,
          p.venueId,
          `could not read the table — ${error.message}. Migration 406 may not have run here.`,
        ),
      )
      continue
    }

    out.push(
      await checkSurface({
        surface: 'commitment_reconciliation (stored rows)',
        venue: p.venue,
        venueId: p.venueId,
        otherVenueId: p.other,
        supabase,
        result: data ?? [],
      }),
    )
  }

  // 2. The reader refuses another venue's wedding.
  const { data: bRows, error: bErr } = await supabase
    .from('commitment_reconciliation')
    .select('wedding_id')
    .eq('venue_id', venueB)
    .limit(1)

  const bWeddingId =
    !bErr && bRows && bRows.length > 0 ? (bRows[0] as { wedding_id: string }).wedding_id : null

  if (!bWeddingId) {
    out.push(
      skipResult(
        'gatherCommitments (cross-venue wedding)',
        'A',
        venueA,
        'venue B has no reconciliation row to borrow a wedding id from, so the cross-venue read ' +
          'cannot be posed. Seed a commitment on venue B and re-run to exercise this.',
      ),
    )
  } else {
    try {
      const mod = await import('@/lib/services/commitments/reconcile')
      const leaked = await mod.gatherCommitments(supabase, venueA, bWeddingId)
      out.push({
        surface: 'gatherCommitments (cross-venue wedding)',
        venue: 'A',
        venueId: venueA,
        rows: leaked.length,
        foreignIds: [],
        venueIdMismatches: [],
        status: leaked.length === 0 ? 'PASS' : 'FAIL',
        note:
          leaked.length === 0
            ? "venue A's reader returns nothing for a wedding belonging to venue B"
            : `venue A's reader returned ${leaked.length} commitment(s) for a venue B wedding`,
      })
    } catch (err) {
      out.push(
        failResult(
          'gatherCommitments (cross-venue wedding)',
          'A',
          venueA,
          `the reader threw instead of returning empty — ${err instanceof Error ? err.message : String(err)}`,
        ),
      )
    }
  }

  // 3. Conversation-sourced planning notes stay inside their venue.
  for (const p of [
    { venue: 'A' as const, venueId: venueA, other: venueB },
    { venue: 'B' as const, venueId: venueB, other: venueA },
  ]) {
    const { data, error } = await supabase
      .from('planning_notes')
      .select('id, venue_id, wedding_id, source_interaction_id')
      .eq('venue_id', p.venueId)
      .not('source_interaction_id', 'is', null)
      .limit(500)

    if (error) {
      out.push(
        skipResult(
          'planning_notes from conversations',
          p.venue,
          p.venueId,
          `could not read the table — ${error.message}. Migration 406 may not have run here.`,
        ),
      )
      continue
    }

    out.push(
      await checkSurface({
        surface: 'planning_notes from conversations',
        venue: p.venue,
        venueId: p.venueId,
        otherVenueId: p.other,
        supabase,
        result: data ?? [],
      }),
    )
  }

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

  // The benchmark reader (NOVEMBER-PLAN.md wave 8, W56) is the one reader
  // that queries other venues on purpose, so it is the one most worth
  // walking here. What the walker should find is nothing: no peer id, no
  // peer name, no peer's own numbers, only a count, a middle figure and a
  // middle-half range. A FAIL on this line means the anonymisation broke.
  // Driven through the injectable pair rather than the service-client
  // wrapper, so it runs on the guarded read-only client like everything
  // else here.
  const { buildVenueBenchmark } = await import('@/lib/services/cohort/benchmark')
  const { buildBenchmarkView } = await import('@/lib/intel/adapters/benchmark-view')
  simpleReaders.push({
    name: 'getBenchmarkView',
    call: async (v) => buildBenchmarkView(await buildVenueBenchmark(supabase, v)),
  })

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

  results.push(...(await checkToursSeries(venueA, venueB, supabase)))

  results.push(...(await checkMergeVenueIsolation(venueA, venueB, supabase)))

  results.push(...(await checkScopeHelper(venueA, venueB, supabase)))
  results.push(...(await checkCommitmentWriters(venueA, venueB, supabase)))

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
