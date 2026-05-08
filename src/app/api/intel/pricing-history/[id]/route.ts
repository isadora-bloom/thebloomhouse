import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
  notFound,
  assertCanAccessVenue,
} from '@/lib/api/auth-helpers'

/**
 * PATCH /api/intel/pricing-history/[id]
 *
 * Update the coordinator-attached `notes` on a pricing_history row.
 * pricing_history is RLS-locked append-only for authenticated (mig 142
 * doctrine — historical edits would corrupt the audit trail), so notes
 * can't be written via the browser client. This route uses the service-
 * role client and explicitly validates that ONLY notes is being changed.
 *
 * The fix for the Round 11 P0 finding — /intel/pricing-history's
 * saveNote was silently 23514-failing every notes update.
 *
 * Auth: any authenticated coordinator with access to the row's venue.
 * Body: { notes: string | null }. Anything else in the body is ignored.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('Editing notes is unavailable in demo mode')

  const { id } = await ctx.params
  if (!id) return badRequest('row id required')

  const body = (await req.json().catch(() => null)) as { notes?: string | null } | null
  if (!body) return badRequest('JSON body required')
  // Coerce + validate. Notes can be null (to clear), or a string up to a
  // reasonable cap. Any other shape rejects.
  const next = body.notes
  if (next !== null && typeof next !== 'string') {
    return badRequest('notes must be a string or null')
  }
  if (typeof next === 'string' && next.length > 500) {
    return badRequest('notes capped at 500 characters')
  }

  const supabase = createServiceClient()

  // Resolve the row + its venue so we can scope-check.
  const { data: row, error: readErr } = await supabase
    .from('pricing_history')
    .select('id, venue_id')
    .eq('id', id)
    .maybeSingle()
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 })
  if (!row) return notFound('pricing_history row')

  const access = await assertCanAccessVenue(auth, row.venue_id as string)
  if (!access.ok) return forbidden(access.reason)

  const { error: upErr } = await supabase
    .from('pricing_history')
    .update({ notes: typeof next === 'string' ? next.trim() || null : null })
    .eq('id', id)
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })

  return NextResponse.json({ ok: true, id })
}
