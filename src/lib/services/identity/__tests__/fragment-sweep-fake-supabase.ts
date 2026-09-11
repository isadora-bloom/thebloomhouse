/**
 * Minimal in-memory Supabase fake, scoped to the exact query surface
 * `fragment-sweep.ts` touches: select/eq/is/not/order/limit reads,
 * plain inserts, and update().eq().is() patches. Not a general
 * Supabase mock (see golden-mock-supabase.ts for that) — this one
 * only needs to be honest about `fragments`, `couples`, `venues`,
 * `couple_merge_events`, `candidate_matches` and `tracer_run_events`.
 */

export type Row = Record<string, unknown>

interface Filter {
  op: 'eq' | 'is' | 'not_is' | 'in'
  col: string
  val: unknown
}

function matches(row: Row, f: Filter): boolean {
  const v = row[f.col]
  switch (f.op) {
    case 'eq':
      return v === f.val
    case 'is':
      return f.val === null ? v === null || v === undefined : v === f.val
    case 'not_is':
      // `.not(col, 'is', val)` — negation of the `is` check above.
      return f.val === null ? !(v === null || v === undefined) : v !== f.val
    case 'in':
      return Array.isArray(f.val) && (f.val as unknown[]).includes(v)
    default:
      return true
  }
}

class FakeQuery implements PromiseLike<{ data: Row[] | null; error: { message: string; code?: string } | null }> {
  private filters: Filter[] = []
  private op: 'select' | 'insert' | 'update' | null = null
  private payload: Row | Row[] | null = null
  private limitN: number | null = null

  constructor(
    private readonly db: FakeSupabase,
    private readonly table: string,
  ) {}

  select(_cols?: string): this {
    if (!this.op) this.op = 'select'
    return this
  }

  insert(rows: Row | Row[]): this {
    this.op = 'insert'
    this.payload = rows
    return this
  }

  update(patch: Row): this {
    this.op = 'update'
    this.payload = patch
    return this
  }

  eq(col: string, val: unknown): this {
    this.filters.push({ op: 'eq', col, val })
    return this
  }

  is(col: string, val: unknown): this {
    this.filters.push({ op: 'is', col, val })
    return this
  }

  not(col: string, kind: string, val: unknown): this {
    if (kind === 'is') this.filters.push({ op: 'not_is', col, val })
    return this
  }

  order(_col: string, _opts?: unknown): this {
    return this
  }

  limit(n: number): this {
    this.limitN = n
    return this
  }

  maybeSingle(): this {
    return this
  }

  private run(): { data: Row[] | null; error: { message: string; code?: string } | null } {
    const table = this.db.table(this.table)
    if (this.op === 'insert') {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload as Row]
      for (const r of rows) {
        const withId = { id: this.db.nextId(), ...r }
        table.push(withId)
      }
      return { data: rows, error: null }
    }
    if (this.op === 'update') {
      const matched = table.filter((r) => this.filters.every((f) => matches(r, f)))
      for (const r of matched) Object.assign(r, this.payload as Row)
      return { data: matched, error: null }
    }
    // select
    let rows = table.filter((r) => this.filters.every((f) => matches(r, f)))
    if (this.limitN != null) rows = rows.slice(0, this.limitN)
    return { data: rows, error: null }
  }

  then<TResult1 = { data: Row[] | null; error: { message: string; code?: string } | null }, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: Row[] | null; error: { message: string; code?: string } | null }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected)
  }
}

export class FakeSupabase {
  private idSeq = 1
  readonly tables: Record<string, Row[]> = {
    fragments: [],
    couples: [],
    venues: [],
    couple_merge_events: [],
    candidate_matches: [],
    tracer_run_events: [],
  }

  nextId(): string {
    return `fake-${(this.idSeq++).toString().padStart(6, '0')}`
  }

  table(name: string): Row[] {
    if (!this.tables[name]) this.tables[name] = []
    return this.tables[name]
  }

  // Cast to `unknown` at the call site — this fake implements only the
  // query-builder surface fragment-sweep.ts actually calls, not the
  // full SupabaseClient interface.
  from(name: string): FakeQuery {
    return new FakeQuery(this, name)
  }
}
