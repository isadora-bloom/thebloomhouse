import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Admin Notification types
// ---------------------------------------------------------------------------

export interface Notification {
  id: string
  venue_id: string
  wedding_id: string | null
  type: string
  title: string
  body: string | null
  read: boolean
  read_at: string | null
  email_sent: boolean
  created_at: string
}

// ---------------------------------------------------------------------------
// createNotification — fire-and-forget with deduplication
// Checks for duplicate (same type + wedding_id) within last 5 minutes
// ---------------------------------------------------------------------------

export async function createNotification(options: {
  venueId: string
  weddingId?: string
  type: string
  title: string
  body?: string
}): Promise<void> {
  try {
    const supabase = createServiceClient()

    // Deduplicate: check for same type + wedding_id in last 5 minutes
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()

    let dupeQuery = supabase
      .from('admin_notifications')
      .select('id')
      .eq('venue_id', options.venueId)
      .eq('type', options.type)
      .gte('created_at', fiveMinutesAgo)
      .limit(1)

    if (options.weddingId) {
      dupeQuery = dupeQuery.eq('wedding_id', options.weddingId)
    }

    const { data: existing } = await dupeQuery
    if (existing && existing.length > 0) return

    await supabase.from('admin_notifications').insert({
      venue_id: options.venueId,
      wedding_id: options.weddingId ?? null,
      type: options.type,
      title: options.title,
      body: options.body ?? null,
    })
  } catch (err) {
    console.error('[admin-notifications] Failed to create notification:', err)
  }
}

// ---------------------------------------------------------------------------
// getNotifications — list notifications for a venue
// ---------------------------------------------------------------------------

export async function getNotifications(
  venueId: string,
  options?: { unreadOnly?: boolean; limit?: number }
): Promise<Notification[]> {
  const supabase = createServiceClient()
  const limit = options?.limit ?? 50

  let query = supabase
    .from('admin_notifications')
    .select('*')
    .eq('venue_id', venueId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (options?.unreadOnly) {
    query = query.eq('read', false)
  }

  const { data, error } = await query

  if (error) {
    console.error('[admin-notifications] Failed to fetch notifications:', error)
    return []
  }

  return (data ?? []) as Notification[]
}

// ---------------------------------------------------------------------------
// markNotificationRead — mark a single notification as read
// ---------------------------------------------------------------------------

export async function markNotificationRead(id: string): Promise<void> {
  const supabase = createServiceClient()

  const { error } = await supabase
    .from('admin_notifications')
    .update({ read: true, read_at: new Date().toISOString() })
    .eq('id', id)

  if (error) {
    console.error('[admin-notifications] Failed to mark read:', error)
  }
}

// ---------------------------------------------------------------------------
// markAllNotificationsRead — mark all notifications as read for a venue
// ---------------------------------------------------------------------------

export async function markAllNotificationsRead(venueId: string): Promise<void> {
  const supabase = createServiceClient()

  const { error } = await supabase
    .from('admin_notifications')
    .update({ read: true, read_at: new Date().toISOString() })
    .eq('venue_id', venueId)
    .eq('read', false)

  if (error) {
    console.error('[admin-notifications] Failed to mark all read:', error)
  }
}

// ---------------------------------------------------------------------------
// getUnreadCount — count unread notifications for a venue
// ---------------------------------------------------------------------------

export async function getUnreadCount(venueId: string): Promise<number> {
  const supabase = createServiceClient()

  const { count, error } = await supabase
    .from('admin_notifications')
    .select('*', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .eq('read', false)

  if (error) {
    console.error('[admin-notifications] Failed to get unread count:', error)
    return 0
  }

  return count ?? 0
}
