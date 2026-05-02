/**
 * Digest dispatch — preference-aware wrapper around sendAllDigests
 * (T4-H wiring).
 *
 * Pre-this-file the daily_digest cron sent to every venue with a
 * briefing_email regardless of coordinator preferences (cadence,
 * day-of-week, opt-out). This wrapper filters venues to those with
 * AT LEAST ONE coordinator whose preferences pass shouldSendToday.
 *
 * Per-user category filtering happens inside the digest builder
 * via enabledCategories — that's a builder-side concern; this
 * module gates which venues fire today.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { shouldSendToday, type DigestPreferences } from '@/lib/services/digest-preferences'

export interface DigestDispatchSummary {
  venuesConsidered: number
  venuesSentToday: string[]
  venuesSkipped: Array<{ venueId: string; reason: string }>
  // last_sent_at update count per user
  preferencesAdvanced: number
}

/**
 * Resolve venues that should receive a digest today based on
 * digest_preferences. A venue qualifies when AT LEAST ONE coordinator
 * has cadence != 'off' AND shouldSendToday returns true.
 *
 * Caller (cron) then iterates the eligible venues + calls
 * sendDigestEmail per venue. last_sent_at on each qualifying
 * preferences row is updated post-dispatch.
 */
export async function eligibleVenuesToday(
  now: Date = new Date(),
): Promise<{ venueIds: string[]; userPrefs: DigestPreferences[] }> {
  const supabase = createServiceClient()
  const todayDow = now.getUTCDay()

  // Pull all non-off preferences. Could be N×coordinators rows but
  // the table is bounded by user count (~1-10 per venue typical) so
  // a full scan is fine until 100+ venues.
  const { data: rows } = await supabase
    .from('digest_preferences')
    .select('*')
    .neq('cadence', 'off')

  const prefsList = (rows ?? []) as DigestPreferences[]
  const eligible = prefsList.filter((p) => shouldSendToday(p, todayDow, now))

  const venueIds = Array.from(new Set(eligible.map((p) => p.venue_id)))
  return { venueIds, userPrefs: eligible }
}

/**
 * Stamp last_sent_at on every preference row that fed today's
 * dispatch. Idempotent — re-running for the same set of venueIds
 * is a no-op (last_sent_at moves forward, but shouldSendToday's
 * cadence check still wouldn't re-fire for at least 23h/6d/13d).
 */
export async function markPreferencesSent(
  preferences: DigestPreferences[],
): Promise<number> {
  if (preferences.length === 0) return 0
  const supabase = createServiceClient()
  const nowIso = new Date().toISOString()
  const { error } = await supabase
    .from('digest_preferences')
    .update({ last_sent_at: nowIso })
    .in('id', preferences.map((p) => p.id))
  if (error) {
    console.warn('[digest-dispatch] markPreferencesSent failed:', error.message)
    return 0
  }
  return preferences.length
}
