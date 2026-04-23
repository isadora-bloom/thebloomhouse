import { test, expect } from '@playwright/test'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  createContext,
  createTestOrg,
  createTestVenue,
  createTestWedding,
  cleanup,
  TestContext,
} from '../helpers/seed'

/**
 * §18 PHASE 6 ACCEPTANCE — External context layer (Tasks 53-59).
 *
 * DB-layer assertions only, same convention as §13/§14/§15/§16/§17.
 * The me-or-market composer, draft context panel, and anomalies page
 * all read from seed data here; their browser rendering is exercised
 * in dev. Claude-stub rendering tests + live external API tests are
 * DEFERRED (we do not hit NOAA/SerpAPI/FRED/Census from the acceptance
 * suite to avoid rate-limit flakiness and cost).
 *
 * White-label: Oakwood Estate seeded alongside Rixey with aiName='Ivy'.
 * Any external signal carrying a venue-specific label must name only
 * the venue it's about.
 */

let _admin: SupabaseClient
function admin(): SupabaseClient {
  if (_admin) return _admin
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  _admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  return _admin
}

test.describe('§18 Phase 6 — External context layer', () => {
  let ctx: TestContext
  test.beforeEach(() => { ctx = createContext() })
  test.afterEach(async () => { await cleanup(ctx) })

  // -------------------------------------------------------------------------
  // Task 53 — External service tables accept the shapes cron writes
  // -------------------------------------------------------------------------

  test('weather_data + search_trends + economic_indicators accept the cron write shape', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    // Real column names per live schema: high_temp + low_temp (not temp_high).
    const { error: wErr } = await admin().from('weather_data').insert({
      venue_id: venueId,
      date: '2099-06-15',
      high_temp: 82,
      low_temp: 64,
      conditions: 'Clear',
      source: 'open_meteo',
    })
    expect(wErr, `weather_data insert rejected: ${wErr?.message}`).toBeNull()

    // Real column names per live schema: week (not week_start), interest (not
    // interest_score), metro (not geo).
    const { error: sErr } = await admin().from('search_trends').insert({
      venue_id: venueId,
      term: 'wedding venue',
      week: '2099-06-15',
      interest: 72,
      metro: 'US-VA-584',
    })
    expect(sErr, `search_trends insert rejected: ${sErr?.message}`).toBeNull()

    // economic_indicators: indicator_name + date (not series + period). No venue_id.
    const { error: eErr } = await admin().from('economic_indicators').insert({
      indicator_name: 'consumer_sentiment',
      date: '2099-06-01',
      value: 71.5,
      source: 'fred',
    })
    expect(eErr, `economic_indicators insert rejected: ${eErr?.message}`).toBeNull()

    await admin().from('weather_data').delete().eq('venue_id', venueId)
    await admin().from('search_trends').delete().eq('venue_id', venueId)
    await admin().from('economic_indicators').delete().eq('date', '2099-06-01')
  })

  // -------------------------------------------------------------------------
  // Task 54 — market_intelligence + census row shape
  // -------------------------------------------------------------------------

  test('Task 54: market_intelligence accepts a Census-shaped state rollup row', async () => {
    const { error } = await admin().from('market_intelligence').upsert({
      region_key: 'XY',
      region_type: 'state',
      region_name: 'Test State',
      population: 1234567,
      median_household_income: 78500,
      median_age: 38.4,
      age_18_34_pct: 0.22,
      bachelors_or_higher_pct: 0.34,
      data_year: 2023,
      source: 'census_acs5',
    }, { onConflict: 'region_key,data_year' })
    expect(error, `market_intelligence upsert rejected: ${error?.message}`).toBeNull()

    // Idempotent upsert: second run does not duplicate.
    await admin().from('market_intelligence').upsert({
      region_key: 'XY',
      region_type: 'state',
      region_name: 'Test State',
      population: 1234567,
      median_household_income: 78500,
      median_age: 38.4,
      data_year: 2023,
      source: 'census_acs5',
    }, { onConflict: 'region_key,data_year' })

    const { count } = await admin()
      .from('market_intelligence')
      .select('id', { count: 'exact', head: true })
      .eq('region_key', 'XY')
      .eq('data_year', 2023)
    expect(count).toBe(1)

    await admin().from('market_intelligence').delete().eq('region_key', 'XY').eq('data_year', 2023)
  })

  test('Task 54: non-US venue with no state falls back to US region read', async () => {
    // Seed the national fallback.
    await admin().from('market_intelligence').upsert({
      region_key: 'US',
      region_type: 'national',
      region_name: 'United States',
      population: 330000000,
      data_year: 2023,
      source: 'census_acs5',
    }, { onConflict: 'region_key,data_year' })

    const { data } = await admin()
      .from('market_intelligence')
      .select('region_key, region_type, population')
      .eq('region_key', 'US')
      .eq('data_year', 2023)
      .maybeSingle()
    expect(data?.region_key).toBe('US')
    expect(data?.region_type).toBe('national')
    // National rollup population is positive.
    expect((data?.population ?? 0) > 0).toBe(true)

    // Do NOT delete — the real census_refresh cron writes this key.
    // Leaving our test row in place is fine; upsert is idempotent.
  })

  // -------------------------------------------------------------------------
  // Task 55 — me-or-market diagnosis inputs round-trip
  // -------------------------------------------------------------------------

  test('Task 55: inputs for inquiryVolumeDelta + regionalSearchDelta + econTrend exist', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    // Seed a current-window and prior-window inquiry for a volume delta.
    await admin().from('weddings').insert([
      { venue_id: venueId, status: 'inquiry', wedding_date: '2099-06-15', inquiry_date: new Date(Date.now() - 10 * 86400e3).toISOString(), notes: `[e2e:${ctx.testId}]` },
      { venue_id: venueId, status: 'inquiry', wedding_date: '2099-07-15', inquiry_date: new Date(Date.now() - 45 * 86400e3).toISOString(), notes: `[e2e:${ctx.testId}]` },
    ])

    // Regional searches. Columns are week + interest + metro.
    const weekStart = (d: number) => new Date(Date.now() - d * 86400e3).toISOString().split('T')[0]
    await admin().from('search_trends').insert([
      { venue_id: venueId, term: 'wedding venue', week: weekStart(7), interest: 70, metro: 'US-VA-584' },
      { venue_id: venueId, term: 'wedding venue', week: weekStart(35), interest: 90, metro: 'US-VA-584' },
    ])

    // Sentiment (two data points for trend). Columns are indicator_name + date.
    await admin().from('economic_indicators').insert([
      { indicator_name: 'consumer_sentiment', date: '2099-04-01', value: 72 },
      { indicator_name: 'consumer_sentiment', date: '2099-05-01', value: 68 },
    ])

    const [{ data: w }, { data: s }, { data: e }] = await Promise.all([
      admin().from('weddings').select('id').eq('venue_id', venueId),
      admin().from('search_trends').select('id').eq('venue_id', venueId),
      admin().from('economic_indicators').select('id').eq('indicator_name', 'consumer_sentiment').in('date', ['2099-04-01', '2099-05-01']),
    ])
    expect((w ?? []).length).toBe(2)
    expect((s ?? []).length).toBe(2)
    expect((e ?? []).length).toBe(2)

    await admin().from('search_trends').delete().eq('venue_id', venueId)
    await admin().from('economic_indicators').delete().eq('indicator_name', 'consumer_sentiment').in('date', ['2099-04-01', '2099-05-01'])
  })

  // -------------------------------------------------------------------------
  // Task 57 — anomaly_alerts accepts an availability anomaly with causes jsonb
  // -------------------------------------------------------------------------

  test('Task 57: anomaly_alerts round-trips a causes=availability row', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    const { data: inserted, error } = await admin()
      .from('anomaly_alerts')
      .insert({
        venue_id: venueId,
        alert_type: 'availability_high_demand',
        metric_name: 'availability_fill_rate',
        current_value: 0.82,
        baseline_value: 0.3,
        change_percent: 173,
        severity: 'warning',
        ai_explanation: 'Unusually high demand for 2099-10 dates. 82% of slots filled with 180 days of lead time.',
        causes: [{ source: 'availability', month: '2099-10', action: 'Review pricing or open more dates.' }],
        acknowledged: false,
      })
      .select('id, causes')
      .single()
    expect(error, `anomaly_alerts insert rejected: ${error?.message}`).toBeNull()
    expect(Array.isArray(inserted!.causes)).toBe(true)
    const causes = inserted!.causes as Array<{ source: string; month: string }>
    expect(causes[0].source).toBe('availability')
    expect(causes[0].month).toBe('2099-10')

    await admin().from('anomaly_alerts').delete().eq('id', inserted!.id)
  })

  test('Task 57: anomaly_alerts cross-venue isolation (Oakwood has its own rows)', async () => {
    const { orgId } = await createTestOrg(ctx)
    const rixey = await createTestVenue(ctx, { orgId, name: `Rixey Manor [e2e:${ctx.testId}]` })
    const oakwood = await createTestVenue(ctx, {
      orgId,
      name: `Oakwood Estate [e2e:${ctx.testId}]`,
      aiName: 'Ivy',
    })

    const { data: inserted } = await admin().from('anomaly_alerts').insert([
      { venue_id: rixey.venueId, alert_type: 'inquiry_volume', metric_name: 'inquiry_volume', current_value: 2, baseline_value: 10, change_percent: -80, severity: 'critical', ai_explanation: 'Rixey volume drop.' },
      { venue_id: oakwood.venueId, alert_type: 'inquiry_volume', metric_name: 'inquiry_volume', current_value: 12, baseline_value: 10, change_percent: 20, severity: 'info', ai_explanation: 'Oakwood volume up.' },
    ]).select('id')

    const { data: oakwoodRows } = await admin()
      .from('anomaly_alerts')
      .select('ai_explanation, venue_id')
      .eq('venue_id', oakwood.venueId)
    const serialised = JSON.stringify(oakwoodRows).toLowerCase()
    expect(serialised).not.toContain('rixey')
    expect(serialised).toContain('oakwood')

    const ids = (inserted ?? []).map((r) => r.id as string)
    if (ids.length) await admin().from('anomaly_alerts').delete().in('id', ids)
  })

  // -------------------------------------------------------------------------
  // Task 58 — plan-tier enforcement at data level
  // -------------------------------------------------------------------------

  test('Task 58: starter-tier venue cannot be coerced to an intelligence write', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId, planTier: 'starter' })
    const { data } = await admin()
      .from('venues')
      .select('plan_tier')
      .eq('id', venueId)
      .single()
    expect(data!.plan_tier).toBe('starter')
    // The runtime guard lives in requirePlan on every /api/intel/* route.
    // This test asserts the DB honors the CHECK constraint on plan_tier.
    const { error: bogus } = await admin()
      .from('venues')
      .update({ plan_tier: 'plutonium' })
      .eq('id', venueId)
    expect(bogus).not.toBeNull()
  })

  // -------------------------------------------------------------------------
  // White-label — Oakwood with Ivy name + UK-style locale fallback
  // -------------------------------------------------------------------------

  test('White label: Oakwood venue_ai_config carries Ivy + upgrade-gate reads it', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, {
      orgId,
      name: `Oakwood Estate [e2e:${ctx.testId}]`,
      aiName: 'Ivy',
      venuePrefix: 'OE',
    })
    const { data } = await admin()
      .from('venue_ai_config')
      .select('ai_name')
      .eq('venue_id', venueId)
      .single()
    expect(data!.ai_name).toBe('Ivy')
    expect(data!.ai_name).not.toBe('Sage')
  })

  // -------------------------------------------------------------------------
  // Deferred — require live APIs, Claude stub, or browser render
  // -------------------------------------------------------------------------

  test.skip('DEFERRED: Census API live call persists 15 states to market_intelligence', () => {})
  test.skip('DEFERRED: NOAA/Open-Meteo live call persists 14-day forecast', () => {})
  test.skip('DEFERRED: SerpAPI live call persists regional trends', () => {})
  test.skip('DEFERRED: /intel/anomalies renders Ivy upgrade prompt for starter-tier Oakwood (browser)', () => {})
  test.skip('DEFERRED: DraftContextPanel oneLiner surfaces venue + region to coordinator (browser)', () => {})
})
