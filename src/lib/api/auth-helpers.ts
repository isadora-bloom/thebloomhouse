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
    return { userId: DEMO_USER_ID, venueId: DEMO_VENUE_ID, role: 'coordinator', isDemo: true }
  }

  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const service = createServiceClient()
  const { data: profile } = await service
    .from('user_profiles')
    .select('venue_id, role')
    .eq('id', user.id)
    .single()

  if (!profile?.venue_id) return null

  const platformRoles = ['coordinator', 'manager', 'org_admin', 'super_admin']
  if (!platformRoles.includes(profile.role)) return null

  return { userId: user.id, venueId: profile.venue_id as string, role: profile.role as string, isDemo: false }
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
