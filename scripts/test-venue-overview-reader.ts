#!/usr/bin/env tsx
/**
 * Unit test — getVenueOverview spine reader (Phase 3.3 canonical function).
 *
 * Verifies `loadVenueOverview` against a chainable mock client (no DB).
 * Locks:
 *   - couples counted per lifecycle, venue-scoped, merged-away excluded;
 *   - total == sum of the per-lifecycle counts;
 *   - recent activity = latest touchpoints (occurred_at desc), summary
 *     lifted from raw_payload subject/body when present;
 *   - data maturity: total count + oldest touchpoint + populated/empty flag;
 *   - venue isolation (another venue's rows never counted);
 *   - empty venue → honest-zero overview.
 *
 * Pure (mocked I/O). Run: npx tsx scripts/test-venue-overview-reader.ts
 */
import { loadVenueOverview } from '@/lib/intel/canonical'

let failures = 0
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ''}`) }
}

type Row = Record<string, unknown>
interface TableData { couples?: Row[]; touchpoints?: Row[] }

/** Chainable mock with eq/neq/is filters, order (sort), limit (slice),
 *  count (exact), maybeSingle, and thenable resolution. Returns both
 *  `data` and `count` on every terminal so head:true count queries and
 *  row queries share one path. */
function mockSupabase(data: TableData) {
  return {
    from(table: keyof TableData) {
      const rows = (data[table] ?? []).slice()
      const eqs: Array<[string, unknown]> = []
      const neqs: Array<[string, unknown]> = []
      const iss: Array<[string, unknown]> = []
      let orderCol: string | null = null
      let orderAsc = true
      const apply = () => {
        let out = rows.filter(
          (r) =>
            eqs.every(([k, v]) => r[k] === v) &&
            neqs.every(([k, v]) => r[k] !== v) &&
            iss.every(([k, v]) => (r[k] ?? null) === v),
        )
        if (orderCol) {
          const col = orderCol
          out = out.slice().sort((a, b) => {
            const av = a[col] as string | number
            const bv = b[col] as string | number
            const c = av < bv ? -1 : av > bv ? 1 : 0
            return orderAsc ? c : -c
          })
        }
        return out
      }
      const result = (limitN: number | null) => {
        const full = apply()
        return { data: limitN != null ? full.slice(0, limitN) : full, count: full.length, error: null }
      }
      const b: Record<string, unknown> = {
        select() { return b },
        eq(k: string, v: unknown) { eqs.push([k, v]); return b },
        neq(k: string, v: unknown) { neqs.push([k, v]); return b },
        is(k: string, v: unknown) { iss.push([k, v]); return b },
        order(c: string, o?: { ascending?: boolean }) { orderCol = c; orderAsc = o?.ascending !== false; return b },
        maybeSingle() { return Promise.resolve({ data: apply()[0] ?? null, error: null }) },
        limit(n: number) { return Promise.resolve(result(n)) },
        then(resolve: (v: { data: Row[]; count: number; error: null }) => unknown) {
          return Promise.resolve(result(null)).then(resolve)
        },
      }
      return b
    },
  } as never
}

const VENUE = 'venue-1'

async function main() {
  // --- Case 1: mixed venue with several lifecycles + activity -------------
  {
    const sb = mockSupabase({
      couples: [
        { id: 'A', venue_id: VENUE, lifecycle_state: 'booked', merged_into_id: null },
        { id: 'B', venue_id: VENUE, lifecycle_state: 'booked', merged_into_id: null },
        { id: 'C', venue_id: VENUE, lifecycle_state: 'resolved', merged_into_id: null },
        { id: 'D', venue_id: VENUE, lifecycle_state: 'channel_scoped', merged_into_id: null },
        { id: 'E', venue_id: VENUE, lifecycle_state: 'booked', merged_into_id: 'A' }, // merged-away → excluded
        { id: 'F', venue_id: 'other', lifecycle_state: 'booked', merged_into_id: null }, // other venue → excluded
      ],
      touchpoints: [
        { id: 'T1', venue_id: VENUE, channel: 'knot', action_type: 'knot_message', occurred_at: '2026-01-01T00:00:00Z', raw_payload: null },
        { id: 'T2', venue_id: VENUE, channel: 'gmail', action_type: 'reply', occurred_at: '2026-03-01T00:00:00Z', raw_payload: { subject: 'Re: your date' } },
        { id: 'T3', venue_id: VENUE, channel: 'web', action_type: 'calculator_submitted', occurred_at: '2026-02-01T00:00:00Z', raw_payload: null },
        { id: 'T4', venue_id: 'other', channel: 'gmail', action_type: 'reply', occurred_at: '2026-04-01T00:00:00Z', raw_payload: null },
      ],
    })
    const o = await loadVenueOverview(sb, VENUE)
    check('booked count = 2 (excludes merged + other-venue)', o.couples.byLifecycle.booked === 2, o.couples.byLifecycle)
    check('resolved count = 1', o.couples.byLifecycle.resolved === 1, o.couples.byLifecycle)
    check('channel_scoped count = 1', o.couples.byLifecycle.channel_scoped === 1, o.couples.byLifecycle)
    check('total = 4 (sum of live couples in venue)', o.couples.total === 4, o.couples)
    check('recent activity excludes other-venue touchpoint', o.recentActivity.every((a) => a.id !== 'T4'), o.recentActivity)
    check('recent activity newest-first (T2 before T3 before T1)', o.recentActivity.map((a) => a.id).join(',') === 'T2,T3,T1', o.recentActivity.map((a) => a.id))
    check('summary lifted from raw_payload subject', o.recentActivity.find((a) => a.id === 'T2')?.summary === 'Re: your date', o.recentActivity)
    check('summary falls back to channel/action when no text', o.recentActivity.find((a) => a.id === 'T1')?.summary === 'knot knot_message', o.recentActivity)
    check('dataMaturity n = 3 (venue touchpoints only)', o.dataMaturity.n === 3, o.dataMaturity)
    check('oldest touchpoint = T1 date', o.dataMaturity.oldestTouchpoint === '2026-01-01T00:00:00Z', o.dataMaturity)
    check('backfillStatus populated', o.dataMaturity.backfillStatus === 'populated', o.dataMaturity)
  }

  // --- Case 2: empty venue → honest-zero ----------------------------------
  {
    const sb = mockSupabase({ couples: [], touchpoints: [] })
    const o = await loadVenueOverview(sb, VENUE)
    check('empty venue total = 0', o.couples.total === 0, o.couples)
    check('empty venue backfillStatus = empty', o.dataMaturity.backfillStatus === 'empty' && o.dataMaturity.n === 0, o.dataMaturity)
    check('empty venue oldestTouchpoint null', o.dataMaturity.oldestTouchpoint === null)
    check('empty venue no recent activity', o.recentActivity.length === 0)
  }

  // --- Case 3: missing venueId → honest-empty, unknown maturity -----------
  {
    const sb = mockSupabase({})
    const o = await loadVenueOverview(sb, '')
    check('empty venueId → unknown backfillStatus', o.dataMaturity.backfillStatus === 'unknown' && o.couples.total === 0, o)
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — getVenueOverview spine reader`)
  process.exit(failures === 0 ? 0 : 1)
}
main()
