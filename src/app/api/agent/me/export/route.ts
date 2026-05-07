import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'
import { exportUser } from '@/lib/services/compliance/portability'
import { checkRateLimit } from '@/lib/rate-limit'

/**
 * POST /api/agent/me/export — coordinator / admin self-export
 * (Tier-C #117). Returns the calling platform user's profile data.
 * Authored content (drafts, interactions) belongs to the venue and
 * is excluded by exportUser per its docstring.
 */
export async function POST() {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return badRequest('Export is unavailable in demo mode')

  const rl = await checkRateLimit({
    key: `compliance:export:user:${auth.userId}`,
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
  const { data: authUser } = await supabase.auth.admin.getUserById(auth.userId)
  const requesterEmail = authUser?.user?.email ?? '[unknown]'

  const { data: row, error: insertErr } = await supabase
    .from('consumer_requests')
    .insert({
      venue_id: auth.venueId,
      requester_user_id: auth.userId,
      requester_email: requesterEmail,
      requester_role: auth.role === 'manager' ? 'manager' : auth.role === 'org_admin' ? 'org_admin' : auth.role === 'super_admin' ? 'super_admin' : 'coordinator',
      request_type: 'portability',
      scope: 'self',
      status: 'processing',
    })
    .select('id')
    .single()

  if (insertErr || !row) return serverError(insertErr)

  try {
    const payload = await exportUser({ userId: auth.userId, requestId: row.id as string })

    await supabase
      .from('consumer_requests')
      .update({ status: 'completed', processed_at: new Date().toISOString() })
      .eq('id', row.id as string)

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
        resolution_notes: 'Export build failed; please contact platform support',
        processed_at: new Date().toISOString(),
      })
      .eq('id', row.id as string)
    return serverError(err)
  }
}
