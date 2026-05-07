import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getCoupleAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'
import { exportCouple } from '@/lib/services/compliance/portability'
import { checkRateLimit } from '@/lib/rate-limit'

/**
 * POST /api/couple/me/export — CCPA / GDPR data-portability download
 * (Tier-C #117).
 *
 * Returns a JSON file with every row keyed to the calling couple's
 * wedding. Logs the request into consumer_requests for audit. Rate-
 * limited to 1 per 30 days to prevent abuse and frame the request
 * cadence around legitimate consumer use.
 */
export async function POST() {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return badRequest('Export is unavailable in demo mode')

  const rl = await checkRateLimit({
    key: `compliance:export:couple:${auth.userId}`,
    limit: 1,
    windowSec: 30 * 24 * 60 * 60,
  })
  if (!rl.ok) {
    const retrySec = Math.max(1, Math.floor((rl.resetAt.getTime() - Date.now()) / 1000))
    return NextResponse.json(
      { error: 'Data export already requested in the last 30 days' },
      { status: 429, headers: { 'Retry-After': String(retrySec) } },
    )
  }

  const supabase = createServiceClient()

  // Resolve the requester email so the consumer_requests audit row has
  // a durable correspondence channel even after the user_profile is
  // erased.
  const { data: authUser } = await supabase.auth.admin.getUserById(auth.userId)
  const requesterEmail = authUser?.user?.email ?? '[unknown]'

  // Insert the audit row first, then build the export. If the build
  // fails the row stays as 'processing' so an admin can review.
  const { data: requestRow, error: insertErr } = await supabase
    .from('consumer_requests')
    .insert({
      venue_id: auth.venueId,
      requester_user_id: auth.userId,
      requester_email: requesterEmail,
      requester_role: 'couple',
      request_type: 'portability',
      scope: 'wedding',
      status: 'processing',
    })
    .select('id')
    .single()

  if (insertErr || !requestRow) return serverError(insertErr)

  try {
    const payload = await exportCouple({
      weddingId: auth.weddingId,
      userId: auth.userId,
      requestId: requestRow.id as string,
    })

    await supabase
      .from('consumer_requests')
      .update({ status: 'completed', processed_at: new Date().toISOString() })
      .eq('id', requestRow.id as string)

    const filename = `bloom-data-export-${new Date().toISOString().slice(0, 10)}.json`
    return new NextResponse(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    await supabase
      .from('consumer_requests')
      .update({
        status: 'denied',
        resolution_notes: 'Export build failed; please contact support',
        processed_at: new Date().toISOString(),
      })
      .eq('id', requestRow.id as string)
    return serverError(err)
  }
}
