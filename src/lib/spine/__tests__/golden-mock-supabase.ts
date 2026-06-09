/**
 * In-memory Supabase fake for the mock-driven golden subset (CI gate).
 *
 * WHY THIS EXISTS
 * ---------------
 * The full golden harness (tests/golden/run-golden-cases.ts) runs the REAL
 * cascade against a TEST-BRANCH Supabase, so it cannot run in CI — and a
 * matcher regression (GC-5, 2026-06-04) reached prod undetected precisely
 * because golden is not gated. This fake lets a CI-safe subset of the SAME
 * cases.json run the REAL `linkSignal` against an in-memory database, with
 * NO network and NO test branch, so a matching / veto / tier-routing /
 * partner-reconciliation regression fails `npx vitest run`.
 *
 * WHAT IS REAL vs FAKE
 * --------------------
 * REAL (un-mocked, exercised end-to-end by the test):
 *   - the matcher (`scoreCandidate`)            — the scoring decision
 *   - the Tier-1.5 guard (`hardContradiction`)  — the GC-4/GC-5 veto
 *   - tier routing (`applyTierRouting`)         — attach / candidate / mint / fragment
 *   - partner reconciliation (`merge_couples`)  — the GC-5 merge primitive
 *   - the lock_and_mint_couple RPC's email/phone re-check + mint semantics
 * FAKE (this file): a minimal Postgres stand-in implementing only the query
 *   surface those code paths touch — see SUPPORTED below. The two RPCs
 *   (lock_and_mint_couple, merge_couples) are re-implemented in JS to MATCH
 *   migrations 359 + 379 (kept in lock-step with those files).
 *
 * SUPPORTED query surface (faithful to supabase-js where it matters):
 *   .from(t).select(cols, {count,head}?) .eq .is .in .neq .gte .lte .order .limit
 *           .maybeSingle() .single()
 *   .from(t).insert(rows).select(cols?).maybeSingle()?   (23505 on unique conflict)
 *   .from(t).update(patch).eq(...)
 *   .from(t).delete().eq(...)
 *   .rpc('lock_and_mint_couple' | 'merge_couples', params)
 * Unique constraints enforced: touchpoints + fragments on (venue_id, channel,
 * external_id) — the rerun-safety primitive the spine writers rely on.
 *
 * NOT a general-purpose Supabase mock. It is scoped to the linkSignal path.
 * The orthogonal side-modules (llm-judge, judge-context, progression,
 * resurrection) are vi.mock'd in the test, not implemented here.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type Row = Record<string, unknown>
interface PgError {
  code?: string
  message: string
}
interface RunResult {
  data: Row[] | null
  error: PgError | null
  count: number | null
}

/** Unique constraints the fake enforces (23505 on violation). */
const UNIQUE_KEYS: Record<string, string[]> = {
  touchpoints: ['venue_id', 'channel', 'external_id'],
  fragments: ['venue_id', 'channel', 'external_id'],
}

type FilterOp = 'eq' | 'is' | 'in' | 'neq' | 'gte' | 'lte'
interface Filter {
  op: FilterOp
  col: string
  val: unknown
}

function lc(v: unknown): string {
  return typeof v === 'string' ? v.toLowerCase() : ''
}

export class MockSupabase {
  /** Deterministic id + insertion-sequence counters (no Date/random — stable). */
  private idSeq = 1
  private rowSeq = 1
  readonly tables: Record<string, Row[]> = {
    couples: [],
    touchpoints: [],
    fragments: [],
    candidate_matches: [],
    tracer_run_events: [],
    couple_progression_events: [],
    couple_merge_events: [],
    resurrection_blacklist: [],
  }

  private nextId(): string {
    return `00000000-0000-4000-8000-${(this.idSeq++).toString(16).padStart(12, '0')}`
  }

  private table(name: string): Row[] {
    if (!this.tables[name]) this.tables[name] = []
    return this.tables[name]
  }

