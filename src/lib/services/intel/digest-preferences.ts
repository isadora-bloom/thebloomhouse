/**
 * Digest preferences service (T4-H / Playbook Part 20.3).
 *
 * Read + write helpers for digest_preferences. The send-digest cron
 * pulls all rows where cadence != 'off' AND today's day-of-week
 * matches send_dow (for weekly/biweekly) AND last_sent_at older than
 * the cadence interval.
 *
 * Default-construction: when a coordinator first views their digest
 * settings, getOrCreateDefault returns a starter row with the
 * conservative defaults (weekly Mon 7am, all categories except
 * self_knowledge, both channels on).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type Cadence = 'off' | 'daily' | 'weekly' | 'biweekly'

export interface DigestPreferences {
  id: string
  user_id: string
  venue_id: string
  cadence: Cadence
  send_time_local: string  // HH:MM:SS
  send_dow: number         // 0=Sun..6=Sat
  include_lead_conversion: boolean
  include_pricing: boolean
  include_source_attribution: boolean
  include_anomalies: boolean
  include_macro_correlations: boolean
  include_self_knowledge: boolean
  channel_email: boolean
  channel_in_app: boolean
  last_sent_at: string | null
}

export const DEFAULT_PREFS: Omit<DigestPreferences, 'id' | 'user_id' | 'venue_id' | 'last_sent_at'> = {
  cadence: 'weekly',
  send_time_local: '07:00:00',
  send_dow: 1,  // Monday
  include_lead_conversion: true,
  include_pricing: true,
  include_source_attribution: true,
  include_anomalies: true,
  include_macro_correlations: true,
  include_self_knowledge: false,  // ANTI-19.9-5 opt-in
  channel_email: true,
  channel_in_app: true,
}

export async function getOrCreateDefault(
  supabase: SupabaseClient,
  userId: string,
  venueId: string,
): Promise<DigestPreferences> {
  const { data: existing } = await supabase
    .from('digest_preferences')
    .select('*')
    .eq('user_id', userId)
    .eq('venue_id', venueId)
    .maybeSingle()
  if (existing) return existing as DigestPreferences

  // Insert with defaults; on race (unique constraint), re-fetch.
  const { data: inserted, error } = await supabase
    .from('digest_preferences')
    .insert({
      user_id: userId,
      venue_id: venueId,
      ...DEFAULT_PREFS,
    })
    .select('*')
    .single()
  if (inserted) return inserted as DigestPreferences

  // Race fallback.
  if (error?.code === '23505') {
    const { data: refetch } = await supabase
      .from('digest_preferences')
      .select('*')
      .eq('user_id', userId)
      .eq('venue_id', venueId)
      .single()
    if (refetch) return refetch as DigestPreferences
  }
  throw new Error(error?.message ?? 'failed to get-or-create digest_preferences')
}

export async function updatePreferences(
  supabase: SupabaseClient,
  args: {
    userId: string
    venueId: string
    patch: Partial<Omit<DigestPreferences, 'id' | 'user_id' | 'venue_id' | 'last_sent_at'>>
  },
): Promise<DigestPreferences> {
  const { data, error } = await supabase
    .from('digest_preferences')
    .update(args.patch)
    .eq('user_id', args.userId)
    .eq('venue_id', args.venueId)
    .select('*')
    .single()
  if (error || !data) throw new Error(error?.message ?? 'update failed')
  return data as DigestPreferences
}

/**
 * Pure: should this preference row receive a digest TODAY given the
 * current dow + last_sent_at?
 *   - cadence='off' → never
 *   - 'daily' → yes if last_sent older than 23h
 *   - 'weekly' → only on send_dow if last_sent older than 6 days
 *   - 'biweekly' → only on send_dow if last_sent older than 13 days
 */
export function shouldSendToday(
  prefs: Pick<DigestPreferences, 'cadence' | 'send_dow' | 'last_sent_at'>,
  todayDow: number,
  now: Date = new Date(),
): boolean {
  if (prefs.cadence === 'off') return false
  const lastMs = prefs.last_sent_at ? Date.parse(prefs.last_sent_at) : 0
  const ageMs = now.getTime() - lastMs

  if (prefs.cadence === 'daily') {
    return ageMs >= 23 * 3600 * 1000
  }
  if (prefs.cadence === 'weekly') {
    if (todayDow !== prefs.send_dow) return false
    return ageMs >= 6 * 86_400_000
  }
  if (prefs.cadence === 'biweekly') {
    if (todayDow !== prefs.send_dow) return false
    return ageMs >= 13 * 86_400_000
  }
  return false
}

/**
 * Categories the coordinator opted into. Returned as a Set for
 * easy filtering when the digest builder iterates intelligence_insights
 * rows by category.
 */
export function enabledCategories(prefs: DigestPreferences): Set<string> {
  const out = new Set<string>()
  if (prefs.include_lead_conversion) out.add('lead_conversion')
  if (prefs.include_pricing) out.add('pricing')
  if (prefs.include_source_attribution) out.add('source_attribution')
  if (prefs.include_anomalies) {
    out.add('anomaly')
    out.add('data_anomaly')
  }
  if (prefs.include_macro_correlations) {
    out.add('correlation')
    out.add('market')
    out.add('weather')
    out.add('seasonal')
  }
  if (prefs.include_self_knowledge) {
    out.add('agent_quality')
    out.add('venue_strategy')
  }
  return out
}

// Pure helpers for unit tests.
export const __test__ = {
  shouldSendToday,
  enabledCategories,
  DEFAULT_PREFS,
}
