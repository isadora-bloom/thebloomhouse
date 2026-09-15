import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { verifyDemoToken, DEMO_TOKEN_COOKIE } from '@/lib/services/demo-token'
import { isPlatformRole } from '@/lib/auth/roles'

// ---------------------------------------------------------------------------
// Demo mode constants — used when bloom_demo cookie is set
// ---------------------------------------------------------------------------

const DEMO_VENUE_ID = '22222222-2222-2222-2222-222222222201' // Hawthorne Manor
const DEMO_USER_ID = '33333333-3333-3333-3333-333333333301' // Sarah Chen

// Chloe & Ryan. Was 'ab000000-0000-0000-0000-000000000001' — a leftover id
// from an earlier seed generation that no `weddings` row has been created
// under since at least supabase/seed.sql's current form (migrations 030 and
// 036 reference that id as already-existing, never creating it; nothing in
// the repo does). Every couple-portal seed file (seed.sql, seed-couple-
// portal.sql, seed-chloe-ryan-fill.sql, PASTE-COUPLE-PORTAL-SEED.sql) keys
// off 44444444-4444-4444-4444-444444000109 instead. With the old id, every
// wedding_id-scoped couple-portal query (checklist, budget, timeline, guest
// list, ...) queried a row that doesn't exist and always got 0 back —
// found 2026-09-08, NOVEMBER-PLAN.md W4 finding 1. See also the patch note
// for src/lib/hooks/use-couple-context.ts (owned by another workstream,
// carries the same stale id at line ~36).
const DEMO_WEDDING_ID = '44444444-4444-4444-4444-444444000109' // Chloe & Ryan

/**
 * Crestwood Collection — the 4 demo venues a `bloom_demo=true` cookie may
 * legitimately request. Anything outside this set is a real production
 * venue and must be refused, even in demo mode. Pre-fix the demo cookie
 * was an open authz bypass on the insights endpoints — anyone could
 * trigger LLM spend on real venues by passing their UUID. The
 * cost-ceiling caps damage but still bills. (#85, T5-followup-CC.)
 *
 * UUIDs sourced from supabase/seed.sql. Hardcoded rather than queried at
 * request time so the allowlist is auditable in code review and there's
 * no DB round-trip per request.
 */
export const DEMO_VENUE_ALLOWLIST: ReadonlySet<string> = new Set([
  '22222222-2222-2222-2222-222222222201', // Hawthorne Manor
  '22222222-2222-2222-2222-222222222202', // Crestwood Farm
  '22222222-2222-2222-2222-222222222203', // The Glass House
  '22222222-2222-2222-2222-222222222204', // Rose Hill Gardens
])

/**
 * Returns true if the supplied venueId is in the Crestwood demo set.
 * Use in any route that takes a caller-supplied venue/wedding id while
 * in demo mode.
 */
export function isDemoVenueAllowed(venueId: string | null | undefined): boolean {
  return !!venueId && DEMO_VENUE_ALLOWLIST.has(venueId)
}

/**
 * Check if the current request is in demo mode via HMAC-signed token.
 * The legacy `bloom_demo=true` string value is never trusted here.
 */
export async function isDemoMode(): Promise<boolean> {
  const cookieStore = await cookies()
  return verifyDemoToken(cookieStore.get(DEMO_TOKEN_COOKIE)?.value).ok
}

// ---------------------------------------------------------------------------
// Platform auth — coordinator, manager, admin
// Returns: { userId, venueId, role, isDemo } or null
// ---------------------------------------------------------------------------

export async function getPlatformAuth() {
  // In demo mode, bypass auth and return demo coordinator
  if (await isDemoMode()) {
    return { userId: DEMO_USER_ID, venueId: DEMO_VENUE_ID, orgId: null as string | null, role: 'coordinator', isDemo: true }
  }

  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const service = createServiceClient()
  const { data: profile } = await service
    .from('user_profiles')
    .select('venue_id, org_id, role')
    .eq('id', user.id)
    .single()

  if (!profile) return null

  // The admitted set lives in src/lib/auth/roles.ts, next to the DB
  // CHECK it mirrors. This line used to carry its own list with a role
  // name that does not exist ('manager') and without the one that does
  // ('venue_manager'), which locked every venue manager out of the API.
  if (!isPlatformRole(profile.role)) return null

  // Venue-scoped roles (coordinator, manager) MUST have a venue_id. For
  // org-level roles (org_admin, super_admin), we fall back to the first
  // venue in their org so they can log in even before picking a venue.
  let venueId = profile.venue_id as string | null
  const isAdmin = profile.role === 'org_admin' || profile.role === 'super_admin'
  if (!venueId) {
    if (!isAdmin) return null
    if (profile.org_id) {
      const { data: firstVenue } = await service
        .from('venues')
        .select('id')
        .eq('org_id', profile.org_id as string)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()
      venueId = (firstVenue?.id as string | undefined) ?? null
    }
    // Admin with no venues at all — return null so the caller redirects to
    // /setup. Client-side dashboard guard already handles this.
    if (!venueId) return null
  }

  return {
    userId: user.id,
    venueId: venueId as string,
    orgId: (profile.org_id as string | null) ?? null,
    role: profile.role as string,
    isDemo: false,
  }
}