  from(name: string): MockQuery {
    return new MockQuery(this, name)
  }

  // ---- exposed to the query builder ---------------------------------------

  /** Apply a filter list to a row set. */
  filterRows(rows: Row[], filters: Filter[]): Row[] {
    return rows.filter((r) =>
      filters.every((f) => {
        const v = r[f.col]
        switch (f.op) {
          case 'eq':
            return v === f.val
          case 'neq':
            return v !== f.val
          case 'is':
            return f.val === null ? v === null || v === undefined : v === f.val
          case 'in':
            return Array.isArray(f.val) && (f.val as unknown[]).includes(v)
          case 'gte':
            return typeof v === 'string' && typeof f.val === 'string' ? v >= f.val : false
          case 'lte':
            return typeof v === 'string' && typeof f.val === 'string' ? v <= f.val : false
          default:
            return true
        }
      }),
    )
  }

  insertRows(name: string, rows: Row[]): RunResult {
    const tbl = this.table(name)
    const uniq = UNIQUE_KEYS[name]
    const inserted: Row[] = []
    for (const raw of rows) {
      const row: Row = { ...raw }
      if (row.id === undefined) row.id = this.nextId()
      row._seq = this.rowSeq++
      if (uniq) {
        const clash = tbl.some((existing) => uniq.every((k) => existing[k] === row[k]))
        if (clash) {
          return { data: null, error: { code: '23505', message: `duplicate key on ${name}(${uniq.join(',')})` }, count: null }
        }
      }
      tbl.push(row)
      inserted.push(row)
    }
    return { data: inserted, error: null, count: inserted.length }
  }

  updateRows(name: string, patch: Row, filters: Filter[]): RunResult {
    const matched = this.filterRows(this.table(name), filters)
    for (const r of matched) Object.assign(r, patch)
    return { data: matched, error: null, count: matched.length }
  }

  deleteRows(name: string, filters: Filter[]): RunResult {
    const tbl = this.table(name)
    const keep = tbl.filter((r) => !this.filterRows([r], filters).length)
    const removed = tbl.length - keep.length
    this.tables[name] = keep
    return { data: null, error: null, count: removed }
  }

  // ---- RPCs (lock-step with migrations 359 + 379) -------------------------

  async rpc(name: string, params: Record<string, unknown>): Promise<{ data: unknown; error: PgError | null }> {
    if (name === 'lock_and_mint_couple') return { data: this.lockAndMint(params), error: null }
    if (name === 'merge_couples') return { data: this.mergeCouples(params), error: null }
    throw new Error(`MockSupabase: unhandled rpc '${name}'`)
  }

