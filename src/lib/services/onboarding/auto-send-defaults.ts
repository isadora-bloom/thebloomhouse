/**
 * Default auto-send rule creation for venues with zero rules (T5-W5).
 *
 * /agent/settings only ever UPDATEs existing auto_send_rules rows —
 * there was no INSERT path, so a venue that skipped (or never saw)
 * the 15-min wizard's ad-platform picker had no way to ever create a
 * rule short of the founder doing it by hand in Supabase. This gives
 * the settings page something to call when rules.length === 0.
 *
 * Mirrors migration 121 (confidence_threshold is an INTEGER 0-100,
 * default 85) and migration 227 (new rules default shadow_mode=true —
 * "configured but only watching, not firing" — so a second venue's
 * first auto-send decisions land in the shadow review queue instead
 * of firing blind).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { writeOrLog } from '@/lib/db/write-or-log'

/** Matches AD_PLATFORM_OPTIONS[].source in the 15-min wizard + the
 *  weddings.source CHECK in migration 086. */
export const DEFAULT_AUTO_SEND_SOURCES: readonly string[] = [
  'the_knot',
  'wedding_wire',
  'zola',
  'website',
  'direct',
]

export const DEFAULT_CONFIDENCE_THRESHOLD = 85
export const DEFAULT_DAILY_LIMIT = 5

export interface CreateDefaultAutoSendRulesResult {
  ok: boolean
  created: number
  error?: string
}

/**
 * Seed one disabled, shadow-mode inquiry rule per default source for
 * a venue with no auto_send_rules rows at all. Idempotent via
 * upsert(onConflict: venue_id,context,source) — safe to call more
 * than once (e.g. a double-click) without duplicating rows.
 *
 * Rules are created ENABLED=false, shadow_mode=true — the coordinator
 * still has to explicitly turn a rule on from the UI; this just gives
 * them something to turn on instead of an empty state with no create
 * affordance.
 */
export async function createDefaultAutoSendRules(
  sb: SupabaseClient,
  venueId: string,
): Promise<CreateDefaultAutoSendRulesResult> {
  const rows = DEFAULT_AUTO_SEND_SOURCES.map((source) => ({
    venue_id: venueId,
    context: 'inquiry' as const,
    source,
    enabled: false,
    confidence_threshold: DEFAULT_CONFIDENCE_THRESHOLD,
    daily_limit: DEFAULT_DAILY_LIMIT,
    require_new_contact: false,
    shadow_mode: true,
    shadow_started_at: new Date().toISOString(),
  }))

  const result = await writeOrLog(
    sb.from('auto_send_rules').upsert(rows, { onConflict: 'venue_id,context,source' }).select('id'),
    { op: 'auto_send_rules.createDefaultAutoSendRules', venueId },
  )
  if (result.error) {
    return { ok: false, created: 0, error: result.error.message }
  }
  return { ok: true, created: (result.data ?? []).length }
}
