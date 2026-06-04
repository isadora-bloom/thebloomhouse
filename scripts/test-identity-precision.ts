#!/usr/bin/env tsx
/**
 * Unit test — identity-precision audit (battery Q36). Pure/mock, no DB.
 * Run: npx tsx scripts/test-identity-precision.ts
 */
import { loadIdentityPrecision } from '@/lib/services/intel/identity-precision'

let failures = 0
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ''}`) }
}

function mockSupabase(tables: Record<string, Record<string, unknown>[]>) {
  return {
    from(table: string) {
      const rows = (tables[table] ?? []).slice()
      const eqs: Array<[string, unknown]> = []
      const iss: Array<[string, unknown]> = []
      let inCol: string | null = null
      let inVals: unknown[] = []
      const b: Record<string, unknown> = {
        select() { return b },
        eq(k: string, v: unknown) { eqs.push([k, v]); return b },
        is(k: string, v: unknown) { iss.push([k, v]); return b },
        in(k: string, v: unknown[]) { inCol = k; inVals = v; return b },
        order() { return b },
        limit() {
          const out = rows.filter((r) =>
            eqs.every(([k, v]) => r[k] === v) &&
            iss.every(([k, v]) => (r[k] ?? null) === v) &&
            (inCol === null || inVals.includes(r[inCol as string])),
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
    couple_merge_events: [
      { venue_id: VENUE, event_type: 'candidate_confirmed', primary_couple_id: 'A', secondary_couple_id: 'B', confidence_tier: 'high', rule_triggered: 'email_exact', reason: 'r', occurred_at: '2026-05-01' },
      { venue_id: VENUE, event_type: 'partner_reconciliation', primary_couple_id: 'C', secondary_couple_id: 'D', confidence_tier: 'low', rule_triggered: 'partner_name', reason: 'r', occurred_at: '2026-05-02' },
      { venue_id: VENUE, event_type: 'channel_scoped_bridged', primary_couple_id: 'E', secondary_couple_id: 'F', confidence_tier: 'medium', rule_triggered: 'name', reason: 'r', occurred_at: '2026-05-03' },
      // NOT a fusion — must be excluded
      { venue_id: VENUE, event_type: 'couple_minted', primary_couple_id: 'G', secondary_couple_id: null, confidence_tier: 'high', rule_triggered: null, reason: 'mint', occurred_at: '2026-05-04' },
      // other venue
      { venue_id: 'other', event_type: 'candidate_confirmed', primary_couple_id: 'X', secondary_couple_id: 'Y', confidence_tier: 'high', rule_triggered: null, reason: 'r', occurred_at: '2026-05-05' },
    ],
    candidate_matches: [
      { venue_id: VENUE, primary_record_id: 'P1', primary_record_type: 'couple', secondary_record_id: 'S1', secondary_record_type: 'couple', confidence_tier: 'high', matcher_reason: 'strong name', created_at: '2026-05-10', resolved_at: null },
      { venue_id: VENUE, primary_record_id: 'P2', primary_record_type: 'couple', secondary_record_id: 'S2', secondary_record_type: 'fragment', confidence_tier: 'low', matcher_reason: 'weak', created_at: '2026-05-11', resolved_at: null },
      // resolved → excluded from suspected-same
      { venue_id: VENUE, primary_record_id: 'P3', primary_record_type: 'couple', secondary_record_id: 'S3', secondary_record_type: 'couple', confidence_tier: 'high', matcher_reason: 'x', created_at: '2026-05-12', resolved_at: '2026-05-13' },
      // other venue
      { venue_id: 'other', primary_record_id: 'PX', primary_record_type: 'couple', secondary_record_id: 'SX', secondary_record_type: 'couple', confidence_tier: 'high', matcher_reason: 'x', created_at: '2026-05-14', resolved_at: null },
    ],
  })

  const r = await loadIdentityPrecision(sb, VENUE)
  check('confidentMerges = the high-tier fusion (A&B)', r.confidentMerges.length === 1 && r.confidentMerges[0].primaryCoupleId === 'A', r.confidentMerges)
  check('weakMerges = the medium+low fusions (2), lowest-confidence first', r.weakMerges.length === 2 && r.weakMerges[0].confidenceTier === 'low', r.weakMerges)
  check('couple_minted (not a fusion) excluded from merges', ![...r.confidentMerges, ...r.weakMerges].some((m) => m.eventType === 'couple_minted'))
  check('other-venue merge excluded', ![...r.confidentMerges, ...r.weakMerges].some((m) => m.primaryCoupleId === 'X'))
  check('suspectedSamePairs = unresolved candidates (2), highest-confidence first', r.suspectedSamePairs.length === 2 && r.suspectedSamePairs[0].confidenceTier === 'high', r.suspectedSamePairs)
  check('resolved candidate excluded from suspected-same', !r.suspectedSamePairs.some((p) => p.primaryRecordId === 'P3'))
  check('other-venue candidate excluded', !r.suspectedSamePairs.some((p) => p.primaryRecordId === 'PX'))
  check('carries an explanatory note', typeof r.note === 'string' && r.note.length > 0)

  const empty = await loadIdentityPrecision(sb, '')
  check('missing venueId → honest-empty', empty.confidentMerges.length === 0 && empty.weakMerges.length === 0 && empty.suspectedSamePairs.length === 0)

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — identity-precision (Q36)`)
  process.exit(failures === 0 ? 0 : 1)
}
main()
