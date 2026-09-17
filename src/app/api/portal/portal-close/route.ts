import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, refuseDemo, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

/**
 * The venue's soft close: couple edits stop N days before the wedding.
 * Read and set on venue_config. Off (null) unless the venue chooses it.
 * Enforcement is the database trigger from migration 418; this only
 * stores the setting.
 */
export async function GET() {
  try {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('venue_config')
      .select('portal_changes_close_days, portal_close_message')
      .eq('venue_id', auth.venueId)
      .maybeSingle()
    if (error) throw error
    return NextResponse.json({
      data: {
        close_days: data?.portal_changes_close_days ?? null,
        message: data?.portal_close_message ?? null,
      },
    })
  } catch (err) {
    return serverError(err)
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    const demo = refuseDemo(auth)
    if (demo) return demo

    const body = (await request.json().catch(() => ({}))) as { close_days?: unknown; message?: unknown }
    const raw = body.close_days
    const closeDays =
      raw === null || raw === '' || raw === undefined
        ? null
        : Number.isInteger(Number(raw)) && Number(raw) >= 0 && Number(raw) <= 120
          ? Number(raw)
          : undefined
    if (closeDays === undefined) return badRequest('close_days must be a whole number of days between 0 and 120, or empty for never')
    const message = typeof body.message === 'string' ? body.message.trim().slice(0, 500) || null : null

    const supabase = createServiceClient()
    const { error } = await supabase
      .from('venue_config')
      .update({ portal_changes_close_days: closeDays, portal_close_message: message })
      .eq('venue_id', auth.venueId)
    if (error) throw error
    return NextResponse.json({ data: { close_days: closeDays, message } })
  } catch (err) {
    return serverError(err)
  }
}
