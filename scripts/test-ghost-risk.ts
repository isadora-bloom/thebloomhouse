#!/usr/bin/env tsx
/**
 * Unit test — ghost-risk (battery Q19: prediction WITH transparency) +
 * computeHeatBreakdown. Pure / mock — no DB.
 *
 * Run: npx tsx scripts/test-ghost-risk.ts
 */
import { computeHeatBreakdown, computeHeatScore } from '@/lib/services/identity/heat-score'
import { assessGhostRisk, loadGhostRisk } from '@/lib/services/intel/ghost-risk'

let failures = 0
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ''}`) }
}

const NOW = Date.parse('2026-06-04T00:00:00Z')
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString()

// --- computeHeatBreakdown -------------------------------------------------
{
  const b = computeHeatBreakdown(
    [
      { signal_tier: 'highest', occurred_at: daysAgo(0) },   // 100
      { signal_tier: 'low', occurred_at: daysAgo(0) },       // 5
      { signal_tier: 'aggregate_only', occurred_at: daysAgo(0) }, // excluded
    ],
    NOW,
  )
  check('breakdown score == computeHeatScore (single source)', b.score === computeHeatScore([
    { signal_tier: 'highest', occurred_at: daysAgo(0) },
    { signal_tier: 'low', occurred_at: daysAgo(0) },
    { signal_tier: 'aggregate_only', occurred_at: daysAgo(0) },
  ], NOW))
  check('aggregate_only excluded from contributions', b.contributions.every((c) => c.signalTier !== 'aggregate_only'), b.contributions)
  check('contributions sorted most-influential-first (highest before low)', b.contributions[0].signalTier === 'highest', b.contributions)
  check('14-day half-life: a highest at 14d ago ≈ 50', Math.abs(computeHeatScore([{ signal_tier: 'highest', occurred_at: daysAgo(14) }], NOW) - 50) < 0.5)
}

// --- assessGhostRisk ------------------------------------------------------
{
  // active + cold + low heat → high risk, with both signals
  const a = assessGhostRisk(
    { id: 'C1', primaryContactName: 'Ava', partnerContactName: 'Ben', lifecycleState: 'resolved', lastProgressionAt: daysAgo(150), decayWindowDays: 180 },
    [{ signal_tier: 'low', occurred_at: daysAgo(150) }],
    NOW,
  )!
  check('cold + low-heat active couple → high risk', a.riskTier === 'high', a)
  check('names joined', a.names === 'Ava & Ben')
  check('decayFraction ~0.83', a.decayFraction !== null && a.decayFraction > 0.8 && a.decayFraction < 0.86, a.decayFraction)
  check('surfaces a decay signal', a.signals.some((s) => /decay window/.test(s)), a.signals)
  check('surfaces a heat signal', a.signals.some((s) => /Heat is (cool|warm)/.test(s)), a.signals)

  // booked couple → not assessed
  check('booked couple → null (out of scope)', assessGhostRisk(
    { id: 'B', primaryContactName: 'X', partnerContactName: null, lifecycleState: 'booked', lastProgressionAt: daysAgo(150), decayWindowDays: 180 }, [], NOW,
  ) === null)

  // fresh + hot → low risk
  const fresh = assessGhostRisk(
    { id: 'F', primaryContactName: 'Hot', partnerContactName: null, lifecycleState: 'resolved', lastProgressionAt: daysAgo(2), decayWindowDays: 180 },
    [{ signal_tier: 'highest', occurred_at: daysAgo(1) }, { signal_tier: 'high', occurred_at: daysAgo(2) }],
    NOW,
  )!
  check('fresh + hot active couple → low risk', fresh.riskTier === 'low', fresh)

  // cold but still hot (recent big signal) → medium (one factor)
  const mixed = assessGhostRisk(
    { id: 'M', primaryContactName: 'Mix', partnerContactName: null, lifecycleState: 'resolved', lastProgressionAt: daysAgo(150), decayWindowDays: 180 },
    [{ signal_tier: 'highest', occurred_at: daysAgo(1) }],
    NOW,
  )!
  check('cold-but-hot → medium (single factor)', mixed.riskTier === 'medium', mixed)
}

// --- loadGhostRisk (mock) -------------------------------------------------
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
    couples: [
      { id: 'C1', venue_id: VENUE, primary_contact_name: 'Cold', partner_contact_name: null, lifecycle_state: 'resolved', last_progression_at: daysAgo(150), decay_window_days: 180, merged_into_id: null },
      { id: 'C2', venue_id: VENUE, primary_contact_name: 'Fresh', partner_contact_name: null, lifecycle_state: 'resolved', last_progression_at: daysAgo(2), decay_window_days: 180, merged_into_id: null },
      { id: 'C3', venue_id: VENUE, primary_contact_name: 'Booked', partner_contact_name: null, lifecycle_state: 'booked', last_progression_at: daysAgo(150), decay_window_days: 180, merged_into_id: null },
      { id: 'C4', venue_id: 'other', primary_contact_name: 'Other', partner_contact_name: null, lifecycle_state: 'resolved', last_progression_at: daysAgo(150), decay_window_days: 180, merged_into_id: null },
      { id: 'C5', venue_id: VENUE, primary_contact_name: 'Merged', partner_contact_name: null, lifecycle_state: 'resolved', last_progression_at: daysAgo(150), decay_window_days: 180, merged_into_id: 'C1' },
    ],
    touchpoints: [
      { couple_id: 'C1', venue_id: VENUE, signal_tier: 'low', occurred_at: daysAgo(150) },
      { couple_id: 'C2', venue_id: VENUE, signal_tier: 'highest', occurred_at: daysAgo(1) },
    ],
  })
  const risks = await loadGhostRisk(sb, VENUE, NOW)
  const ids = risks.map((r) => r.coupleId)
  check('cold C1 surfaces as at-risk', ids.includes('C1'), ids)
  check('fresh+hot C2 excluded (low risk)', !ids.includes('C2'), ids)
  check('booked C3 excluded (out of scope)', !ids.includes('C3'), ids)
  check('other-venue C4 excluded (isolation)', !ids.includes('C4'), ids)
  check('merged C5 excluded', !ids.includes('C5'), ids)
  check('empty venueId → []', (await loadGhostRisk(sb, '', NOW)).length === 0)

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ghost-risk (Q19)`)
  process.exit(failures === 0 ? 0 : 1)
}
main()
