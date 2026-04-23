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
// ---------------------------------------------------------------------------

/**
 * Notification types that must dedup PER WEDDING FOREVER, not on the
 * default 5-minute window. Semantics:
 *
 *   - Mark-read does NOT unlock re-fire. These types are "discovery
 *     events" — once the coordinator has been alerted to a possibility
 *     (e.g., this wedding might have just booked), they own the
 *     follow-up on their own cadence. Re-firing on every subsequent
 *     strong-signal email would spam.
 *   - DELETE of the notification row DOES unlock re-fire — treat that
 *     as the coordinator explicitly asking to be re-alerted if this
 *     happens again.
 *   - No information is lost by not re-firing: the classifier-level
 *     heat events (high_commitment_signal, tour_requested, etc.) still
 *     fire per-email and appear on the wedding timeline. The prompt
 *     is additive, not the sole signal.
 */
const FOREVER_DEDUP_TYPES = new Set<string>([
  'booking_confirmation_prompt',
])

export async function createNotification(options: {
  venueId: string
  weddingId?: string
  type: string
  title: string
  body?: string
}): Promise<void> {
  try {
    const supabase = createServiceClient()

    const foreverDedup = FOREVER_DEDUP_TYPES.has(options.type)

    // Dedup strategy:
    //  - FOREVER_DEDUP_TYPES dedup on (venue_id, wedding_id, type) with
    //    no time window. Weddingless notifs in this set fall back to
    //    (venue_id, type) since we have no wedding discriminator.
    //  - Everything else dedups on a 5-minute window so accidental
    //    double-fires don't spam but coordinator notifications can
    //    recur day-to-day.
    let dupeQuery = supabase
      .from('admin_notifications')
      .select('id')
      .eq('venue_id', options.venueId)
      .eq('type', options.type)
      .limit(1)

    if (!foreverDedup) {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
      dupeQuery = dupeQuery.gte('created_at', fiveMinutesAgo)
    }

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
