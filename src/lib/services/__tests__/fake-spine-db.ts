/**
 * A small in-memory Supabase stand-in for the handle-stamping path
 * (W29, NOVEMBER-PLAN.md wave 4). Test helper only, no network.
 *
 * Deliberately literal. Tables are arrays of plain objects and the filters
 * are the handful the code under test actually uses. Anything cleverer
 * would start testing the fake instead of the code.
 *
 * W35 widened it to cover `linkSignal`'s legacy-wedding fast path, which
 * the CSV import now takes: comparison filters for point-zero and
 * first-seen, and the unique keys those paths depend on. The touchpoints
 * unique key is the one that matters most. Rerun safety for an import IS
 * that constraint, so a fake that let the duplicate through would prove the
 * opposite of what the test claims.
 *
 * It is separate from `crm-import/__tests__/fake-supabase.ts`, which
 * reimplements the `lock_and_mint_couple` RPC for the W20 related-contacts
 * path and does not support `is()`. Two small honest fakes beat one that
 * pretends to be Postgres.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface FakeRow { [k: string]: unknown }

type PgError = { message: string; code?: string }

/**
 * The unique constraints the code under test actually leans on. W35 needs
 * these: rerun safety for a CSV import is `UNIQUE(venue_id, channel,
 * external_id)` on touchpoints turning a second upload into a no-op, and a
 * fake that lets the duplicate through would prove the opposite of what the
 * test claims.
 */
const UNIQUE_KEYS: Record<string, string[]> = {
  touchpoints: ['venue_id', 'channel', 'external_id'],
  fragments: ['venue_id', 'channel', 'external_id'],
  couples: ['venue_id', 'source_wedding_id'],
}

/** Timestamps compare as time, everything else as a number or a string. */
function compareValue(v: unknown): number | string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const ms = Date.parse(v)
    return Number.isFinite(ms) ? ms : v
  }
  return null
}

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
  // W35 additions. `linkSignal`'s fast path reaches point-zero and
  // first-seen, which compare timestamps and exclude the touchpoint they
  // just wrote, so the fake needs more than equality now.
  | { kind: 'neq'; col: string; val: unknown }
  | { kind: 'in'; col: string; val: unknown[] }
  | { kind: 'cmp'; col: string; val: unknown; op: 'lt' | 'lte' | 'gt' | 'gte' }

class FakeSpineQuery
implements PromiseLike<{ data: unknown; error: PgError | null }> {
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
  neq(col: string, val: unknown): this { this.filters.push({ kind: 'neq', col, val }); return this }
  lt(col: string, val: unknown): this { this.filters.push({ kind: 'cmp', col, val, op: 'lt' }); return this }
  lte(col: string, val: unknown): this { this.filters.push({ kind: 'cmp', col, val, op: 'lte' }); return this }
  gt(col: string, val: unknown): this { this.filters.push({ kind: 'cmp', col, val, op: 'gt' }); return this }
  gte(col: string, val: unknown): this { this.filters.push({ kind: 'cmp', col, val, op: 'gte' }); return this }
  not(): this { return this }
  in(col: string, val: unknown[]): this { this.filters.push({ kind: 'in', col, val }); return this }
  or(): this { return this }
  order(): this { return this }
  limit(n: number): this { this.cap = n; return this }
  single(): this { this.one = 'single'; return this }
  maybeSingle(): this { this.one = 'maybeSingle'; return this }

  private matching(): FakeRow[] {
    return this.db.table(this.name).filter((row) =>
      this.filters.every((f) => {
        if (f.kind === 'eq') return row[f.col] === f.val
        if (f.kind === 'neq') return row[f.col] !== f.val
        if (f.kind === 'in') return f.val.includes(row[f.col])
        if (f.kind === 'cmp') {
          const a = compareValue(row[f.col])
          const b = compareValue(f.val)
          if (a === null || b === null) return false
          if (f.op === 'lt') return a < b
          if (f.op === 'lte') return a <= b
          if (f.op === 'gt') return a > b
          return a >= b
        }
        // `is(col, null)` means SQL IS NULL, which an absent key satisfies.
        if (f.val === null) return row[f.col] === null || row[f.col] === undefined
        return row[f.col] === f.val
      }))
  }

  private run(): { data: unknown; error: PgError | null } {
    this.db.calls.push(`${this.name}.${this.op ?? 'select'}`)

    if (this.op === 'insert' || this.op === 'upsert') {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload!]
      const keys = UNIQUE_KEYS[this.name] ?? null
      const written: FakeRow[] = []
      for (const r of rows) {
        const clash = keys
          ? this.db.table(this.name).find((existing) =>
              keys.every((k) => existing[k] !== undefined && existing[k] === r[k]))
          : undefined
        if (clash) {
          // An upsert updates the row it collided with; a plain insert
          // fails the way Postgres does, so the caller's 23505 branch runs.
          if (this.op === 'upsert') {
            Object.assign(clash, r)
            written.push(clash)
            continue
          }
          return {
            data: null,
            error: { message: `duplicate key value violates unique constraint on ${this.name}`, code: '23505' },
          }
        }
        const row = { id: nextId(this.name.slice(0, 6)), ...r }
        this.db.table(this.name).push(row)
        written.push(row)
      }
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

  then<R1 = { data: unknown; error: PgError | null }, R2 = never>(
    onfulfilled?: ((v: { data: unknown; error: PgError | null }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected)
  }
}
