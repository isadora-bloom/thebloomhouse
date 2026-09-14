/**
 * mergeWeddings contract tests (W60, 2026-09-14).
 *
 * The merge used to walk a hand-written list of 35 tables, nine of which
 * no longer existed, while 75 tables with a wedding_id foreign key were
 * never touched at all — their rows stayed on the losing wedding, where
 * every reader that filters merged_into_id cannot see them. The list is
 * now generated from the live schema
 * (src/lib/services/identity/wedding-fk-tables.generated.json) and this
 * file pins what iterating it must do:
 *
 *   - a plain table's rows follow the wedding
 *   - a one-row-per-wedding table keeps the winner's row, leaves the
 *     loser's where it is, and names it in the audit
 *   - a table that fails does not abort the rest of the merge
 *   - a trigger-covered table, a view and an _archived_ snapshot are
 *     never written
 *   - a cross-venue merge throws before anything moves
 *
 * The fake below is scoped to the merge path: filters, counts, a unique
 * constraint that returns 23505 the way Postgres does (statement-atomic,
 * no partial write), and per-table error injection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { mergeWeddings } from '../resolver'
import cascade from '../wedding-fk-tables.generated.json'

const VENUE_A = 'venue-a'
const VENUE_B = 'venue-b'
const WINNER = 'wedding-winner'
const LOSER = 'wedding-loser'

type Row = Record<string, unknown>
interface PgError {
  code?: string
  message: string
}
interface RunResult {
  data: Row[] | null
  error: PgError | null
  count: number | null
}
interface Filter {
  op: 'eq' | 'is'
  col: string
  val: unknown
}

/** Unique keys the fake enforces, mirroring the real schema. */
const UNIQUE_KEYS: Record<string, string[]> = {
  wedding_details: ['venue_id', 'wedding_id'],
  client_codes: ['wedding_id'],
}

class FakeDb {
  readonly tables: Record<string, Row[]> = {}
  /** table -> error returned by any update against it. */
  readonly updateErrors: Record<string, PgError> = {}
  /** every update the fake was asked to run, in order. */
  readonly updatedTables: string[] = []
  readonly updates: Array<{ table: string; patch: Row }> = []
  private seq = 1

  table(name: string): Row[] {
    if (!this.tables[name]) this.tables[name] = []
    return this.tables[name]!
  }

  seed(name: string, rows: Row[]): void {
    for (const r of rows) this.table(name).push({ id: `${name}-${this.seq++}`, ...r })
  }

  match(rows: Row[], filters: Filter[]): Row[] {
    return rows.filter((r) =>
      filters.every((f) =>
        f.op === 'is' ? (f.val === null ? (r[f.col] ?? null) === null : r[f.col] === f.val) : r[f.col] === f.val,
      ),
    )
  }

  update(name: string, patch: Row, filters: Filter[]): RunResult {
    this.updatedTables.push(name)
    this.updates.push({ table: name, patch })
    const injected = this.updateErrors[name]
    if (injected) return { data: null, error: injected, count: null }

    const rows = this.table(name)
    const matched = this.match(rows, filters)
    const uniq = UNIQUE_KEYS[name]
    if (uniq) {
      // Postgres applies the whole statement or none of it.
      for (const r of matched) {
        const next = { ...r, ...patch }
        const clash = rows.some((other) => other !== r && uniq.every((k) => other[k] === next[k]))
        if (clash) {
          return { data: null, error: { code: '23505', message: `duplicate key on ${name}` }, count: null }
        }
      }
    }
    for (const r of matched) Object.assign(r, patch)
    return { data: matched, error: null, count: matched.length }
  }

  insert(name: string, rows: Row[]): RunResult {
    for (const r of rows) this.table(name).push({ id: `${name}-${this.seq++}`, ...r })
    return { data: rows, error: null, count: rows.length }
  }

  select(name: string, filters: Filter[], limit: number | null): RunResult {
    let rows = this.match(this.table(name), filters)
    if (limit !== null) rows = rows.slice(0, limit)
    return { data: rows, error: null, count: rows.length }
  }

  from(name: string): FakeQuery {
    return new FakeQuery(this, name)
  }
}

