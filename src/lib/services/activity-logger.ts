import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Activity Log types
// ---------------------------------------------------------------------------

export interface ActivityEntry {
  id: string
  venue_id: string
  wedding_id: string | null
  user_id: string | null
  activity_type: string
  entity_type: string | null
  entity_id: string | null
  details: Record<string, unknown>
  created_at: string
}

// ---------------------------------------------------------------------------
// logActivity — fire-and-forget logger
// Inserts into activity_log. Never throws.
// ---------------------------------------------------------------------------

export async function logActivity(options: {
  venueId: string
  weddingId?: string
  userId?: string
  activityType: string
  entityType?: string
  entityId?: string
  details?: Record<string, unknown>
}): Promise<void> {
  try {
    const supabase = createServiceClient()

    await supabase.from('activity_log').insert({
      venue_id: options.venueId,
      wedding_id: options.weddingId ?? null,
      user_id: options.userId ?? null,
      activity_type: options.activityType,
      entity_type: options.entityType ?? null,
      entity_id: options.entityId ?? null,
      details: options.details ?? {},
    })
  } catch (err) {
    console.error('[activity-logger] Failed to log activity:', err)
  }
}

// ---------------------------------------------------------------------------
// getRecentActivity — fetch recent activity entries
// ---------------------------------------------------------------------------

export async function getRecentActivity(
  venueId: string,
  options?: { weddingId?: string; limit?: number }
): Promise<ActivityEntry[]> {
  const supabase = createServiceClient()
  const limit = options?.limit ?? 50

  let query = supabase
    .from('activity_log')
    .select('*')
    .eq('venue_id', venueId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (options?.weddingId) {
    query = query.eq('wedding_id', options.weddingId)
  }

  const { data, error } = await query

  if (error) {
    console.error('[activity-logger] Failed to fetch activity:', error)
    return []
  }

  return (data ?? []) as ActivityEntry[]
}
