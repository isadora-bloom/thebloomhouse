#!/usr/bin/env tsx
/**
 * Unit test — getCoupleJourney spine reader (Phase 3.3 canonical function).
 *
 * Verifies `loadCoupleJourney` reads ONLY the spine and shapes the
 * CoupleJourney contract correctly, WITHOUT a database (chainable mock
 * client). Locks:
 *   - venue isolation: a couple in another venue → honest-empty (couple:null);
 *   - a merged-away couple (merged_into_id set) → honest-empty;
 *   - ribbon shaped from touchpoints in occurred_at order, cascade_stage /
 *     cascade_reason lifted from raw_payload (null when absent);
 *   - progression + Wave-4 profile folded in;
 *   - look-alike cohort = same lifecycle, excludes self, ranked by
 *     wedding-date proximity, capped at 6.
 *
 * Pure (mocked I/O). Run: npx tsx scripts/test-couple-journey-reader.ts
 */
import { loadCoupleJourney } from '@/lib/intel/canonical'

let failures = 0
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ''}`) }
}

type Row = Record<string, unknown>
interface TableData {
  couples?: Row[]
  touchpoints?: Row[]
  couple_progression_events?: Row[]
  couple_identity_profile?: Row[]
}

/** Chainable mock supabase. Each .from(table) builds a filter set, then
 *  resolves via maybeSingle() or by being awaited (.limit/.order tail).
 *  Filtering supports eq/neq/is against the seeded rows. */
function mockSupabase(data: TableData) {
  return {
    from(table: keyof TableData) {
      const rows = (data[table] ?? []).slice()
      const eqs: Array<[string, unknown]> = []
      const neqs: Array<[string, unknown]> = []
      const iss: Array<[string, unknown]> = []
      const apply = () =>
        rows.filter(
          (r) =>
            eqs.every(([k, v]) => r[k] === v) &&
            neqs.every(([k, v]) => r[k] !== v) &&
            iss.every(([k, v]) => (r[k] ?? null) === v),
        )
      const b: Record<string, unknown> = {
        select() { return b },
        eq(k: string, v: unknown) { eqs.push([k, v]); return b },
        neq(k: string, v: unknown) { neqs.push([k, v]); return b },
        is(k: string, v: unknown) { iss.push([k, v]); return b },
        order() { return b },
        maybeSingle() { return Promise.resolve({ data: apply()[0] ?? null, error: null }) },
        limit() { return Promise.resolve({ data: apply(), error: null }) },
        // PostgREST builders are thenable — a query that ends in .order()
        // (the progression read) is awaited directly, no terminal .limit().
        then(resolve: (v: { data: Row[]; error: null }) => unknown) {
          return Promise.resolve({ data: apply(), error: null }).then(resolve)
        },
      }
      return b
    },
  } as never
}

const VENUE = 'venue-1'

async function main() {
  // --- Case 1: full journey for a real couple ------------------------------
  {
    const sb = mockSupabase({
      couples: [
        { id: 'C1', venue_id: VENUE, primary_contact_name: 'Sarah & James', lifecycle_state: 'booked', heat_score: 88, wedding_date: '2026-09-12', source_wedding_id: 'W1', merged_into_id: null },
        // same-venue same-lifecycle peers (look-alike candidates)
        { id: 'C2', venue_id: VENUE, primary_contact_name: 'Mia & Tom', lifecycle_state: 'booked', wedding_date: '2026-09-20', source_wedding_id: null, merged_into_id: null, created_at: '2026-02-01' },
        { id: 'C3', venue_id: VENUE, primary_contact_name: 'Far Away', lifecycle_state: 'booked', wedding_date: '2027-06-01', source_wedding_id: null, merged_into_id: null, created_at: '2026-03-01' },
        { id: 'C4', venue_id: VENUE, primary_contact_name: 'Merged Peer', lifecycle_state: 'booked', wedding_date: '2026-09-13', merged_into_id: 'C1', created_at: '2026-01-01' },
        { id: 'C5', venue_id: 'other-venue', primary_contact_name: 'Other Tenant', lifecycle_state: 'booked', wedding_date: '2026-09-12', merged_into_id: null, created_at: '2026-01-01' },
      ],
      touchpoints: [
        { id: 'T2', couple_id: 'C1', channel: 'gmail', action_type: 'reply', occurred_at: '2026-03-10T10:00:00Z', raw_payload: { subject: 'hi' } },
        { id: 'T1', couple_id: 'C1', channel: 'knot', action_type: 'knot_message', occurred_at: '2026-03-01T10:00:00Z', raw_payload: { cascade_stage: 'knot_person_id_match', cascade_reason: 'knot_person_id:tara.s.2.1' } },
      ],
      couple_progression_events: [
        { couple_id: 'C1', event_type: 'tour_booked', occurred_at: '2026-03-15T10:00:00Z' },
      ],
      couple_identity_profile: [
        { wedding_id: 'W1', profile: { archetype: 'destination' } },
      ],
    })
    const j = await loadCoupleJourney(sb, VENUE, 'C1')
    check('couple identity populated', j.couple?.id === 'C1' && j.couple?.names === 'Sarah & James', j.couple)
    check('heat + lifecycle mapped', j.couple?.heatScore === 88 && j.couple?.lifecycle === 'booked', j.couple)
    check('ribbon length = 2', j.ribbon.length === 2, j.ribbon.length)
    check('cascade_stage lifted from raw_payload', j.ribbon.find((r) => r.id === 'T1')?.cascadeStage === 'knot_person_id_match', j.ribbon)
    check('cascade_stage null when absent', j.ribbon.find((r) => r.id === 'T2')?.cascadeStage === null, j.ribbon)
    check('progression folded in', j.progression.length === 1 && j.progression[0].eventType === 'tour_booked', j.progression)
    check('Wave-4 profile folded in via source_wedding_id', (j.identityProfile as Record<string, unknown> | null)?.archetype === 'destination', j.identityProfile)
    // look-alike: excludes self (C1), merged (C4), other venue (C5);
    // ranks C2 (8d away) before C3 (~9mo away).
    const ids = j.lookAlikeCohort.map((r) => r.id)
    check('look-alike excludes self / merged / other-venue', !ids.includes('C1') && !ids.includes('C4') && !ids.includes('C5'), ids)
    check('look-alike ranks nearest wedding-date first (C2 before C3)', ids.indexOf('C2') >= 0 && (ids.indexOf('C3') === -1 || ids.indexOf('C2') < ids.indexOf('C3')), ids)
  }

  // --- Case 2: venue isolation → honest-empty ------------------------------
  {
    const sb = mockSupabase({ couples: [{ id: 'C1', venue_id: 'other-venue', primary_contact_name: 'X', lifecycle_state: 'booked', merged_into_id: null }] })
    const j = await loadCoupleJourney(sb, VENUE, 'C1')
    check('couple in another venue → couple:null', j.couple === null, j.couple)
    check('empty journey arrays', j.ribbon.length === 0 && j.progression.length === 0 && j.lookAlikeCohort.length === 0)
  }

  // --- Case 3: merged-away couple → honest-empty ---------------------------
  {
    const sb = mockSupabase({ couples: [{ id: 'C1', venue_id: VENUE, primary_contact_name: 'X', lifecycle_state: 'booked', merged_into_id: 'CWINNER' }] })
    const j = await loadCoupleJourney(sb, VENUE, 'C1')
    check('merged-away couple → couple:null (follow the pointer upstream)', j.couple === null, j.couple)
  }

  // --- Case 4: missing args → honest-empty, no query -----------------------
  {
    const sb = mockSupabase({})
    const j = await loadCoupleJourney(sb, '', 'C1')
    check('empty venueId → honest-empty', j.couple === null && j.ribbon.length === 0)
  }

  // --- Case 5: couple with no profile link → null profile, still renders ----
  {
    const sb = mockSupabase({
      couples: [{ id: 'C9', venue_id: VENUE, primary_contact_name: 'No Profile', lifecycle_state: 'resolved', heat_score: null, wedding_date: null, source_wedding_id: null, merged_into_id: null }],
      touchpoints: [{ id: 'T9', couple_id: 'C9', channel: 'web', action_type: 'calculator_submitted', occurred_at: '2026-04-01T10:00:00Z', raw_payload: null }],
    })
    const j = await loadCoupleJourney(sb, VENUE, 'C9')
    check('renders ribbon with null profile + null heat', j.couple?.id === 'C9' && j.identityProfile === null && j.ribbon.length === 1, j)
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — getCoupleJourney spine reader`)
  process.exit(failures === 0 ? 0 : 1)
}
main()
