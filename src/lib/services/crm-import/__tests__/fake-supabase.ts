/**
 * A small in-memory stand-in for a Supabase client, enough for the
 * related-contacts → Agent path (W20). Test helper only; no network.
 *
 * It is deliberately literal rather than clever: tables are arrays of
 * plain objects, `eq` filters are the only filters, and
 * `lock_and_mint_couple` is reimplemented with the same decision order
 * as migration 366 (idempotent touchpoint check, then re-check by email,
 * then by phone, then mint). That is what lets a test assert the story
 * table by table, and what makes the planner-across-two-projects case
 * behave the way the real RPC does.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface FakeRow { [k: string]: unknown }

type PgError = { message: string; code?: string }

let seq = 0
function nextId(prefix: string): string {
  seq += 1
  return `${prefix}-${String(seq).padStart(4, '0')}`
}

export class FakeDb {
  tables: Record<string, FakeRow[]> = {}
  /** Operations to fail, keyed `<table>.<op>` e.g. 'crm_import_rows.insert'. */
  private failing = new Set<string>()
  /** Every operation attempted, in order. Useful for "nothing was written". */
  calls: string[] = []

  table(name: string): FakeRow[] {
    this.tables[name] ??= []
    return this.tables[name]!
  }

  failOn(op: string): void {
    this.failing.add(op)
  }

  shouldFail(op: string): boolean {
    return this.failing.has(op)
  }

  client(): SupabaseClient {
    return {
      from: (name: string) => new FakeQuery(this, name),
      rpc: (fn: string, params: Record<string, unknown>) =>
        Promise.resolve(this.rpc(fn, params)),
    } as unknown as SupabaseClient
  }

  private rpc(
    fn: string,
    p: Record<string, unknown>,
  ): { data: unknown; error: PgError | null } {
    this.calls.push(`rpc.${fn}`)
    if (this.shouldFail(`rpc.${fn}`)) {
      return { data: null, error: { message: `${fn} failed` } }
    }
    if (fn !== 'lock_and_mint_couple') {
      return { data: null, error: { message: `unstubbed rpc ${fn}` } }
    }

    const venueId = p.p_venue_id as string
    const channel = p.p_channel as string
    const externalId = p.p_external_id as string
    const email = ((p.p_primary_email as string | null) ?? '').toLowerCase()
    const phone = (p.p_primary_phone as string | null) ?? ''

    // (2) this exact signal already swept?
    const existingTp = this.table('touchpoints').find(
      (t) => t.venue_id === venueId && t.channel === channel && t.external_id === externalId,
    )
    if (existingTp) {
      return {
        data: [{
          couple_id: existingTp.couple_id,
          minted: false,
          touchpoint_inserted: false,
          touchpoint_id: existingTp.id,
        }],
        error: null,
      }
    }

    // (3) re-check by email then phone.
    let couple = email
      ? this.table('couples').find(
          (c) => c.venue_id === venueId
            && (String(c.primary_contact_email ?? '').toLowerCase() === email
              || String(c.partner_contact_email ?? '').toLowerCase() === email),
        )
      : undefined
    if (!couple && phone) {
      couple = this.table('couples').find(
        (c) => c.venue_id === venueId
          && (c.primary_contact_phone === phone || c.partner_contact_phone === phone),
      )
    }

    let minted = false
    if (!couple) {
      couple = {
        id: nextId('couple'),
        venue_id: venueId,
        primary_contact_name: p.p_primary_name,
        primary_contact_email: p.p_primary_email,
        primary_contact_phone: p.p_primary_phone,
        partner_contact_name: p.p_partner_name,
        wedding_date: p.p_wedding_date,
        lifecycle_state: 'channel_scoped',
        channel_scope: p.p_channel_scope,
        source_wedding_id: null,
      }
      this.table('couples').push(couple)
      minted = true
      this.table('couple_merge_events').push({
        id: nextId('cme'),
        venue_id: venueId,
        event_type: 'couple_minted',
        primary_couple_id: couple.id,
      })
    }

    const tp: FakeRow = {
      id: nextId('tp'),
      venue_id: venueId,
      couple_id: couple.id,
      channel,
      external_id: externalId,
      action_type: p.p_action_type,
      signal_tier: p.p_signal_tier,
      occurred_at: p.p_occurred_at,
      raw_payload: p.p_raw_payload,
    }
    this.table('touchpoints').push(tp)

    return {
      data: [{
        couple_id: couple.id,
        minted,
        touchpoint_inserted: true,
        touchpoint_id: tp.id,
      }],
      error: null,
    }
  }
}

class FakeQuery implements PromiseLike<{ data: unknown; error: PgError | null }> {
  private op: 'select' | 'insert' | 'upsert' | 'update' | null = null
  private filters: Array<[string, unknown]> = []
  private payload: FakeRow | FakeRow[] | null = null
  private conflictKeys: string[] = []
  private one: 'single' | 'maybeSingle' | null = null
  private cap: number | null = null

  constructor(private db: FakeDb, private name: string) {}

  select(): this { if (!this.op) this.op = 'select'; return this }
  insert(payload: FakeRow | FakeRow[]): this { this.op = 'insert'; this.payload = payload; return this }
  update(payload: FakeRow): this { this.op = 'update'; this.payload = payload; return this }
  upsert(payload: FakeRow | FakeRow[], opts?: { onConflict?: string }): this {
    this.op = 'upsert'
    this.payload = payload
    this.conflictKeys = (opts?.onConflict ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    return this
  }
  eq(col: string, val: unknown): this { this.filters.push([col, val]); return this }
  not(): this { return this }
  limit(n: number): this { this.cap = n; return this }
  single(): this { this.one = 'single'; return this }
  maybeSingle(): this { this.one = 'maybeSingle'; return this }
  order(): this { return this }

  private matching(): FakeRow[] {
    return this.db.table(this.name).filter((r) =>
      this.filters.every(([c, v]) => r[c] === v))
  }

  private run(): { data: unknown; error: PgError | null } {
    const opName = `${this.name}.${this.op ?? 'select'}`
    this.db.calls.push(opName)
    if (this.db.shouldFail(opName)) {
      return { data: null, error: { message: `${opName} failed`, code: 'XXFAIL' } }
    }

    if (this.op === 'insert' || this.op === 'upsert') {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload!]
      const written: FakeRow[] = []
      for (const r of rows) {
        if (this.op === 'upsert' && this.conflictKeys.length > 0) {
          const clash = this.db.table(this.name).find((existing) =>
            this.conflictKeys.every((k) => existing[k] === r[k]))
          if (clash) continue
        }
        const row = { id: nextId(this.name.slice(0, 6)), ...r }
        this.db.table(this.name).push(row)
        written.push(row)
      }
      if (this.one === 'single') {
        return written[0]
          ? { data: written[0], error: null }
          : { data: null, error: { message: 'no rows returned', code: 'PGRST116' } }
      }
      return { data: written, error: null }
    }

    if (this.op === 'update') {
      const rows = this.matching()
      for (const r of rows) Object.assign(r, this.payload)
      return { data: rows, error: null }
    }

    let rows = this.matching()
    if (this.cap != null) rows = rows.slice(0, this.cap)
    if (this.one === 'maybeSingle') return { data: rows[0] ?? null, error: null }
    if (this.one === 'single') {
      return rows[0]
        ? { data: rows[0], error: null }
        : { data: null, error: { message: 'no rows', code: 'PGRST116' } }
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
