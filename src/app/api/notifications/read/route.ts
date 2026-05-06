import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  assertCanAccessVenue,
  unauthorized,
  forbidden,
} from '@/lib/api/auth-helpers'

/**
 * PATCH /api/notifications/read
 * Body: { id: string }
 *
 * Marks a single admin_notification as read. Called by the top-bar
 * NotificationBell when the coordinator clicks a notification row.
 *
 * Auth: pre-fix relied on RLS-via-server-supabase-client to gate the
 * update, but missed the explicit user check — an unauthenticated
 * request would reach the update with anon and silently succeed-no-op.
 * Now: getPlatformAuth() up front + venue ownership check on the
 * notification row before update. Per 2026-05-06 audit Lens 1.
 */
export async function PATCH(request: NextRequest) {
  try {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()

    const body = await request.json() as { id?: string }
    const id = body?.id

    if (!id || typeof id !== 'string') {
      return NextResponse.json({ error: 'Missing notification id' }, { status: 400 })
    }

    // Ownership check via service-role read (bypasses RLS to be sure
    // we get the truth). Then write through the authenticated client
    // so RLS still acts as defense-in-depth.
    const service = createServiceClient()
    const { data: notif } = await service
      .from('admin_notifications')
      .select('venue_id')
      .eq('id', id)
      .maybeSingle()
    if (!notif) {
      return NextResponse.json({ error: 'Notification not found' }, { status: 404 })
    }
    const decision = await assertCanAccessVenue(auth, notif.venue_id as string)
    if (!decision.ok) return forbidden(`notification ${decision.reason}`)

    const supabase = await createServerSupabaseClient()

    const { error } = await supabase
      .from('admin_notifications')
      .update({ read: true })
      .eq('id', id)

    if (error) {
      console.error('[notifications/read] Update failed:', error.message)
      return NextResponse.json({ error: 'Update failed' }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[notifications/read] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