  /** Mirrors migration 359: idempotency → email/phone re-check → mint → attach tp. */
  private lockAndMint(p: Record<string, unknown>): Row {
    const venue = p.p_venue_id as string
    const channel = p.p_channel as string
    const externalId = p.p_external_id as string
    const email = (p.p_primary_email as string | null) ?? null
    const phone = (p.p_primary_phone as string | null) ?? null

    // (2) idempotency: this exact signal already swept?
    const existingTp = this.table('touchpoints').find(
      (t) => t.venue_id === venue && t.channel === channel && t.external_id === externalId,
    )
    if (existingTp) {
      return {
        couple_id: existingTp.couple_id ?? null,
        minted: false,
        touchpoint_inserted: false,
        touchpoint_id: existingTp.id ?? null,
      }
    }

    // (3) re-check inside the lock: existing couple for this email/phone?
    const couples = this.table('couples')
      .filter((c) => c.venue_id === venue)
      .sort((a, b) => (a._seq as number) - (b._seq as number))
    let coupleId: string | null = null
    if (email && email.trim()) {
      const hit = couples.find((c) => lc(c.primary_contact_email) === lc(email) || lc(c.partner_contact_email) === lc(email))
      if (hit) coupleId = hit.id as string
    }
    if (!coupleId && phone && phone.trim()) {
      const hit = couples.find((c) => c.primary_contact_phone === phone || c.partner_contact_phone === phone)
      if (hit) coupleId = hit.id as string
    }

    // (4) mint a channel-scoped couple if none.
    let minted = false
    if (!coupleId) {
      const res = this.insertRows('couples', [
        {
          venue_id: venue,
          primary_contact_name: p.p_primary_name ?? null,
          primary_contact_email: email,
          primary_contact_phone: phone,
          partner_contact_name: (p.p_partner_name as string | null) ?? null,
          partner_contact_email: (p.p_partner_email as string | null) ?? null,
          partner_contact_phone: (p.p_partner_phone as string | null) ?? null,
          wedding_date: (p.p_wedding_date as string | null) ?? null,
          lifecycle_state: 'channel_scoped',
          channel_scope: p.p_channel_scope ?? channel,
          last_progression_at: p.p_occurred_at ?? null,
          merged_into_id: null,
          heat_score: null,
          source_wedding_id: null,
        },
      ])
      coupleId = (res.data?.[0]?.id as string) ?? null
      minted = true
    }

    // (5) attach the touchpoint, ON CONFLICT DO NOTHING.
    const tpRes = this.insertRows('touchpoints', [
      {
        venue_id: venue,
        couple_id: coupleId,
        channel,
        signal_tier: p.p_signal_tier ?? null,
        action_type: p.p_action_type ?? null,
        external_id: externalId,
        occurred_at: p.p_occurred_at ?? null,
        raw_payload: p.p_raw_payload ?? null,
      },
    ])
    const tpInserted = tpRes.error === null
    return {
      couple_id: coupleId,
      minted,
      touchpoint_inserted: tpInserted,
      touchpoint_id: tpInserted ? ((tpRes.data?.[0]?.id as string) ?? null) : null,
    }
  }

  /** Mirrors migration 379: dynamic couple_id reassign → candidate_matches
   *  repoint → partner backfill → merged_into_id tombstone → audit. */
  private mergeCouples(p: Record<string, unknown>): boolean {
    const winnerId = p.p_winner as string
    const loserId = p.p_loser as string
    if (!winnerId || !loserId || winnerId === loserId) return false

    const winner = this.table('couples').find((c) => c.id === winnerId && (c.merged_into_id ?? null) === null)
    if (!winner) return false
    const venue = winner.venue_id
    const loser = this.table('couples').find(
      (c) => c.id === loserId && c.venue_id === venue && (c.merged_into_id ?? null) === null,
    )
    if (!loser) return false

    // reassign every couple_id-bearing row dynamically.
    for (const rows of Object.values(this.tables)) {
      for (const r of rows) {
        if (r.couple_id === loserId) r.couple_id = winnerId
      }
    }
    // candidate_matches repoint by (record_id, record_type='couple').
    for (const cm of this.table('candidate_matches')) {
      if (cm.primary_record_id === loserId && cm.primary_record_type === 'couple') cm.primary_record_id = winnerId
      if (cm.secondary_record_id === loserId && cm.secondary_record_type === 'couple') cm.secondary_record_id = winnerId
    }
    // partner backfill (coalesce) onto the winner.
    winner.partner_contact_name = winner.partner_contact_name ?? loser.primary_contact_name
    winner.partner_contact_email = winner.partner_contact_email ?? loser.primary_contact_email
    winner.partner_contact_phone = winner.partner_contact_phone ?? loser.primary_contact_phone
    // tombstone the loser (demotion, not deletion).
    loser.merged_into_id = winnerId
    // audit.
    this.insertRows('couple_merge_events', [
      {
        venue_id: venue,
        event_type: 'partner_reconciliation',
        primary_couple_id: winnerId,
        secondary_couple_id: loserId,
        rule_triggered: (p.p_rule as string) ?? 'partner_reconciliation',
        confidence_tier: 'high',
        reason: (p.p_reason as string) ?? null,
      },
    ])
    return true
  }
}