// ---------------------------------------------------------------------------
// Couple auth — couples accessing their portal
// Returns: { userId, venueId, weddingId, isDemo } or null
// ---------------------------------------------------------------------------

export async function getCoupleAuth() {
  // In demo mode, bypass auth and return demo couple
  if (await isDemoMode()) {
    return { userId: DEMO_USER_ID, venueId: DEMO_VENUE_ID, weddingId: DEMO_WEDDING_ID, isDemo: true }
  }

  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const service = createServiceClient()
  const { data: profile } = await service
    .from('user_profiles')
    .select('venue_id, role, wedding_id')
    .eq('id', user.id)
    .single()

  if (!profile?.venue_id || !profile?.wedding_id) return null
  if (profile.role !== 'couple') return null

  return {
    userId: user.id,
    venueId: profile.venue_id as string,
    weddingId: profile.wedding_id as string,
    isDemo: false,
  }
}

// ---------------------------------------------------------------------------
// assertCanAccessVenue — venue-scope guard for routes that operate
// against a caller-supplied venueId (or one derived from a fetched
// row). Closes the org_admin cross-venue bypass flagged by the round-1
// + round-2 audits:
//
// > In event-feedback / quick-add / thread-lock / auto-send-cancel /
// > invite-couple, super_admin and org_admin are allowed to operate
// > against any venue regardless of org membership. The routes use
// > createServiceClient() which bypasses RLS, so the comment's
// > "RLS will catch it downstream" reassurance is wrong-shaped.
//
// Behaviour:
//   - Demo cookie: venueId must be in DEMO_VENUE_ALLOWLIST (Crestwood).
//   - super_admin: all venues allowed (platform team).
//   - org_admin / venue_manager / coordinator: venueId must equal
//     auth.venueId OR be in the user's org's set of venues.
//   - couple role: not callable here — couples should use
//     getCoupleAuth + their wedding's venue_id.
//
// Returns ok=true with the resolved canonical venueId, or ok=false
// with a 403 reason. Callers translate to a NextResponse.
// ---------------------------------------------------------------------------

// Round-3 follow-up #92: removed `venueId` from the ok branch. It was
// always identical to the input parameter passed into assertCanAccessVenue
// (every code path either returned the input, or returned ok:false). Real
// ghost data — readers were spelunking `decision.venueId` even though the
// caller already had the value in scope. Now { ok: true } only; consumers
// keep using their original venueId variable.
export type AccessDecision =
  | { ok: true }
  | { ok: false; reason: string }

type PlatformAuth = NonNullable<Awaited<ReturnType<typeof getPlatformAuth>>>

export async function assertCanAccessVenue(
  auth: PlatformAuth,
  venueId: string,
): Promise<AccessDecision> {
  if (!venueId || typeof venueId !== 'string') {
    return { ok: false, reason: 'venueId required' }
  }

  if (auth.isDemo) {
    if (!DEMO_VENUE_ALLOWLIST.has(venueId)) {
      return { ok: false, reason: 'venue access denied' }
    }
    return { ok: true }
  }

  // super_admin first so platform-team accesses are distinguishable
  // from "happens to match my home venue" if we ever add audit logging
  // on the bypass path. Per round-3 audit ordering note.
  if (auth.role === 'super_admin') {
    return { ok: true }
  }

  if (venueId === auth.venueId) {
    return { ok: true }
  }

  if (auth.role === 'org_admin') {
    if (!auth.orgId) {
      // Data-corruption signal: an org_admin without an orgId
      // shouldn't exist in normal flows. Log it loudly so ops can
      // find the bad row.
      console.warn('[assertCanAccessVenue] org_admin user has null orgId', {
        userId: auth.userId,
        attemptedVenueId: venueId,
      })
      return { ok: false, reason: 'venue access denied' }
    }
    // Verify the target venue is within the admin's org. Service-role
    // query — we want truth, not RLS-filtered.
    const service = createServiceClient()
    const { data: targetVenue } = await service
      .from('venues')
      .select('org_id')
      .eq('id', venueId)
      .maybeSingle()
    // Per round-3 audit: collapse "not found" vs "belongs to another
    // org" to a single response so an authenticated org_admin can't
    // probe UUIDs to distinguish the two states. Principle of least
    // information.
    if (!targetVenue || targetVenue.org_id !== auth.orgId) {
      return { ok: false, reason: 'venue access denied' }
    }
    return { ok: true }
  }

  return { ok: false, reason: 'venue access denied' }
}

