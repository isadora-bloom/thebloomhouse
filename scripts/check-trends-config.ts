#!/usr/bin/env tsx
/**
 * check-trends-config.ts — is Google Trends actually switched on?
 *
 * NOVEMBER-PLAN.md wave 7, W47.
 *
 * WHY THIS EXISTS
 * ---------------
 * `fetchTrendsForVenue` (src/lib/services/intel/trends.ts) needs two
 * things and says nothing useful when it has neither:
 *
 *   - process.env.SERPAPI_API_KEY. Missing, and the function warns to the
 *     server log and returns 0.
 *   - venues.google_trends_metro for the venue. Missing, and it warns to
 *     the server log and returns 0.
 *
 * Both paths return 0 rather than throwing, so a venue can sit for months
 * with an empty search_trends table and nothing on any screen saying why.
 * The correlation engine then has no Trends channel to pair tours or
 * inquiries against, and the absence reads as "no relationship found"
 * rather than "never measured". This script makes the config state
 * something an operator can see in one command.
 *
 * WHAT IT DOES
 * ------------
 * Reads. That is all. Every venue row, one column, plus a presence check
 * on the environment variable. It never prints the key itself, only
 * whether one is set and how long it is. It is safe against production
 * and is meant to be run there, which is why there is no --allow-prod
 * gate: there is nothing to gate.
 *
 * The Supabase client is wrapped so every write verb throws instead of
 * running. Same guard shape as scripts/isolation-battery.ts, kept local
 * so this script has no dependency on that one.
 *
 * USAGE
 *   npx tsx scripts/check-trends-config.ts [--json]
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, from the
 * shell or mirrored from .env.local.
 *
 * Exit 0 always when it managed to produce a report, including a report
 * full of problems — this is a diagnostic, not a gate. Exit 1 only if it
 * could not read at all.
 */

import { readFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Read-only guard — every mutating verb throws instead of running.
// ---------------------------------------------------------------------------

const WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'delete'])

class ReadOnlyViolation extends Error {}

function guardBuilder<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === 'string' && WRITE_METHODS.has(prop)) {
        return () => {
          throw new ReadOnlyViolation(`check-trends-config: refused .${prop}() — read-only client`)
        }
      }
      const orig = Reflect.get(t, prop, receiver)
      if (typeof orig !== 'function') return orig
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return orig.bind(t)
      return (...args: unknown[]) => {
        const result = orig.apply(t, args)
        return result && typeof result === 'object' ? guardBuilder(result as object) : result
      }
    },
  }) as T
}