/** Chainable query builder. Resolves (thenable) or via maybeSingle/single. */
class MockQuery implements PromiseLike<RunResult> {
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select'
  private payload: Row[] = []
  private patch: Row = {}
  private filters: Filter[] = []
  private orderCol: string | null = null
  private orderAsc = true
  private limitN: number | null = null
  private countMode = false
  private headMode = false

  constructor(
    private db: MockSupabase,
    private name: string,
  ) {}

  select(_cols?: string, opts?: { count?: 'exact'; head?: boolean }): this {
    // select() after insert/update is "return representation" — keep op.
    if (this.op === 'select') this.op = 'select'
    if (opts?.count) this.countMode = true
    if (opts?.head) this.headMode = true
    return this
  }

  insert(rows: Row | Row[]): this {
    this.op = 'insert'
    this.payload = Array.isArray(rows) ? rows : [rows]
    return this
  }

  update(patch: Row): this {
    this.op = 'update'
    this.patch = patch
    return this
  }

  delete(): this {
    this.op = 'delete'
    return this
  }

  eq(col: string, val: unknown): this {
    this.filters.push({ op: 'eq', col, val })
    return this
  }
  neq(col: string, val: unknown): this {
    this.filters.push({ op: 'neq', col, val })
    return this
  }
  is(col: string, val: unknown): this {
    this.filters.push({ op: 'is', col, val })
    return this
  }
  in(col: string, val: unknown[]): this {
    this.filters.push({ op: 'in', col, val })
    return this
  }
  gte(col: string, val: unknown): this {
    this.filters.push({ op: 'gte', col, val })
    return this
  }
  lte(col: string, val: unknown): this {
    this.filters.push({ op: 'lte', col, val })
    return this
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderCol = col
    this.orderAsc = opts?.ascending ?? true
    return this
  }
  limit(n: number): this {
    this.limitN = n
    return this
  }

  private run(): RunResult {
    if (this.op === 'insert') return this.db.insertRows(this.name, this.payload)
    if (this.op === 'update') return this.db.updateRows(this.name, this.patch, this.filters)
    if (this.op === 'delete') return this.db.deleteRows(this.name, this.filters)
    // select
    let rows = this.db.filterRows(this.db.tables[this.name] ?? [], this.filters)
    if (this.orderCol) {
      const col = this.orderCol
      rows = [...rows].sort((a, b) => {
        const av = a[col] as string | number
        const bv = b[col] as string | number
        if (av === bv) return (a._seq as number) - (b._seq as number)
        const cmp = av < bv ? -1 : 1
        return this.orderAsc ? cmp : -cmp
      })
    }
    if (this.limitN !== null) rows = rows.slice(0, this.limitN)
    if (this.headMode) return { data: null, error: null, count: rows.length }
    return { data: rows, error: null, count: this.countMode ? rows.length : null }
  }

  async maybeSingle(): Promise<{ data: Row | null; error: PgError | null }> {
    const res = this.run()
    if (res.error) return { data: null, error: res.error }
    return { data: res.data?.[0] ?? null, error: null }
  }

  async single(): Promise<{ data: Row | null; error: PgError | null }> {
    return this.maybeSingle()
  }

  then<TResult1 = RunResult, TResult2 = never>(
    onFulfilled?: ((value: RunResult) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    try {
      const res = this.run()
      return Promise.resolve(onFulfilled ? onFulfilled(res) : (res as unknown as TResult1))
    } catch (e) {
      return onRejected ? Promise.resolve(onRejected(e)) : Promise.reject(e)
    }
  }
}

/** Construct a fresh in-memory client typed as a SupabaseClient for callers. */
export function createMockSupabase(): { client: SupabaseClient; db: MockSupabase } {
  const db = new MockSupabase()
  return { client: db as unknown as SupabaseClient, db }
}
