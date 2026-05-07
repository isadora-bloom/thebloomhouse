import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getCoupleAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'
import { checkRateLimit } from '@/lib/rate-limit'

/**
 * POST /api/couple/me/erase — CCPA / GDPR right-to-erasure request
 * (Tier-C #116).
 *
 * Queues a deletion request. The actual erasure does NOT execute here;
 * an admin reviews + approves via /super-admin/consumer-requests. This
 * preserves the operator's verifiable-consumer-request obligation
 * (CCPA 1798.140(y)) and gives the venue a chance to flag any active
 * disputes / contractual obligations before erasure.
 *
 * Rate-limited to 1 per 90 days.
 */
export async function POST() {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return badRequest('Erasure is unavailable in demo mode')

  const rl = await checkRateLimit({
    key: `compliance:erase:couple:${auth.userId}`,
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

  // Block duplicate pending requests so the queue doesn't fill with
  // anxious double-submits. CCPA gives the operator until expires_at
  // anyway; one open request at a time is the right shape.
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

  const { data: row, error } = await supabase
    .from('consumer_requests')
    .insert({
      venue_id: auth.venueId,
      requester_user_id: auth.userId,
      requester_email: requesterEmail,
      requester_role: 'couple',
      request_type: 'erasure',
      scope: 'wedding',
      status: 'pending',
    })
    .select('id, expires_at')
    .single()

  if (error || !row) return serverError(error)

  return NextResponse.json(
    {
      ok: true,
      requestId: row.id,
      expiresAt: row.expires_at,
      message:
        'Your erasure request has been received. The venue admin will review and complete it within 45 days.',
    },
    { status: 202 },
  )
}
