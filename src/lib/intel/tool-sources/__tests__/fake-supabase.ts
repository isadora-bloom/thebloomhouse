/**
 * Minimal thenable Supabase query-builder fake, shared by the W14 tool-
 * source tests (reviews, lost-deals, weather-tours, capacity). Mirrors the
 * pattern in src/lib/services/onboarding/__tests__/readiness.test.ts:
 * every filter method is a no-op that returns the same chain object, and
 * the chain itself is thenable so `await sb.from(t).select(...).eq(...)`
 * resolves without a `.then()` call at the use site — same shape as the
 * real supabase-js PostgrestFilterBuilder.
 *
 * `resolve` gets the table name and the full ordered list of filter calls
 * (method + args) applied to that query, so a test can either ignore them
 * and return canned rows per table, or assert on what was actually asked
 * for (e.g. that `.eq('lost_at_stage', 'tour')` was applied).
 *
 * Never touches the network — every one of these tool sources is read-
 * only, so there is no write path to fake.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export interface FilterCall {
  method: string
  args: unknown[]
}

export type FakeResolver = (
  table: string,
  calls: FilterCall[],
) => { data?: unknown[] | Record<string, unknown> | null; error?: { message: string } | null }

const CHAIN_METHODS = [
  'select',
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'not',
  'is',
  'contains',
  'order',
  'limit',
  'range',
] as const

export function makeFakeSupabase(resolve: FakeResolver): SupabaseClient {
  function builder(table: string) {
    const calls: FilterCall[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const method of CHAIN_METHODS) {
      chain[method] = (...args: unknown[]) => {
        calls.push({ method, args })
        return chain
      }
    }
    chain.maybeSingle = () => Promise.resolve(resolve(table, calls))
    chain.single = () => Promise.resolve(resolve(table, calls))
    chain.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(resolve(table, calls)).then(onFulfilled, onRejected)
    return chain
  }
  return { from: (table: string) => builder(table) } as unknown as SupabaseClient
}