export function forbidden(reason: string) {
  return NextResponse.json({ error: `Forbidden: ${reason}` }, { status: 403 })
}

// ---------------------------------------------------------------------------
// refuseDemo — the demo identity may read, it may not write.
//
// getPlatformAuth() returns a fully-formed coordinator whenever the signed
// bloom_demo_token cookie verifies. There is no Supabase user behind it and
// no human who can be held to anything. Read paths are the point of the
// demo; write paths are an anonymous visitor mutating a venue.
//
// Returns a 403 response when the caller is a demo session, or null when
// it isn't, so a route reads:
//
//     const auth = await getPlatformAuth()
//     if (!auth) return unauthorized()
//     const demo = refuseDemo(auth)
//     if (demo) return demo
//
// Accepts null so dual-auth routes (platform session OR CRON_SECRET) can
// call it unconditionally: a cron caller has no auth object and no demo
// cookie, and gets null back.
//
// Enforced by scripts/check-demo-refused-on-writes.mjs.
// ---------------------------------------------------------------------------
export function refuseDemo(
  auth: { isDemo?: boolean } | null | undefined,
): NextResponse | null {
  if (auth?.isDemo) {
    return NextResponse.json(
      { error: 'Forbidden: the demo is read-only' },
      { status: 403 },
    )
  }
  return null
}

// ---------------------------------------------------------------------------
// requireRole — role gate for routes that change configuration rather than
// day-to-day data.
//
// The real role vocabulary is coordinator | manager | venue_manager |
// org_admin | super_admin (user_profiles.role, plus the middleware's
// readonly). Several routes were checking for 'admin', a value no row has
// ever carried, so the check passed nobody and blocked nobody depending on
// which way the surrounding condition ran.
//
// Returns a 403 response when the caller's role is outside `roles`, or null
// when it is inside. Demo sessions are refused outright — the demo
// coordinator has no business in an admin gate whatever the list says.
// ---------------------------------------------------------------------------
export function requireRole(
  auth: PlatformAuth,
  roles: readonly string[],
): NextResponse | null {
  if (auth.isDemo) return refuseDemo(auth)
  if (!roles.includes(auth.role)) {
    return NextResponse.json(
      { error: `Forbidden: requires ${roles.join(' or ')}` },
      { status: 403 },
    )
  }
  return null
}

/**
 * Find an auth user by email address.
 *
 * `supabase.auth.admin.listUsers()` with no arguments returns the FIRST
 * PAGE only — 50 users by default. Both team-invitation routes used to
 * call it bare and treat "not in the first page" as "no such account".
 * At 50 users that starts silently minting duplicate profiles for people
 * who already have one, and it flipped the invite-accept path into its
 * create-a-new-auth-user branch for existing staff.
 *
 * The admin API has no getUserByEmail, so this pages until it finds the
 * address or runs out of pages. Capped so a pathological directory can't
 * turn one invite into an unbounded walk.
 */
export async function findAuthUserByEmail(
  service: ReturnType<typeof createServiceClient>,
  email: string,
): Promise<{ id: string; email?: string; user_metadata?: Record<string, unknown> } | null> {
  const needle = email.trim().toLowerCase()
  if (!needle) return null

  const PER_PAGE = 200
  const MAX_PAGES = 50 // 10k users; past that this needs a real index

  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: PER_PAGE })
    if (error) {
      console.error('[findAuthUserByEmail] listUsers failed:', error.message)
      return null
    }
    const users = data?.users ?? []
    const hit = users.find((u) => u.email?.toLowerCase() === needle)
    if (hit) return hit as { id: string; email?: string; user_metadata?: Record<string, unknown> }
    if (users.length < PER_PAGE) return null
  }

  console.warn('[findAuthUserByEmail] gave up after %d pages', MAX_PAGES)
  return null
}

// Role vocabulary. Defined in src/lib/auth/roles.ts (edge-safe, no
// server imports) and re-exported here so existing imports keep working.
export { ROLE_RANK, roleRank, ADMIN_ROLES, MANAGER_ROLES } from '@/lib/auth/roles'

// ---------------------------------------------------------------------------
// Common error responses
// ---------------------------------------------------------------------------

export function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

export function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

export function notFound(entity = 'Resource') {
  return NextResponse.json({ error: `${entity} not found` }, { status: 404 })
}

export function serverError(error: unknown) {
  console.error(error)
  return NextResponse.json(
    { error: 'Internal server error' },
    { status: 500 }
  )
}
