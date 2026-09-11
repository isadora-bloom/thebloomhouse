/**
 * A small in-memory Supabase stand-in for the handle-stamping path
 * (W29, NOVEMBER-PLAN.md wave 4). Test helper only, no network.
 *
 * Deliberately literal. Tables are arrays of plain objects and the only
 * filters are `eq` and `is`, which is exactly what `handle-merge.ts`,
 * `first-seen.ts` and `fragment-sweep-handles.ts` use. Anything cleverer
 * would start testing the fake instead of the code.
 *
 * It is separate from `crm-import/__tests__/fake-supabase.ts`, which
 * reimplements the `lock_and_mint_couple` RPC for the W20 related-contacts
 * path and does not support `is()`. Two small honest fakes beat one that
 * pretends to be Postgres.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface FakeRow { [k: string]: unknown }

let seq = 0
function nextId(prefix: string): string {
  seq += 1
  return `${prefix}-${String(seq).padStart(4, '0')}`
}

export class FakeSpineDb {
  tables: Record<string, FakeRow[]> = {}
  /** Every operation attempted, in order, e.g. 'couples.update'. */
  calls: string[] = []

  table(name: string): FakeRow[] {
    this.tables[name] ??= []
    return this.tables[name]!
  }

  seed(name: string, rows: FakeRow[]): void {
    for (const row of rows) this.table(name).push({ id: nextId(name.slice(0, 6)), ...row })
  }

  client(): SupabaseClient {
    return {
      from: (name: string) => new FakeSpineQuery(this, name),
    } as unknown as SupabaseClient
  }
}

type Filter =
  | { kind: 'eq'; col: string; val: unknown }
  | { kind: 'is'; col: string; val: unknown }

class FakeSpineQuery
implements PromiseLike<{ data: unknown; error: { message: string } | null }> {
  private op: 'select' | 'insert' | 'update' | 'upsert' | null = null
  private filters: Filter[] = []
  private payload: FakeRow | FakeRow[] | null = null
  private one: 'single' | 'maybeSingle' | null = null
  private cap: number | null = null

  constructor(private db: FakeSpineDb, private name: string) {}

  select(): this { if (!this.op) this.op = 'select'; return this }
  insert(payload: FakeRow | FakeRow[]): this { this.op = 'insert'; this.payload = payload; return this }
  update(payload: FakeRow): this { this.op = 'update'; this.payload = payload; return this }
  upsert(payload: FakeRow | FakeRow[]): this { this.op = 'upsert'; this.payload = payload; return this }
  eq(col: string, val: unknown): this { this.filters.push({ kind: 'eq', col, val }); return this }
  is(col: string, val: unknown): this { this.filters.push({ kind: 'is', col, val }); return this }
  not(): this { return this }
  in(): this { return this }
  order(): this { return this }
  limit(n: number): this { this.cap = n; return this }
  single(): this { this.one = 'single'; return this }
  maybeSingle(): this { this.one = 'maybeSingle'; return this }

  private matching(): FakeRow[] {
    return this.db.table(this.name).filter((row) =>
      this.filters.every((f) => {
        if (f.kind === 'eq') return row[f.col] === f.val
        // `is(col, null)` means SQL IS NULL, which an absent key satisfies.
        if (f.val === null) return row[f.col] === null || row[f.col] === undefined
        return row[f.col] === f.val
      }))
  }

  private run(): { data: unknown; error: { message: string } | null } {
    this.db.calls.push(`${this.name}.${this.op ?? 'select'}`)

    if (this.op === 'insert' || this.op === 'upsert') {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload!]
      const written = rows.map((r) => {
        const row = { id: nextId(this.name.slice(0, 6)), ...r }
        this.db.table(this.name).push(row)
        return row
      })
      if (this.one) return { data: written[0] ?? null, error: null }
      return { data: written, error: null }
    }

    if (this.op === 'update') {
      const rows = this.matching()
      for (const r of rows) Object.assign(r, this.payload)
      if (this.one) return { data: rows[0] ?? null, error: null }
      return { data: rows, error: null }
    }

    let rows = this.matching()
    if (this.cap != null) rows = rows.slice(0, this.cap)
    if (this.one === 'maybeSingle') return { data: rows[0] ?? null, error: null }
    if (this.one === 'single') {
      return rows[0]
        ? { data: rows[0], error: null }
        : { data: null, error: { message: 'no rows' } }
    }
    return { data: rows, error: null }
  }

  then<R1 = { data: unknown; error: { message: string } | null }, R2 = never>(
    onfulfilled?: ((v: { data: unknown; error: { message: string } | null }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected)
  }
}
