#!/usr/bin/env tsx
/**
 * Unit test — data-completeness self-report (battery Q30). Pure/mock, no DB.
 * Run: npx tsx scripts/test-data-completeness.ts
 */
import { loadDataCompleteness } from '@/lib/services/intel/data-completeness'

let failures = 0
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ''}`) }
}

const NOW = Date.parse('2026-06-04T00:00:00Z')
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString()

function mockSupabase(tables: Record<string, Record<string, unknown>[]>) {
  return {
    from(table: string) {
      const rows = (tables[table] ?? []).slice()
      const eqs: Array<[string, unknown]> = []
      const iss: Array<[string, unknown]> = []
      const gtes: Array<[string, string]> = []
      const b: Record<string, unknown> = {
        select() { return b },
        eq(k: string, v: unknown) { eqs.push([k, v]); return b },
        is(k: string, v: unknown) { iss.push([k, v]); return b },
        gte(k: string, v: string) { gtes.push([k, v]); return b },
        limit() {
          const out = rows.filter((r) =>
            eqs.every(([k, v]) => r[k] === v) &&
            iss.every(([k, v]) => (r[k] ?? null) === v) &&
            gtes.every(([k, v]) => String(r[k] ?? '') >= v),
          )
          return Promise.resolve({ data: out, error: null })
        },
      }
      return b
    },
  } as never
}

async function main() {
  const VENUE = 'v1'
  const sb = mockSupabase({
    couples: [
      // complete: email + a touchpoint, in window
      { id: 'A', venue_id: VENUE, primary_contact_email: 'a@x.com', primary_contact_phone: null, created_at: daysAgo(10), merged_into_id: null },
      // complete: phone + touchpoint
      { id: 'B', venue_id: VENUE, primary_contact_email: null, primary_contact_phone: '+15551234567', created_at: daysAgo(20), merged_into_id: null },
      // partial: reachable but NO touchpoint
      { id: 'C', venue_id: VENUE, primary_contact_email: 'c@x.com', primary_contact_phone: null, created_at: daysAgo(5), merged_into_id: null },
      // partial: touchpoint but NO reachable identifier
      { id: 'D', venue_id: VENUE, primary_contact_email: null, primary_contact_phone: null, created_at: daysAgo(5), merged_into_id: null },
      // out of window (older than 90d) → excluded
      { id: 'E', venue_id: VENUE, primary_contact_email: 'e@x.com', primary_contact_phone: null, created_at: daysAgo(120), merged_into_id: null },
      // other venue → excluded
      { id: 'F', venue_id: 'other', primary_contact_email: 'f@x.com', primary_contact_phone: null, created_at: daysAgo(5), merged_into_id: null },
      // merged → excluded
      { id: 'G', venue_id: VENUE, primary_contact_email: 'g@x.com', primary_contact_phone: null, created_at: daysAgo(5), merged_into_id: 'A' },
    ],
    touchpoints: [
      { couple_id: 'A', venue_id: VENUE, occurred_at: daysAgo(9) },
      { couple_id: 'B', venue_id: VENUE, occurred_at: daysAgo(19) },
      { couple_id: 'D', venue_id: VENUE, occurred_at: daysAgo(4) },
    ],
  })

  const r = await loadDataCompleteness(sb, VENUE, NOW, 90)
  check('couplesInWindow = 4 (excludes out-of-window, other-venue, merged)', r.couplesInWindow === 4, r.couplesInWindow)
  check('complete = 2 (A, B)', r.complete === 2, r.complete)
  check('partial = 2 (C, D)', r.partial === 2, r.partial)
  check('completeFraction = 0.5', r.completeFraction === 0.5, r.completeFraction)
  check('partialReasons.noTouchpoints = 1 (C)', r.partialReasons.noTouchpoints === 1, r.partialReasons)
  check('partialReasons.noReachableIdentifier = 1 (D)', r.partialReasons.noReachableIdentifier === 1, r.partialReasons)

  const empty = await loadDataCompleteness(mockSupabase({ couples: [], touchpoints: [] }), VENUE, NOW, 90)
  check('empty window → completeFraction null (never fake 0/100%)', empty.completeFraction === null && empty.couplesInWindow === 0, empty)
  check('missing venueId → honest-empty', (await loadDataCompleteness(sb, '', NOW)).couplesInWindow === 0)

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — data-completeness (Q30)`)
  process.exit(failures === 0 ? 0 : 1)
}
main()
