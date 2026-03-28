import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import {
  getNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
} from '@/lib/services/admin-notifications'

// ---------------------------------------------------------------------------
// GET — List notifications or get unread count
//   ?count=true   → { count: number }
//   ?unread=true  → only unread notifications
//   ?limit=50     → max results
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(request.url)

    // Count-only mode
    if (searchParams.get('count') === 'true') {
      const count = await getUnreadCount(auth.venueId)
      return NextResponse.json({ count })
    }

    // List mode
    const unreadOnly = searchParams.get('unread') === 'true'
    const limit = Math.min(
      parseInt(searchParams.get('limit') ?? '50', 10),
      200
    )

    const notifications = await getNotifications(auth.venueId, {
      unreadOnly,
      limit,
    })

    return NextResponse.json({ notifications })
  } catch (err) {
    console.error('[api/platform/notifications] GET error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// ---------------------------------------------------------------------------
// PATCH — Mark notification(s) as read
//   Body: { id: string }          → mark single notification read
//   Body: { markAllRead: true }   → mark all notifications read
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()

    if (body.markAllRead) {
      await markAllNotificationsRead(auth.venueId)
      return NextResponse.json({ success: true })
    }

    if (body.id) {
      await markNotificationRead(body.id)
      return NextResponse.json({ success: true })
    }

    return NextResponse.json(
      { error: 'Provide "id" or "markAllRead: true"' },
      { status: 400 }
    )
  } catch (err) {
    console.error('[api/platform/notifications] PATCH error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
