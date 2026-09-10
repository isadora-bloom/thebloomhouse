/**
 * A Supabase client stand-in for the tool-source tests. In memory, no
 * network, no env vars.
 *
 * It is a real filter engine rather than a canned-response stub, because the
 * things these tool sources get wrong are filter mistakes: forgetting the
 * venue scope, forgetting `merged_into_id is null`, reading a tombstoned row
 * as a live couple. A stub that returns the same rows whatever you ask it
 * cannot catch any of those.
 *
 * Supported: select (including head + exact count), eq, neq, is, in, gte, gt,
 * lte, lt, not(col, 'is', null), order, limit, range, maybeSingle, single, and
 * awaiting the builder directly. Anything else returns the builder unchanged,
 * so a call chain never throws for a filter the test does not care about.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type FakeRow = Record<string, unknown>
export type FakeTables = Record<string, FakeRow[]>

interface Predicate {
  (row: FakeRow): boolean
}

function compare(a: unknown, b: unknown): number | null {
  if (a === null || a === undefined) return null
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const as = String(a)
  const bs = String(b)
  return as < bs ? -1 : as > bs ? 1 : 0
}

export function makeFakeSupabase(tables: FakeTables): SupabaseClient {
  function builder(table: string) {
    const rows = (tables[table] ?? []).slice()
    const preds: Predicate[] = []
    let sortKey: string | null = null
    let sortAsc = true
    let head = false
    let wantCount = false
    let take: number | null = null
    let rangeFrom: number | null = null
    let rangeTo: number | null = null

    function resolve() {
      let out = rows.filter((r) => preds.every((p) => p(r)))
      if (sortKey) {
        const key = sortKey
        out = out.slice().sort((a, b) => {
          const c = compare(a[key], b[key]) ?? 0
          return sortAsc ? c : -c
        })
      }
      const total = out.length
      if (rangeFrom !== null) out = out.slice(rangeFrom, (rangeTo ?? total) + 1)
      if (take !== null) out = out.slice(0, take)
      return {
        data: head ? null : out,
        count: wantCount ? total : null,
        error: null,
      }
    }

    const chain = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (opts?.head) head = true
        if (opts?.count) wantCount = true
        return chain
      },
      eq(k: string, v: unknown) {
        preds.push((r) => r[k] === v)
        return chain
      },
      neq(k: string, v: unknown) {
        preds.push((r) => r[k] !== v)
        return chain
      },
      is(k: string, v: unknown) {
        preds.push((r) => (r[k] ?? null) === v)
        return chain
      },
      in(k: string, vals: unknown[]) {
        preds.push((r) => vals.includes(r[k]))
        return chain
      },
      gte(k: string, v: unknown) {
        preds.push((r) => {
          const c = compare(r[k], v)
          return c !== null && c >= 0
        })
        return chain
      },
      gt(k: string, v: unknown) {
        preds.push((r) => {
          const c = compare(r[k], v)
          return c !== null && c > 0
        })
        return chain
      },
      lte(k: string, v: unknown) {
        preds.push((r) => {
          const c = compare(r[k], v)
          return c !== null && c <= 0
        })
        return chain
      },
      lt(k: string, v: unknown) {
        preds.push((r) => {
          const c = compare(r[k], v)
          return c !== null && c < 0
        })
        return chain
      },
      not(k: string, op: string, v: unknown) {
        if (op === 'is') preds.push((r) => (r[k] ?? null) !== v)
        return chain
      },
      order(k: string, opts?: { ascending?: boolean }) {
        sortKey = k
        sortAsc = opts?.ascending !== false
        return chain
      },
      limit(n: number) {
        take = n
        return chain
      },
      range(from: number, to: number) {
        rangeFrom = from
        rangeTo = to
        return chain
      },
      maybeSingle() {
        const r = resolve()
        const first = Array.isArray(r.data) && r.data.length > 0 ? r.data[0] : null
        return Promise.resolve({ data: first, count: r.count, error: null })
      },
      single() {
        return chain.maybeSingle()
      },
      then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
        return Promise.resolve(resolve()).then(onFulfilled, onRejected)
      },
    }
    return chain
  }

  return { from: (table: string) => builder(table) } as unknown as SupabaseClient
}
