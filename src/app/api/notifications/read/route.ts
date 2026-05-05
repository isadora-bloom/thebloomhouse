import { createServerSupabaseClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

/**
 * PATCH /api/notifications/read
 * Body: { id: string }
 *
 * Marks a single admin_notification as read. Called by the top-bar
 * NotificationBell when the coordinator clicks a notification row.
 *
 * We use a server route rather than a direct Supabase client update so
 * the RLS policy (users can only update their own venue's notifications)
 * is enforced through the authenticated session, not just the anon key.
 */
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json() as { id?: string }
    const id = body?.id

    if (!id || typeof id !== 'string') {
      return NextResponse.json({ error: 'Missing notification id' }, { status: 400 })
    }

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
