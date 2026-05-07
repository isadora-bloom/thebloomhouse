import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  assertCanAccessVenue,
  unauthorized,
  forbidden,
  badRequest,
  notFound,
  serverError,
} from '@/lib/api/auth-helpers'
import { eraseCouple, eraseUser } from '@/lib/services/compliance/erasure'
import { exportCouple, exportUser } from '@/lib/services/compliance/portability'

/**
 * POST /api/admin/consumer-requests/[id]/process
 *
 * Body: { action: 'execute' | 'deny', notes?: string }
 *
 * - execute: runs the erasure / portability helper for the targeted
 *   request, marks status='completed'. For portability requests
 *   processed by an admin (rather than the user pulling their own
 *   download), the JSON body is returned in the response so the admin
 *   can email it manually.
 * - deny: marks status='denied' with notes (required for denial under
 *   CCPA 1798.130(a)(2) — operator must explain).
 *
 * Authority:
 *   super_admin → any request
 *   org_admin   → requests within venues in their org
 *   anyone else → 403
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.role !== 'super_admin' && auth.role !== 'org_admin') {
    return forbidden('admin only')
  }

  const { id } = await ctx.params
  if (!id) return badRequest('request id required')

  const body = (await req.json().catch(() => null)) as
    | { action?: 'execute' | 'deny'; notes?: string }
    | null
  if (!body?.action) return badRequest('action required')
  if (body.action !== 'execute' && body.action !== 'deny') {
    return badRequest('action must be execute or deny')
  }
  if (body.action === 'deny' && !body.notes) {
    return badRequest('notes required when denying a request')
  }

  const supabase = createServiceClient()
  const { data: request } = await supabase
    .from('consumer_requests')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (!request) return notFound('Request')

  // Org-admin scope check.
  const access = await assertCanAccessVenue(auth, request.venue_id as string)
  if (!access.ok) return forbidden(access.reason)

  if (request.status !== 'pending' && request.status !== 'processing') {
    return badRequest(`request is already ${request.status}`)
  }

  if (body.action === 'deny') {
    await supabase
      .from('consumer_requests')
      .update({
        status: 'denied',
        resolution_notes: body.notes,
        processed_by: auth.userId,
        processed_at: new Date().toISOString(),
      })
      .eq('id', id)
    return NextResponse.json({ ok: true, status: 'denied' })
  }

  // execute path — switch on request_type + scope
  await supabase
    .from('consumer_requests')
    .update({ status: 'processing', processed_by: auth.userId })
    .eq('id', id)

  try {
    if (request.request_type === 'erasure') {
      if (request.scope === 'wedding') {
        // Resolve the wedding id from the requester's user_profile.
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('wedding_id')
          .eq('id', request.requester_user_id as string)
          .maybeSingle()
        const weddingId = (profile as { wedding_id?: string } | null)?.wedding_id
        if (!weddingId) {
          throw new Error('No wedding linked to requester profile')
        }
        const result = await eraseCouple({
          weddingId,
          userId: request.requester_user_id as string | null,
          venueId: request.venue_id as string,
          requestId: id,
          actorUserId: auth.userId,
        })
        await supabase
          .from('consumer_requests')
          .update({
            status: 'completed',
            resolution_notes: `Erasure: ${result.steps.length} steps, ${result.steps.reduce(
              (s, x) => s + x.affected,
              0,
            )} rows affected. ${body.notes ?? ''}`.trim(),
            processed_at: new Date().toISOString(),
          })
          .eq('id', id)
        return NextResponse.json({ ok: true, status: 'completed', result })
      }

      if (request.scope === 'self') {
        const result = await eraseUser({
          userId: request.requester_user_id as string,
          venueId: request.venue_id as string,
          requestId: id,
          actorUserId: auth.userId,
        })
        await supabase
          .from('consumer_requests')
          .update({
            status: result.ok ? 'completed' : 'denied',
            resolution_notes: result.ok
              ? `User erasure complete. ${body.notes ?? ''}`.trim()
              : `User erasure failed: ${result.error ?? 'unknown'}`,
            processed_at: new Date().toISOString(),
          })
          .eq('id', id)
        return NextResponse.json({ ok: result.ok, result })
      }

      throw new Error(`Unsupported erasure scope: ${request.scope}`)
    }

    if (request.request_type === 'portability') {
      let payload: unknown
      if (request.scope === 'wedding') {
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('wedding_id')
          .eq('id', request.requester_user_id as string)
          .maybeSingle()
        const weddingId = (profile as { wedding_id?: string } | null)?.wedding_id
        if (!weddingId) throw new Error('No wedding linked to requester profile')
        payload = await exportCouple({
          weddingId,
          userId: request.requester_user_id as string | null,
          requestId: id,
        })
      } else if (request.scope === 'self') {
        payload = await exportUser({
          userId: request.requester_user_id as string,
          requestId: id,
        })
      } else {
        throw new Error(`Unsupported portability scope: ${request.scope}`)
      }
      await supabase
        .from('consumer_requests')
        .update({
          status: 'completed',
          resolution_notes: `Portability export delivered to admin for forwarding. ${body.notes ?? ''}`.trim(),
          processed_at: new Date().toISOString(),
        })
        .eq('id', id)
      return NextResponse.json({ ok: true, status: 'completed', payload })
    }

    throw new Error(`Unsupported request_type: ${request.request_type}`)
  } catch (err) {
    await supabase
      .from('consumer_requests')
      .update({
        status: 'pending', // re-open for another attempt
        resolution_notes: `Processing failed: ${err instanceof Error ? err.message : String(err)}`,
      })
      .eq('id', id)
    return serverError(err)
  }
}
