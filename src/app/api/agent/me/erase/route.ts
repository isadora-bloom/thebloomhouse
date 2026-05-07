import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'
import { checkRateLimit } from '@/lib/rate-limit'

/**
 * POST /api/agent/me/erase — coordinator / admin self-erasure request
 * (Tier-C #116). Queues for admin review like the couple-side route.
 * super_admin requests are routed to platform-level processing rather
 * than the venue queue (resolution_notes flags this on insert).
 */
export async function POST() {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return badRequest('Erasure is unavailable in demo mode')

  const rl = await checkRateLimit({
    key: `compliance:erase:user:${auth.userId}`,
    limit: 1,
    windowSec: 90 * 24 * 60 * 60,
  })
  if (!rl.ok) {
    const retrySec = Math.max(1, Math.floor((rl.resetAt.getTime() - Date.now()) / 1000))
    return NextResponse.json(
      { error: 'Erasure already requested in the last 90 days' },
      { status: 429, headers: { 'Retry-After': String(retrySec) } },
    )
  }

  const supabase = createServiceClient()
  const { data: authUser } = await supabase.auth.admin.getUserById(auth.userId)
  const requesterEmail = authUser?.user?.email ?? '[unknown]'

  const { data: existing } = await supabase
    .from('consumer_requests')
    .select('id, status')
    .eq('requester_user_id', auth.userId)
    .eq('request_type', 'erasure')
    .in('status', ['pending', 'processing'])
    .limit(1)
    .maybeSingle()
  if (existing) {
    return NextResponse.json(
      { ok: true, requestId: existing.id, status: existing.status, alreadyOpen: true },
      { status: 200 },
    )
  }

  const requesterRole =
    auth.role === 'manager'
      ? 'manager'
      : auth.role === 'org_admin'
      ? 'org_admin'
      : auth.role === 'super_admin'
      ? 'super_admin'
      : 'coordinator'

  const { data: row, error } = await supabase
    .from('consumer_requests')
    .insert({
      venue_id: auth.venueId,
      requester_user_id: auth.userId,
      requester_email: requesterEmail,
      requester_role: requesterRole,
      request_type: 'erasure',
      scope: 'self',
      status: 'pending',
      resolution_notes:
        requesterRole === 'super_admin'
          ? 'Super-admin self-erasure — escalate to platform compliance.'
          : null,
    })
    .select('id, expires_at')
    .single()

  if (error || !row) return serverError(error)

  return NextResponse.json(
    {
      ok: true,
      requestId: row.id,
      expiresAt: row.expires_at,
      message: 'Your erasure request has been received. An admin will review within 45 days.',
    },
    { status: 202 },
  )
}
