/**
 * Seed helper for Playwright E2E tests.
 *
 * Uses the Supabase service role key to programmatically create orgs, venues,
 * users, and weddings. Each record is tagged with a per-run `testId` in its
 * name (e.g. `[e2e:abc123]`) so `cleanup(testId)` can remove them.
 *
 * IMPORTANT: This helper talks directly to the live Supabase project defined
 * in .env.local. Tests should always call `cleanup()` in `afterEach` or
 * `afterAll`.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import * as crypto from 'crypto'

export type Role = 'super_admin' | 'org_admin' | 'venue_manager' | 'coordinator' | 'readonly' | 'couple'

export interface TestContext {
  testId: string
  createdUserIds: string[]
  createdWeddingIds: string[]
  createdVenueIds: string[]
  createdOrgIds: string[]
  createdPeopleIds: string[]
  createdCoupleUsers: string[] // IDs on couple_users table if used
  extra: Record<string, string[]>
}

let _admin: SupabaseClient | null = null
function admin(): SupabaseClient {
  if (_admin) return _admin
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Seed helper: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing from env (.env.local not loaded?)')
  }
  _admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  return _admin
}

export function newTestId(): string {
  return crypto.randomBytes(4).toString('hex')
}

export function createContext(testId: string = newTestId()): TestContext {
  return {
    testId,
    createdUserIds: [],
    createdWeddingIds: [],
    createdVenueIds: [],
    createdOrgIds: [],
    createdPeopleIds: [],
    createdCoupleUsers: [],
    extra: {},
  }
}

export async function createTestOrg(
  ctx: TestContext,
  opts: { name?: string; isDemo?: boolean; planTier?: string } = {}
): Promise<{ orgId: string }> {
  const name = opts.name ?? `E2E Org [e2e:${ctx.testId}]`
  const { data, error } = await admin()
    .from('organisations')
    .insert({
      name,
      plan_tier: opts.planTier ?? 'intelligence',
    })
    .select('id')
    .single()
  if (error) throw new Error(`createTestOrg: ${error.message}`)
  ctx.createdOrgIds.push(data.id)
  return { orgId: data.id }
}

export async function createTestVenue(
  ctx: TestContext,
  opts: {
    orgId: string
    name?: string
    slug?: string
    planTier?: 'starter' | 'intelligence' | 'enterprise'
    status?: 'active' | 'trial' | 'suspended' | 'churned'
    /**
     * White-label assistant name for the couple portal + outbound drafts.
     * Required by the v4 Task 9 Oakwood zero-Rixey acceptance test — lets
     * a single call seed a venue with `aiName: 'Ivy'` etc. Defaults to 'Sage'.
     */
    aiName?: string
    /** 2-char client-code prefix (e.g. 'OE' for Oakwood Estate). */
    venuePrefix?: string
  }
): Promise<{ venueId: string; slug: string }> {
  const name = opts.name ?? `E2E Venue [e2e:${ctx.testId}]`
  const slug = opts.slug ?? `e2e-venue-${ctx.testId}-${Math.random().toString(36).slice(2, 6)}`
  const { data, error } = await admin()
    .from('venues')
    .insert({
      name,
      slug,
      org_id: opts.orgId,
      plan_tier: opts.planTier ?? 'intelligence',
      status: opts.status ?? 'active',
    })
    .select('id, slug')
    .single()
  if (error) throw new Error(`createTestVenue: ${error.message}`)
  ctx.createdVenueIds.push(data.id)

  // Seed minimal venue_config row (many pages assume one exists)
  const { error: cfgErr } = await admin().from('venue_config').insert({
    venue_id: data.id,
    business_name: name,
    venue_prefix: opts.venuePrefix ?? null,
  })
  if (cfgErr && !/duplicate/i.test(cfgErr.message)) {
    // Not fatal — some environments have triggers creating it already
    // but log to help debugging
    console.warn('venue_config insert warning:', cfgErr.message)
  }
  // Seed minimal venue_ai_config too
  const { error: aiErr } = await admin().from('venue_ai_config').insert({
    venue_id: data.id,
    ai_name: opts.aiName ?? 'Sage',
  })
  if (aiErr && !/duplicate/i.test(aiErr.message)) {
    console.warn('venue_ai_config insert warning:', aiErr.message)
  }

  return { venueId: data.id, slug: data.slug }
}

export async function createTestUser(
  ctx: TestContext,
  opts: {
    email?: string
    password?: string
    role: Role
    orgId?: string
    venueId?: string
    firstName?: string
    lastName?: string
  }
): Promise<{ userId: string; email: string; password: string }> {
  const email = opts.email ?? `e2e-${ctx.testId}-${opts.role}-${Math.random().toString(36).slice(2, 6)}@test.thebloomhouse.com`
  const password = opts.password ?? `TestPw!${ctx.testId}A1`

  // Create via admin API (auto-confirmed)
  const { data, error } = await admin().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { test_id: ctx.testId, role: opts.role },
  })
  if (error) {
    // If user already exists (e.g. re-running without cleanup), try to fetch
    if (/already/i.test(error.message)) {
      const { data: list } = await admin().auth.admin.listUsers()
      const existing = list?.users?.find((u) => u.email === email)
      if (existing) {
        ctx.createdUserIds.push(existing.id)
        await upsertProfile(existing.id, opts)
        return { userId: existing.id, email, password }
      }
    }
    throw new Error(`createTestUser: ${error.message}`)
  }
  const userId = data.user!.id
  ctx.createdUserIds.push(userId)
  await upsertProfile(userId, opts)
  return { userId, email, password }
}