class FakeQuery implements PromiseLike<RunResult> {
  private op: 'select' | 'update' | 'insert' = 'select'
  private patch: Row = {}
  private payload: Row[] = []
  private filters: Filter[] = []
  private limitN: number | null = null

  constructor(
    private db: FakeDb,
    private name: string,
  ) {}

  select(): this {
    return this
  }
  update(patch: Row): this {
    this.op = 'update'
    this.patch = patch
    return this
  }
  insert(rows: Row | Row[]): this {
    this.op = 'insert'
    this.payload = Array.isArray(rows) ? rows : [rows]
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
  limit(n: number): this {
    this.limitN = n
    return this
  }

  private run(): RunResult {
    if (this.op === 'update') return this.db.update(this.name, this.patch, this.filters)
    if (this.op === 'insert') return this.db.insert(this.name, this.payload)
    return this.db.select(this.name, this.filters, this.limitN)
  }

  async maybeSingle(): Promise<{ data: Row | null; error: PgError | null }> {
    const res = this.run()
    return { data: res.data?.[0] ?? null, error: res.error }
  }

  then<T1 = RunResult, T2 = never>(
    onFulfilled?: ((v: RunResult) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    try {
      const res = this.run()
      return Promise.resolve(onFulfilled ? onFulfilled(res) : (res as unknown as T1))
    } catch (e) {
      return onRejected ? Promise.resolve(onRejected(e)) : Promise.reject(e)
    }
  }
}

function makeDb(opts: { loserVenue?: string } = {}): { db: FakeDb; client: SupabaseClient } {
  const db = new FakeDb()
  db.seed('weddings', [
    { id: WINNER, venue_id: VENUE_A, notes: null, sage_context_notes: null, merged_into_id: null },
    {
      id: LOSER,
      venue_id: opts.loserVenue ?? VENUE_A,
      notes: null,
      sage_context_notes: null,
      merged_into_id: null,
    },
  ])
  return { db, client: db as unknown as SupabaseClient }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('mergeWeddings — the cascade comes from the generated file', () => {
  it('the file covers the tables the old hand-list missed', () => {
    const keys = new Set(cascade.tables.map((t) => `${t.table}.${t.column}`))
    for (const t of [
      'couple_identity_profile',
      'couple_intel',
      'couple_invites',
      'reviews',
      'budget_items',
      'budget_payments',
      'rsvp_responses',
      'rsvp_config',
      'wedding_party',
      'wedding_details',
      'wedding_config',
      'wedding_tables',
      'table_map_layouts',
      'guest_tags',
      'photo_library',
    ]) {
      expect(keys.has(`${t}.wedding_id`)).toBe(true)
    }
  })

  it('every entry carries a strategy and a reason', () => {
    for (const t of cascade.tables) {
      expect(t.strategy).toBeTruthy()
      expect(String(t.reason).length).toBeGreaterThan(10)
    }
  })
})

describe('mergeWeddings — reassign', () => {
  it('moves every row of a plain table to the winner', async () => {
    const { db, client } = makeDb()
    db.seed('interactions', [
      { wedding_id: LOSER, venue_id: VENUE_A },
      { wedding_id: LOSER, venue_id: VENUE_A },
      { wedding_id: WINNER, venue_id: VENUE_A },
    ])
    db.seed('reviews', [{ wedding_id: LOSER, venue_id: VENUE_A }])

    const res = await mergeWeddings(WINNER, LOSER, { supabase: client, reason: 'test' })

    expect(db.tables.interactions!.every((r) => r.wedding_id === WINNER)).toBe(true)
    expect(db.tables.reviews!.every((r) => r.wedding_id === WINNER)).toBe(true)
    expect(res.reassigned['interactions.wedding_id']).toBe(2)
    expect(res.reassigned['reviews.wedding_id']).toBe(1)
  })

  it('tombstones the loser and writes one audit row with the per-table counts', async () => {
    const { db, client } = makeDb()
    db.seed('interactions', [{ wedding_id: LOSER, venue_id: VENUE_A }])

    await mergeWeddings(WINNER, LOSER, { supabase: client, reason: 'dedupe' })

    const loser = db.tables.weddings!.find((w) => w.id === LOSER)!
    expect(loser.merged_into_id).toBe(WINNER)

    const audit = db.tables.activity_log ?? []
    expect(audit).toHaveLength(1)
    const details = audit[0]!.details as Record<string, unknown>
    expect(audit[0]!.activity_type).toBe('wedding_merged')
    expect(audit[0]!.wedding_id).toBe(WINNER)
    expect(audit[0]!.entity_id).toBe(LOSER)
    expect(details.reason).toBe('dedupe')
    expect((details.moved_by_table as Record<string, number>)['interactions.wedding_id']).toBe(1)
    expect(details.rows_moved_total).toBe(1)
  })

  it('never writes a trigger-covered table, a view or an archived snapshot', async () => {
    const { db, client } = makeDb()
    db.seed('attribution_events', [{ wedding_id: LOSER, venue_id: VENUE_A }])
    db.seed('wedding_heat', [{ wedding_id: LOSER }])
    db.seed('_archived_couple_budget', [{ wedding_id: LOSER, venue_id: VENUE_A }])

    await mergeWeddings(WINNER, LOSER, { supabase: client })

    expect(db.updatedTables).not.toContain('wedding_heat')
    expect(db.updatedTables).not.toContain('_archived_couple_budget')
    // attribution_events.referrer_wedding_id IS reassigned (a referring
    // wedding follows the merge); its wedding_id is the trigger's job.
    const aeWeddingIdWrites = db.updates.filter(
      (u) => u.table === 'attribution_events' && 'wedding_id' in u.patch,
    )
    expect(aeWeddingIdWrites).toHaveLength(0)
    expect(db.tables.attribution_events![0]!.wedding_id).toBe(LOSER)
  })
})

describe('mergeWeddings — one row per wedding', () => {
  it('moves the loser row when the winner has none', async () => {
    const { db, client } = makeDb()
    db.seed('wedding_details', [{ wedding_id: LOSER, venue_id: VENUE_A, guest_count: 80 }])

    const res = await mergeWeddings(WINNER, LOSER, { supabase: client })

    expect(db.tables.wedding_details![0]!.wedding_id).toBe(WINNER)
    expect(res.reassigned['wedding_details.wedding_id']).toBe(1)
  })

  it('keeps the winner row, leaves the loser row in place, and audits it', async () => {
    const { db, client } = makeDb()
    db.seed('wedding_details', [
      { wedding_id: WINNER, venue_id: VENUE_A, guest_count: 120 },
      { wedding_id: LOSER, venue_id: VENUE_A, guest_count: 80 },
    ])

    const res = await mergeWeddings(WINNER, LOSER, { supabase: client })

    const rows = db.tables.wedding_details!
    expect(rows.find((r) => r.guest_count === 120)!.wedding_id).toBe(WINNER)
    // Left where it is: not moved, and emphatically not deleted.
    expect(rows.find((r) => r.guest_count === 80)!.wedding_id).toBe(LOSER)

    const outcome = res.outcomes.find((o) => o.table === 'wedding_details')!
    expect(outcome.strategy).toBe('merge_one_per_wedding')
    expect(outcome.moved).toBe(0)
    expect(outcome.collisions).toHaveLength(1)

    const details = db.tables.activity_log![0]!.details as Record<string, unknown>
    const collisions = details.collisions_left_in_place as Array<{ table: string; rows: unknown[] }>
    expect(collisions.find((c) => c.table === 'wedding_details')!.rows).toHaveLength(1)
  })
})

describe('mergeWeddings — a table whose migration has not been applied yet', () => {
  it('the generated file carries pending entries with the migration that creates them', () => {
    const pending = cascade.tables.filter(
      (t) => (t as { pending_migration?: string }).pending_migration,
    )
    // Not an assertion that any exist today — only that the ones that do
    // name a migration and still carry a usable strategy.
    for (const t of pending) {
      expect(String((t as { pending_migration?: string }).pending_migration)).toMatch(/^\d+_.*\.sql$/)
      expect(['reassign', 'merge_one_per_wedding']).toContain(t.strategy)
    }
  })

  it('skips it on PGRST205, records the skip, and is not a failure', async () => {
    const pending = cascade.tables.find((t) => (t as { pending_migration?: string }).pending_migration)
    if (!pending) return // nothing pending on this schema; the path is still covered above

    const { db, client } = makeDb()
    db.updateErrors[pending.table] = {
      code: 'PGRST205',
      message: `Could not find the table 'public.${pending.table}' in the schema cache`,
    }
    db.seed('interactions', [{ wedding_id: LOSER, venue_id: VENUE_A }])

    const res = await mergeWeddings(WINNER, LOSER, { supabase: client })

    const outcome = res.outcomes.find((o) => o.table === pending.table)!
    expect(outcome.absent).toBe(true)
    expect(outcome.error).toBeUndefined()

    // The rest of the merge is unaffected.
    expect(db.tables.interactions![0]!.wedding_id).toBe(WINNER)
    expect(db.tables.weddings!.find((w) => w.id === LOSER)!.merged_into_id).toBe(WINNER)

    const details = db.tables.activity_log![0]!.details as Record<string, unknown>
    expect(details.pending_tables_not_applied_yet).toContain(pending.table)
    expect((details.failed_tables as unknown[]).length).toBe(0)
  })

  it('a missing table that is NOT pending is still a failure', async () => {
    const { db, client } = makeDb()
    db.updateErrors.reviews = {
      code: 'PGRST205',
      message: "Could not find the table 'public.reviews' in the schema cache",
    }

    const res = await mergeWeddings(WINNER, LOSER, { supabase: client })

    const outcome = res.outcomes.find((o) => o.table === 'reviews')!
    expect(outcome.absent).toBeUndefined()
    expect(outcome.error).toContain('Could not find the table')
  })
})

describe('mergeWeddings — a failing table does not abort the merge', () => {
  it('records the failure and carries on with the other tables', async () => {
    const { db, client } = makeDb()
    db.updateErrors.drafts = { code: '42501', message: 'permission denied for table drafts' }
    db.seed('drafts', [{ wedding_id: LOSER, venue_id: VENUE_A }])
    db.seed('interactions', [{ wedding_id: LOSER, venue_id: VENUE_A }])
    db.seed('guest_list', [{ wedding_id: LOSER, venue_id: VENUE_A }])

    const res = await mergeWeddings(WINNER, LOSER, { supabase: client })

    expect(db.tables.drafts![0]!.wedding_id).toBe(LOSER)
    expect(db.tables.interactions![0]!.wedding_id).toBe(WINNER)
    expect(db.tables.guest_list![0]!.wedding_id).toBe(WINNER)

    const failed = res.outcomes.find((o) => o.table === 'drafts')!
    expect(failed.error).toContain('permission denied')

    // The merge still completed: tombstone set, audit written, failure named.
    expect(db.tables.weddings!.find((w) => w.id === LOSER)!.merged_into_id).toBe(WINNER)
    const details = db.tables.activity_log![0]!.details as Record<string, unknown>
    const failures = details.failed_tables as Array<{ table: string }>
    expect(failures.map((f) => f.table)).toContain('drafts')
  })
})

describe('mergeWeddings — venue isolation', () => {
  it('refuses a cross-venue merge and touches nothing', async () => {
    const { db, client } = makeDb({ loserVenue: VENUE_B })
    db.seed('interactions', [{ wedding_id: LOSER, venue_id: VENUE_B }])

    await expect(mergeWeddings(WINNER, LOSER, { supabase: client })).rejects.toThrow(
      /refusing to merge across venues/,
    )

    expect(db.updatedTables).toHaveLength(0)
    expect(db.tables.interactions![0]!.wedding_id).toBe(LOSER)
    expect(db.tables.weddings!.find((w) => w.id === LOSER)!.merged_into_id).toBe(null)
    expect(db.tables.activity_log ?? []).toHaveLength(0)
  })

  it('refuses to merge a loser that is already merged somewhere else', async () => {
    const { db, client } = makeDb()
    db.tables.weddings!.find((w) => w.id === LOSER)!.merged_into_id = 'wedding-third'

    await expect(mergeWeddings(WINNER, LOSER, { supabase: client })).rejects.toThrow(/already merged into/)
    expect(db.updatedTables).toHaveLength(0)
  })

  it('refuses when either wedding is missing', async () => {
    const { client } = makeDb()
    await expect(mergeWeddings(WINNER, 'no-such-wedding', { supabase: client })).rejects.toThrow(/not found/)
    await expect(mergeWeddings('no-such-wedding', LOSER, { supabase: client })).rejects.toThrow(/not found/)
  })
})
