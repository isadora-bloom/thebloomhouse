import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'

// ---------------------------------------------------------------------------
// Demo mode constants — used when bloom_demo cookie is set
// ---------------------------------------------------------------------------

const DEMO_VENUE_ID = '22222222-2222-2222-2222-222222222201' // Hawthorne Manor
const DEMO_USER_ID = '33333333-3333-3333-3333-333333333301' // Sarah Chen
const DEMO_WEDDING_ID = 'ab000000-0000-0000-0000-000000000001' // Chloe & Ryan

/**
 * Check if the current request is in demo mode (bloom_demo cookie set).
 */
export async function isDemoMode(): Promise<boolean> {
  const cookieStore = await cookies()
  return cookieStore.get('bloom_demo')?.value === 'true'
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

  const platformRoles = ['coordinator', 'manager', 'org_admin', 'super_admin']
  if (!platformRoles.includes(profile.role)) return null

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
