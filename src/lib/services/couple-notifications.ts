import type { createServiceClient } from '@/lib/supabase/service'

type ServiceClient = ReturnType<typeof createServiceClient>

export interface CoupleNotificationInput {
  venueId: string
  weddingId: string
  /** e.g. 'new_message', 'planning_reminder' */
  type: string
  title: string
  body?: string | null
  /** Section-relative couple-portal path, e.g. 'messages'. The bell prefixes it with /couple/{slug}/. */
  link?: string | null
}

/**
 * Insert a couple-facing notification. Fire-and-forget by contract: a failure
 * here must never break the action that triggered it, so it logs and swallows
 * rather than throwing.
 */
export async function createCoupleNotification(
  supabase: ServiceClient,
  n: CoupleNotificationInput,
): Promise<void> {
  const { error } = await supabase.from('couple_notifications').insert({
    venue_id: n.venueId,
    wedding_id: n.weddingId,
    type: n.type,
    title: n.title,
    body: n.body ?? null,
    link: n.link ?? null,
  })
  if (error) {
    console.warn('[couple-notifications] insert failed (non-fatal):', error.message)
  }
}