async function upsertProfile(
  userId: string,
  opts: { role: Role; orgId?: string; venueId?: string; firstName?: string; lastName?: string }
) {
  const { error } = await admin()
    .from('user_profiles')
    .upsert(
      {
        id: userId,
        role: opts.role,
        org_id: opts.orgId ?? null,
        venue_id: opts.venueId ?? null,
        first_name: opts.firstName ?? 'E2E',
        last_name: opts.lastName ?? opts.role,
      },
      { onConflict: 'id' }
    )
  if (error) throw new Error(`upsertProfile: ${error.message}`)
}

/**
 * Creates a wedding, a couple user, and a people row linking the couple to
 * the wedding. Returns both user and wedding ids.
 */
export async function createTestWedding(
  ctx: TestContext,
  opts: {
    venueId: string
    coupleEmail?: string
    couplePassword?: string
    date?: string // ISO date
    status?: string
    guestCountEstimate?: number
    bookingValue?: number
  }
): Promise<{
  weddingId: string
  coupleUserId: string
  coupleEmail: string
  couplePassword: string
}> {
  const weddingDate = opts.date ?? new Date(Date.now() + 90 * 86400e3).toISOString().slice(0, 10)
  // 1. Wedding row
  const { data: w, error: werr } = await admin()
    .from('weddings')
    .insert({
      venue_id: opts.venueId,
      status: opts.status ?? 'booked',
      wedding_date: weddingDate,
      guest_count_estimate: opts.guestCountEstimate ?? 120,
      booking_value: opts.bookingValue ?? 18000,
      notes: `[e2e:${ctx.testId}]`,
    })
    .select('id')
    .single()
  if (werr) throw new Error(`createTestWedding (wedding): ${werr.message}`)
  const weddingId = w.id
  ctx.createdWeddingIds.push(weddingId)

  // 2. Couple user
  const { userId, email, password } = await createTestUser(ctx, {
    email: opts.coupleEmail,
    password: opts.couplePassword,
    role: 'couple',
    venueId: opts.venueId,
  })

  // 3. People row linking couple
  const { data: p, error: perr } = await admin()
    .from('people')
    .insert({
      venue_id: opts.venueId,
      wedding_id: weddingId,
      role: 'partner1',
      first_name: 'E2E',
      last_name: `Couple-${ctx.testId}`,
      email,
    })
    .select('id')
    .single()
  if (perr) {
    console.warn('createTestWedding (people):', perr.message)
  } else {
    ctx.createdPeopleIds.push(p.id)
  }

  // 4. Best-effort: associate user_profiles.wedding_id if that column exists
  // (columns may have been added in later migrations)
  try {
    await admin()
      .from('user_profiles')
      .update({ venue_id: opts.venueId })
      .eq('id', userId)
  } catch {
    // swallow
  }

  return { weddingId, coupleUserId: userId, coupleEmail: email, couplePassword: password }
}

/**
 * Best-effort teardown. Deletes in reverse-dependency order and swallows
 * missing-table / constraint errors so a test failure doesn't cascade.
 */
export async function cleanup(ctx: TestContext): Promise<void> {
  const a = admin()
  try {
    if (ctx.createdWeddingIds.length) {
      await a.from('people').delete().in('wedding_id', ctx.createdWeddingIds)
      await a.from('weddings').delete().in('id', ctx.createdWeddingIds)
    }
    if (ctx.createdPeopleIds.length) {
      await a.from('people').delete().in('id', ctx.createdPeopleIds)
    }
    if (ctx.createdUserIds.length) {
      for (const uid of ctx.createdUserIds) {
        await a.from('user_profiles').delete().eq('id', uid)
        try {
          await a.auth.admin.deleteUser(uid)
        } catch {
          /* ignore */
        }
      }
    }
    if (ctx.createdVenueIds.length) {
      await a.from('venue_config').delete().in('venue_id', ctx.createdVenueIds)
      await a.from('venue_ai_config').delete().in('venue_id', ctx.createdVenueIds)
      await a.from('venues').delete().in('id', ctx.createdVenueIds)
    }
    if (ctx.createdOrgIds.length) {
      await a.from('organisations').delete().in('id', ctx.createdOrgIds)
    }
  } catch (e) {
    console.warn('cleanup warning:', e)
  }
}

/**
 * Convenience: creates a full org → venue → coordinator → couple graph.
 */
export async function seedBasicGraph(ctx: TestContext = createContext()) {
  const { orgId } = await createTestOrg(ctx, {})
  const { venueId, slug } = await createTestVenue(ctx, { orgId })
  const coordinator = await createTestUser(ctx, {
    role: 'coordinator',
    orgId,
    venueId,
  })
  const wedding = await createTestWedding(ctx, { venueId })
  return { ctx, orgId, venueId, slug, coordinator, wedding }
}