export function guardReadOnly(client: SupabaseClient): SupabaseClient {
  return new Proxy(client, {
    get(t, prop, receiver) {
      if (prop === 'rpc') {
        return () => {
          throw new ReadOnlyViolation('check-trends-config: refused .rpc() — read-only client')
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
// Env
// ---------------------------------------------------------------------------

function loadEnv(): void {
  if (!existsSync('.env.local')) return
  const lines = readFileSync('.env.local', 'utf8').split('\n')
  for (const line of lines) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const i = line.indexOf('=')
    const key = line.slice(0, i).trim()
    const value = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    if (!process.env[key]) process.env[key] = value
  }
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface VenueTrendsConfig {
  id: string
  name: string
  status: string | null
  metro: string | null
  /** True when this venue would actually fetch trends today. */
  ready: boolean
  /** Plain reason when it would not. */
  blockedBy: string | null
}

/**
 * Turn one venue row plus the environment state into a verdict. Pure, so
 * the wording is testable without a database.
 */
export function classifyVenue(
  row: { id: string; name: string | null; status: string | null; google_trends_metro: string | null },
  hasApiKey: boolean,
): VenueTrendsConfig {
  const metro = typeof row.google_trends_metro === 'string' && row.google_trends_metro.trim()
    ? row.google_trends_metro.trim()
    : null
  const missing: string[] = []
  if (!hasApiKey) missing.push('SERPAPI_API_KEY is not set in this environment')
  if (!metro) missing.push('venues.google_trends_metro is not set for this venue')
  return {
    id: row.id,
    name: row.name ?? '(unnamed)',
    status: row.status,
    metro,
    ready: missing.length === 0,
    blockedBy: missing.length === 0 ? null : missing.join('; '),
  }
}

async function loadVenues(supabase: SupabaseClient): Promise<VenueTrendsConfig[]> {
  const hasApiKey = Boolean(process.env.SERPAPI_API_KEY && process.env.SERPAPI_API_KEY.trim())
  const { data, error } = await supabase
    .from('venues')
    .select('id, name, status, google_trends_metro')
    .order('name', { ascending: true })
  if (error) throw new Error(`venues read failed — ${error.message}`)
  type Row = { id: string; name: string | null; status: string | null; google_trends_metro: string | null }
  return ((data ?? []) as Row[]).map((r) => classifyVenue(r, hasApiKey))
}

function printReport(rows: VenueTrendsConfig[], keyLength: number, url: string): void {
  console.log('check-trends-config — Google Trends ingestion readiness (read-only)\n')
  console.log(`Supabase:        ${url}`)
  console.log(
    `SERPAPI_API_KEY: ${keyLength > 0 ? `set (${keyLength} characters, not printed)` : 'NOT SET'}`,
  )
  console.log(
    '                 Read by fetchTrendsForVenue in src/lib/services/intel/trends.ts. Without it\n' +
      '                 the fetch warns to the server log and returns 0 rows for every venue.\n',
  )

  const widths = {
    name: Math.max(5, ...rows.map((r) => r.name.length)),
    status: Math.max(6, ...rows.map((r) => (r.status ?? '—').length)),
    metro: Math.max(5, ...rows.map((r) => (r.metro ?? '— not set').length)),
  }
  const line = (name: string, status: string, metro: string, ready: string) =>
    `${name.padEnd(widths.name)}  ${status.padEnd(widths.status)}  ${metro.padEnd(widths.metro)}  ${ready}`
  console.log(line('venue', 'status', 'metro', 'trends'))
  console.log('-'.repeat(widths.name + widths.status + widths.metro + 14))
  for (const r of rows) {
    console.log(line(r.name, r.status ?? '—', r.metro ?? '— not set', r.ready ? 'ON' : 'OFF'))
  }

  const blocked = rows.filter((r) => !r.ready)
  if (blocked.length === 0) {
    console.log('\nEvery venue is configured for Trends.')
  } else {
    console.log(`\n${blocked.length} of ${rows.length} venue(s) will fetch nothing:`)
    for (const r of blocked) {
      console.log(`  ${r.name} (${r.id})`)
      console.log(`    ${r.blockedBy}`)
    }
    console.log(
      '\nFix: set SERPAPI_API_KEY in the environment the cron runs in, and set\n' +
        "venues.google_trends_metro to the venue's Google Trends geo code (for example\n" +
        "'US-VA-511' for the Washington DC metro). Both are needed; either one missing is\n" +
        'silence, not an error.',
    )
  }
}

async function main(): Promise<void> {
  loadEnv()
  const json = process.argv.includes('--json')

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error(
      '[check-trends-config] No Supabase credentials. Set NEXT_PUBLIC_SUPABASE_URL and ' +
        'SUPABASE_SERVICE_ROLE_KEY, or run from the repo root with a .env.local present.',
    )
    process.exit(1)
  }

  const supabase = guardReadOnly(
    createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } }),
  )
  const rows = await loadVenues(supabase)
  const keyLength = (process.env.SERPAPI_API_KEY ?? '').trim().length

  if (json) {
    console.log(JSON.stringify({ supabaseUrl: url, serpApiKeySet: keyLength > 0, venues: rows }, null, 2))
  } else {
    printReport(rows, keyLength, url)
  }
  // No process.exit on the happy path. Forcing an exit while the Supabase
  // client still holds an open handle trips a libuv assertion on Windows,
  // which reads as a crash after a report that in fact succeeded.
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
    console.error('[check-trends-config] fatal:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
