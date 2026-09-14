/**
 * A small in-memory Supabase stand-in for the contract flows. Test helper
 * only, no network.
 *
 * Deliberately literal, in the same spirit as
 * src/lib/services/__tests__/fake-spine-db.ts: tables are arrays of plain
 * objects and it implements exactly the handful of filters the code under
 * test uses. Anything cleverer would start testing the fake.
 *
 * The one behaviour it does model properly is the conditional update. The
 * single-use signing guard IS `.update(...).eq(id).in('status', open)`
 * returning zero rows when somebody else got there first, so a fake that
 * ignored the filters would prove the opposite of what the test claims.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface FakeRow {
  [key: string]: unknown
}

type Filter =
  | { kind: 'eq'; column: string; value: unknown }
  | { kind: 'in'; column: string; values: unknown[] }
  | { kind: 'is'; column: string; value: unknown }
  | { kind: 'notIs'; column: string; value: unknown }

function matches(row: FakeRow, filters: Filter[]): boolean {
  return filters.every((f) => {
    const actual = row[f.column] ?? null
    switch (f.kind) {
      case 'eq':
        return actual === f.value
      case 'in':
        return f.values.includes(actual)
      case 'is':
        return actual === (f.value ?? null)
      case 'notIs':
        return actual !== (f.value ?? null)
    }
  })
}

let idCounter = 0
function nextId(): string {
  idCounter += 1
  return `row-${String(idCounter).padStart(4, '0')}`
}

class Query implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: Filter[] = []
  private wantsRows = false
  private limitTo: number | null = null
  private orderBy: { column: string; ascending: boolean } | null = null

  constructor(
    private db: FakeContractsDb,
    private table: string,
    private op: 'select' | 'insert' | 'update' | 'delete',
    private payload?: FakeRow,
  ) {
    this.wantsRows = op === 'select'
  }

  select(): this {
    this.wantsRows = true
    return this
  }
  eq(column: string, value: unknown): this {
    this.filters.push({ kind: 'eq', column, value })
    return this
  }
  in(column: string, values: unknown[]): this {
    this.filters.push({ kind: 'in', column, values: [...values] })
    return this
  }
  is(column: string, value: unknown): this {
    this.filters.push({ kind: 'is', column, value })
    return this
  }
  not(column: string, _op: string, value: unknown): this {
    this.filters.push({ kind: 'notIs', column, value })
    return this
  }
  order(column: string, opts?: { ascending?: boolean }): this {
    this.orderBy = { column, ascending: opts?.ascending !== false }
    return this
  }
  limit(n: number): this {
    this.limitTo = n
    return this
  }

  private run(): { data: unknown; error: unknown } {
    this.db.calls.push(`${this.table}.${this.op}`)
    const rows = this.db.table(this.table)

    if (this.op === 'insert') {
      const row: FakeRow = { id: nextId(), created_at: new Date().toISOString(), ...this.payload }
      rows.push(row)
      return { data: this.wantsRows ? [row] : null, error: null }
    }

    const hits = rows.filter((r) => matches(r, this.filters))

    if (this.op === 'update') {
      for (const row of hits) Object.assign(row, this.payload)
      return { data: this.wantsRows ? hits : null, error: null }
    }

    if (this.op === 'delete') {
      for (const row of hits) rows.splice(rows.indexOf(row), 1)
      return { data: this.wantsRows ? hits : null, error: null }
    }

    let out = [...hits]
    if (this.orderBy) {
      const { column, ascending } = this.orderBy
      out.sort((a, b) => {
        const av = String(a[column] ?? '')
        const bv = String(b[column] ?? '')
        return ascending ? av.localeCompare(bv) : bv.localeCompare(av)
      })
    }
    if (this.limitTo !== null) out = out.slice(0, this.limitTo)
    return { data: out, error: null }
  }

  async maybeSingle(): Promise<{ data: FakeRow | null; error: unknown }> {
    const { data, error } = this.run()
    const list = (data ?? []) as FakeRow[]
    return { data: list[0] ?? null, error }
  }

  async single(): Promise<{ data: FakeRow | null; error: unknown }> {
    return this.maybeSingle()
  }

  then<R1 = { data: unknown; error: unknown }, R2 = never>(
    onfulfilled?: ((v: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected)
  }
}

export class FakeContractsDb {
  tables: Record<string, FakeRow[]> = {}
  calls: string[] = []
  /** Files written to the fake bucket, keyed by path. */
  storedFiles = new Map<string, { bytes: Uint8Array; contentType?: string }>()

  table(name: string): FakeRow[] {
    this.tables[name] ??= []
    return this.tables[name]
  }

  seed(name: string, rows: FakeRow[]): void {
    this.table(name).push(...rows)
  }

  from(table: string) {
    return {
      select: (_cols?: string) => new Query(this, table, 'select'),
      insert: (payload: FakeRow) => new Query(this, table, 'insert', payload),
      update: (payload: FakeRow) => new Query(this, table, 'update', payload),
      delete: () => new Query(this, table, 'delete'),
    }
  }

  storage = {
    from: (_bucket: string) => ({
      upload: async (
        path: string,
        bytes: Uint8Array,
        opts?: { contentType?: string },
      ) => {
        this.storedFiles.set(path, { bytes, contentType: opts?.contentType })
        return { data: { path }, error: null }
      },
      createSignedUrl: async (path: string) => ({
        data: { signedUrl: `https://files.test/${path}` },
        error: null,
      }),
      remove: async (paths: string[]) => {
        for (const p of paths) this.storedFiles.delete(p)
        return { data: null, error: null }
      },
    }),
  }

  /** Hand to code that wants a real client. Only the used surface exists. */
  asClient(): SupabaseClient {
    return this as unknown as SupabaseClient
  }
}
