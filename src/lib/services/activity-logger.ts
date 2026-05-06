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
// logRead — audit log for bulk reads / exports
//
// Per 2026-05-06 audit Lens 8 top-3 fix #1:
// > "Read-side audit log on tier-1 reads + rate-limit/anomaly on bulk
// >  exports. The blast radius from a compromised coordinator login is
// >  'every couple, every venue they touch, silently.' Without this you
// >  cannot answer 'did anyone exfil yesterday' — which is question 1
// >  on every breach response."
//
// Tier-1 tables (PII / health-adjacent / financial):
//   weddings, guest_list, allergy_registry, contracts, sage_conversations,
//   interactions (full email bodies), people
//
// Use logRead at any coordinator surface that fetches a SET of tier-1
// rows (single-row reads on a detail page are fine). Bulk reads + CSV
// exports are the threat. activity_type follows the convention
// 'read_<table>' or 'export_<table>'.
// ---------------------------------------------------------------------------

export async function logRead(options: {
  venueId: string
  weddingId?: string
  userId?: string
  /** Logical table or surface being read (e.g. 'guest_list', 'weddings'). */
  resource: string
  /** 'view' for opening a page, 'export' for downloads, 'bulk_read' for batched fetches. */
  mode: 'view' | 'export' | 'bulk_read'
  /** Approximate row count, for spotting volume anomalies. */
  rowCount?: number
  /** Free-form context (filename, format, filters applied). */
  details?: Record<string, unknown>
}): Promise<void> {
  // Fire-and-forget. Failure to log must not block the user-facing
  // operation — but we WILL emit a console error so a stuck logger
  // surfaces in observability.
  return logActivity({
    venueId: options.venueId,
    weddingId: options.weddingId,
    userId: options.userId,
    activityType: `${options.mode}_${options.resource}`,
    entityType: options.resource,
    details: {
      ...(options.details ?? {}),
      row_count: options.rowCount ?? null,
    },
  })
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
