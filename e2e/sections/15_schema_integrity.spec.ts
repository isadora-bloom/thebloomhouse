import { test, expect } from '@playwright/test'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import * as fs from 'fs'
import * as path from 'path'
import { createContext, createTestOrg, createTestVenue, cleanup, TestContext } from '../helpers/seed'

/**
 * §15 SCHEMA & CONSTRAINT INTEGRITY
 *
 * Pure DB-level (and one filesystem-level) assertions that BUG-01/02/03/04/05/06/09
 * fixes from migrations 051/052 (and earlier) are in effect. No browser needed.
 *
 * Desktop project only — these tests don't render UI so running them twice is wasteful.
 */

// Service-role client for direct DB reads/writes (bypasses RLS).
let admin: SupabaseClient
function getAdmin(): SupabaseClient {
  if (admin) return admin
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('§15: env missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  return admin
}

// DB-only — we run this spec via the desktop project since there's no UI to exercise.
// The mobile project can re-run it safely but it's redundant.
test.describe('§15 Schema & Constraint Integrity', () => {
  let ctx: TestContext

  test.beforeEach(() => {
    ctx = createContext()
  })

  test.afterEach(async () => {
    await cleanup(ctx)
  })

  test('BUG-01: venues.plan_tier rejects "free" (CHECK constraint)', async () => {
    const { orgId } = await createTestOrg(ctx)
    const a = getAdmin()

    // Attempt an insert with an invalid plan_tier. Should fail at DB level.
    const { data, error } = await a
      .from('venues')
      .insert({
        name: `E2E Venue Invalid [e2e:${ctx.testId}]`,
        slug: `e2e-invalid-${ctx.testId}`,
        org_id: orgId,
        plan_tier: 'free',
        status: 'active',
      })
      .select('id')
      .single()

    if (data?.id) {
      // If it somehow went through, clean it up and fail the test
      ctx.createdVenueIds.push(data.id)
      throw new Error('BUG-01 regression: plan_tier="free" was accepted on venues insert')
    }

    expect(error).toBeTruthy()
    // Postgres check constraint errors surface as something like
    //   "new row for relation \"venues\" violates check constraint ..."
    expect(error!.message.toLowerCase()).toMatch(/check|constraint|invalid|plan_tier/)
  })

  test('BUG-02: venues.stripe_subscription_id column exists', async () => {
    const a = getAdmin()

    // Pull one row (or zero) selecting the column. If the column is missing,
    // PostgREST returns a 42703 error. If present, we get rows (possibly empty).
    const { error } = await a.from('venues').select('id, stripe_subscription_id, stripe_customer_id').limit(1)

    expect(error).toBeNull()
  })

  test('BUG-03: weather_data has unique (venue_id, date, source)', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })
    const a = getAdmin()

    const rowBase = {
      venue_id: venueId,
      date: '2026-06-01',
      source: 'noaa',
      high_temp: 80,
      low_temp: 60,
    }

    const { error: firstErr } = await a.from('weather_data').insert(rowBase)
    expect(firstErr).toBeNull()

    // Second identical row should violate uniqueness
    const { error: secondErr } = await a.from('weather_data').insert(rowBase)
    expect(secondErr).toBeTruthy()
    expect(secondErr!.message.toLowerCase()).toMatch(/duplicate|unique|conflict/)

    // Cleanup the row we inserted
    await a.from('weather_data').delete().eq('venue_id', venueId)
  })

  test('BUG-04: search_trends has unique (metro, term, week)', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })
    const a = getAdmin()
    const tag = ctx.testId
    const base = {
      venue_id: venueId,
      metro: `e2e-metro-${tag}`,
      term: `e2e-term-${tag}`,
      week: '2026-04-13',
      interest: 50,
    }

    const { error: firstErr } = await a.from('search_trends').insert(base)
    expect(firstErr).toBeNull()

    const { error: secondErr } = await a.from('search_trends').insert(base)
    expect(secondErr).toBeTruthy()
    expect(secondErr!.message.toLowerCase()).toMatch(/duplicate|unique|conflict/)

    await a.from('search_trends').delete().eq('metro', base.metro).eq('term', base.term)
  })

  test('BUG-05: economic_indicators has unique (indicator_name, date)', async () => {
    const a = getAdmin()
    const name = `e2e-indicator-${ctx.testId}`
    const base = {
      indicator_name: name,
      date: '2026-04-01',
      value: 1.23,
    }

    const { error: firstErr } = await a.from('economic_indicators').insert(base)
    expect(firstErr).toBeNull()

    const { error: secondErr } = await a.from('economic_indicators').insert(base)
    expect(secondErr).toBeTruthy()
    expect(secondErr!.message.toLowerCase()).toMatch(/duplicate|unique|conflict/)

    await a.from('economic_indicators').delete().eq('indicator_name', name)
  })

  test('BUG-06: no src/ file reads/writes the legacy "budget" table', async () => {
    // Filesystem assertion — BUG-06 says all reads were moved to budget_items.
    // Regex: .from('budget')  where the next char is a ) or space or ', NOT _items.
    const srcRoot = path.join(process.cwd(), 'src')
    expect(fs.existsSync(srcRoot)).toBe(true)

    const offenders: { file: string; line: number; text: string }[] = []
    const legacyTableRe = /\.from\(\s*['"]budget['"]\s*\)/

    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.next') continue
          walk(full)
        } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
          const content = fs.readFileSync(full, 'utf8')
          if (!legacyTableRe.test(content)) continue
          const lines = content.split(/\r?\n/)
          lines.forEach((ln, i) => {
            if (legacyTableRe.test(ln)) {
              offenders.push({ file: full, line: i + 1, text: ln.trim() })
            }
          })
        }
      }
    }
    walk(srcRoot)

    // The legacy `budget` table is allowed ONLY in migration scripts, not in
    // src/. If any show up we've regressed BUG-06.
    if (offenders.length > 0) {
      const msg = offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n')
      throw new Error(`BUG-06 regression — legacy .from('budget') references found:\n${msg}`)
    }
    expect(offenders.length).toBe(0)
  })

  test('BUG-09: user_profiles.role accepts "readonly"', async () => {
    const a = getAdmin()

    // Create a raw auth user and upsert a user_profiles row with role=readonly.
    const email = `e2e-bug09-${ctx.testId}-${Math.random().toString(36).slice(2, 6)}@test.thebloomhouse.com`
    const { data: userData, error: userErr } = await a.auth.admin.createUser({
      email,
      password: `TestPw!${ctx.testId}A1`,
      email_confirm: true,
    })
    expect(userErr).toBeNull()
    const userId = userData!.user!.id
    ctx.createdUserIds.push(userId)

    const { error } = await a.from('user_profiles').upsert(
      {
        id: userId,
        role: 'readonly',
        first_name: 'E2E',
        last_name: 'readonly',
      },
      { onConflict: 'id' }
    )
    expect(error).toBeNull()

    // Confirm the row persisted with role=readonly
    const { data: rows, error: readErr } = await a
      .from('user_profiles')
      .select('id, role')
      .eq('id', userId)
      .single()
    expect(readErr).toBeNull()
    expect(rows!.role).toBe('readonly')
  })
})
