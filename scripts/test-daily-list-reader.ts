#!/usr/bin/env tsx
/**
 * Unit test — getDailyList spine reader (Phase 3.3 canonical function).
 *
 * Drives `loadDailyList` with a pure in-memory chainable mock (no DB).
 * SPINE-ONLY: the mock only knows `couples`, `touchpoints`, `tours`.
 * Covers: venue isolation, merged-away exclusion, each bucket's SOURCED
 * definition, empty venue, missing venueId honest-empty.
 *
 * Run: npx tsx scripts/test-daily-list-reader.ts
 */
import { loadDailyList } from '../src/lib/intel/canonical'

let pass = 0
let fail = 0
function assert(cond: boolean, label: string): void {
  if (cond) pass++
  else { fail++; console.error(`FAIL: ${label}`) }
}
function assertEq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else { fail++; console.error(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`) }
}

type Row = Record<string, unknown>
interface Filter { kind: 'eq' | 'neq' | 'in' | 'gte' | 'lte' | 'is' | 'not'; col: string; val: unknown; op?: string }

class QueryBuilder {
  private filters: Filter[] = []
  constructor(private rows: Row[]) {}
  select(_c?: string) { return this }
  eq(col: string, val: unknown) { this.filters.push({ kind: 'eq', col, val }); return this }
  neq(col: string, val: unknown) { this.filters.push({ kind: 'neq', col, val }); return this }
  in(col: string, val: unknown[]) { this.filters.push({ kind: 'in', col, val }); return this }
  gte(col: string, val: unknown) { this.filters.push({ kind: 'gte', col, val }); return this }
  lte(col: string, val: unknown) { this.filters.push({ kind: 'lte', col, val }); return this }
  is(col: string, val: unknown) { this.filters.push({ kind: 'is', col, val }); return this }
  not(col: string, op: string, val: unknown) { this.filters.push({ kind: 'not', col, op, val }); return this }
  order(col: string, opts?: { ascending?: boolean }) {
    const asc = opts?.ascending ?? true
    this.rows = [...this.rows].sort((a, b) => {
      const av = String(a[col] ?? ''); const bv = String(b[col] ?? '')
      if (av === bv) return 0
      return (av < bv ? -1 : 1) * (asc ? 1 : -1)
    })
    return this
  }
  limit(_n: number) { return this }
  private apply(): Row[] {
    return this.rows.filter((r) =>
      this.filters.every((f) => {
        const cell = r[f.col]
        switch (f.kind) {
          case 'eq': return cell === f.val
          case 'neq': return cell !== f.val
          case 'in': return (f.val as unknown[]).includes(cell)
          case 'gte': return String(cell) >= String(f.val)
          case 'lte': return String(cell) <= String(f.val)
          // DB semantics: a missing column reads as NULL, so treat
          // undefined as null for `.is(col, null)`.
          case 'is': return f.val === null ? cell == null : cell === f.val
          case 'not': if (f.op === 'is' && f.val === null) return cell != null; return true
          default: return true
        }
      }),
    )
  }
  then(resolve: (v: { data: Row[]; error: null }) => void) { resolve({ data: this.apply(), error: null }) }
}

function mockSupabase(tables: Record<string, Row[]>) {
  return { from(table: string) { return new QueryBuilder(tables[table] ?? []) } } as unknown as Parameters<typeof loadDailyList>[0]
}

const VENUE = 'venue-A'
const OTHER = 'venue-B'
const nowMs = Date.now()
const iso = (msAgo: number) => new Date(nowMs - msAgo).toISOString()
const isoAhead = (msAhead: number) => new Date(nowMs + msAhead).toISOString()
const DAY = 86_400_000

const couples: Row[] = [
  { id: 'c-needsreply', venue_id: VENUE, primary_contact_name: 'Ava', partner_contact_name: 'Ben', lifecycle_state: 'resolved', last_progression_at: iso(2 * DAY), decay_window_days: 180, heat_score: null, source_wedding_id: null },
  { id: 'c-cold', venue_id: VENUE, primary_contact_name: 'Cara', partner_contact_name: null, lifecycle_state: 'resolved', last_progression_at: iso(150 * DAY), decay_window_days: 180, heat_score: null, source_wedding_id: null },
  { id: 'c-fresh', venue_id: VENUE, primary_contact_name: 'Dan', partner_contact_name: null, lifecycle_state: 'resolved', last_progression_at: iso(10 * DAY), decay_window_days: 180, heat_score: null, source_wedding_id: null },
  { id: 'c-hot', venue_id: VENUE, primary_contact_name: 'Erin', partner_contact_name: 'Finn', lifecycle_state: 'resolved', last_progression_at: iso(1 * DAY), decay_window_days: 180, heat_score: 120, source_wedding_id: null },
  { id: 'c-tour', venue_id: VENUE, primary_contact_name: 'Gina', partner_contact_name: 'Hugo', lifecycle_state: 'booked', last_progression_at: iso(3 * DAY), decay_window_days: 180, heat_score: 200, source_wedding_id: 'wed-1' },
  // merged-away couple (mig 379) — high heat but must be EXCLUDED everywhere.
  { id: 'c-merged', venue_id: VENUE, primary_contact_name: 'Mary', partner_contact_name: null, lifecycle_state: 'resolved', last_progression_at: iso(150 * DAY), decay_window_days: 180, heat_score: 999, source_wedding_id: null, merged_into_id: 'c-hot' },
  // OTHER venue couple — must never appear
  { id: 'c-other', venue_id: OTHER, primary_contact_name: 'Zed', partner_contact_name: null, lifecycle_state: 'resolved', last_progression_at: iso(2 * DAY), decay_window_days: 180, heat_score: 500, source_wedding_id: 'wed-other' },
]

const touchpoints: Row[] = [
  { couple_id: 'c-needsreply', venue_id: VENUE, channel: 'gmail', action_type: 'sent', signal_tier: 'high', occurred_at: iso(3 * DAY) },
  { couple_id: 'c-needsreply', venue_id: VENUE, channel: 'gmail', action_type: 'reply', signal_tier: 'high', occurred_at: iso(2 * DAY) },
  { couple_id: 'c-fresh', venue_id: VENUE, channel: 'gmail', action_type: 'reply', signal_tier: 'high', occurred_at: iso(11 * DAY) },
  { couple_id: 'c-fresh', venue_id: VENUE, channel: 'gmail', action_type: 'sent', signal_tier: 'high', occurred_at: iso(10 * DAY) },
  { couple_id: 'c-other', venue_id: OTHER, channel: 'gmail', action_type: 'reply', signal_tier: 'high', occurred_at: iso(1 * DAY) },
]

const tours: Row[] = [
  { id: 't-thisweek', venue_id: VENUE, wedding_id: 'wed-1', scheduled_at: isoAhead(3 * DAY), outcome: null },
  { id: 't-cancelled', venue_id: VENUE, wedding_id: 'wed-1', scheduled_at: isoAhead(2 * DAY), outcome: 'cancelled' },
  { id: 't-future', venue_id: VENUE, wedding_id: 'wed-1', scheduled_at: isoAhead(30 * DAY), outcome: null },
  { id: 't-other', venue_id: OTHER, wedding_id: 'wed-other', scheduled_at: isoAhead(1 * DAY), outcome: null },
]

async function run() {
  const r = await loadDailyList(mockSupabase({ couples, touchpoints, tours }), VENUE)

  assertEq(r.needsReply.map((c) => c.id).sort(), ['c-needsreply'], 'needsReply = only couple whose latest touchpoint is inbound')
  assertEq(r.needsReply.find((c) => c.id === 'c-needsreply')?.names, 'Ava & Ben', 'needsReply names join primary & partner')

  assertEq(r.goingCold.map((c) => c.id).sort(), ['c-cold'], 'goingCold = past 0.75*window but < window')
  assert(!r.goingCold.some((c) => c.id === 'c-fresh'), 'goingCold excludes a recently-progressed couple')

  assertEq(r.toursThisWeek.map((t) => t.id).sort(), ['t-thisweek'], 'toursThisWeek = only non-cancelled tour in [now, now+7d]')
  assertEq(r.toursThisWeek.find((t) => t.id === 't-thisweek')?.coupleId, 'c-tour', 'tour resolves via wedding_id -> source_wedding_id')

  assert(r.highIntent.some((c) => c.id === 'c-hot'), 'highIntent includes a couple above the hot bar (cached heat)')
  assert(r.highIntent[0]?.id === 'c-tour', 'highIntent ranked by heat desc (200 before 120)')

  // merged-away exclusion (the filter added on top of Agent A's base)
  const everyId = [...r.needsReply, ...r.goingCold, ...r.highIntent].map((c) => c.id)
  assert(!everyId.includes('c-merged'), 'merged-away couple (merged_into_id set) excluded from all buckets despite heat 999')

  // venue isolation
  assert(!everyId.includes('c-other'), 'venue isolation: OTHER-venue couple absent')
  assert(!r.toursThisWeek.some((t) => t.coupleId === 'c-other' || t.id === 't-other'), 'venue isolation: OTHER-venue tour absent')

  assert(typeof r.generatedAt === 'string' && r.generatedAt.length > 0, 'generatedAt is an ISO string')

  const emptyR = await loadDailyList(mockSupabase({ couples: [], touchpoints: [], tours: [] }), 'venue-empty')
  assertEq([emptyR.needsReply.length, emptyR.goingCold.length, emptyR.toursThisWeek.length, emptyR.highIntent.length], [0, 0, 0, 0], 'empty venue → all-empty buckets')

  const missingR = await loadDailyList(mockSupabase({ couples, touchpoints, tours }), '')
  assertEq([missingR.needsReply.length, missingR.goingCold.length, missingR.toursThisWeek.length, missingR.highIntent.length], [0, 0, 0, 0], 'missing venueId → honest-empty')
}

run()
  .then(() => { console.log(`\n${pass} passed, ${fail} failed`); if (fail > 0) process.exit(1) })
  .catch((err) => { console.error('test harness error:', err); process.exit(1) })
