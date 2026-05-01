/**
 * Per-platform identity match windows (T2-D / ARCH-8.5.3).
 *
 * The candidate-resolver matches a pre-zero `candidate_identity` to a
 * post-zero `wedding` by checking whether the candidate's signal time
 * sits within a window of the wedding's inquiry_date / tour_date.
 * Pre-T2-D the windows were two global constants:
 *   TIER_1_NAME_WINDOW_HOURS = 72   (3 days)
 *   TIER_2_WIDE_WINDOW_HOURS = 720  (30 days)
 *
 * That's wrong because platforms have radically different decay
 * shapes:
 *   - Knot       — couples browse for ~12 months before contacting
 *                  (bridal lead time). 30d Tier 2 misses 90% of
 *                  matches; Knot Audit (2026-04-30) found only
 *                  4/785 matched at ±72h with hundreds in the
 *                  5-365d range.
 *   - Pinterest  — saves accumulate over the whole engagement
 *                  period, ~18 months.
 *   - Instagram  — lighter follow/save pattern, decays faster
 *                  (~6 months).
 *   - GMB        — sub-week decision horizon (Google Business
 *                  Profile interactions = "I just searched for venues
 *                  near me"). Tighter Tier 1 (1 week) + tight Tier 2
 *                  (30 days).
 *
 * This module loads per-platform windows from
 * venue_config.identity_match_config.per_platform (jsonb), merges
 * over the defaults below, and returns a resolver keyed by
 * source_platform. Coordinators can override at /agent/identity-windows.
 *
 * Per Playbook ARCH-8.5.3 / BUILD-PLAN T2-D.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface PerPlatformWindow {
  /** Tier 1 auto-link window in hours. Below this, ±this-hours of the
   *  wedding's inquiry/tour date is considered a confident match.
   *  Above the per-platform tier_2_days, the candidate doesn't reach
   *  even Tier 2 wide-window. */
  tier_1_hours: number
  /** Tier 2 wide-window in days. Between tier_1_hours and tier_2_days,
   *  the candidate routes to the AI adjudicator with full context
   *  (auto-merge is off above tier_1_hours per ANTI-8.4-B). */
  tier_2_days: number
}

export type PerPlatformWindowMap = Record<string, PerPlatformWindow>

/**
 * Per-platform decay defaults. Source: Playbook ARCH-8.5.3 + Knot
 * import audit 2026-04-30. The 'default' key is the fallback used by
 * any platform without an explicit row — keeps the pre-T2-D
 * behaviour for unrecognised sources.
 *
 * `tier_2_days` choices reflect the platform's decision-horizon:
 *   knot/weddingwire/zola   = 365 (year of bridal lead time)
 *   pinterest               = 540 (~18mo, longer save pattern)
 *   instagram               = 180 (~6mo follow/save decay)
 *   facebook                = 180 (similar to IG)
 *   google_business         =  30 (Google searches are immediate)
 *   default                 =  30 (pre-T2-D constant — conservative
 *                                  fallback for any platform we
 *                                  haven't characterised yet)
 */
export const DEFAULT_PER_PLATFORM_WINDOWS: PerPlatformWindowMap = {
  knot:            { tier_1_hours: 72,  tier_2_days: 365 },
  the_knot:        { tier_1_hours: 72,  tier_2_days: 365 },
  weddingwire:     { tier_1_hours: 72,  tier_2_days: 365 },
  wedding_wire:    { tier_1_hours: 72,  tier_2_days: 365 },
  zola:            { tier_1_hours: 72,  tier_2_days: 365 },
  pinterest:       { tier_1_hours: 72,  tier_2_days: 540 },
  instagram:       { tier_1_hours: 72,  tier_2_days: 180 },
  facebook:        { tier_1_hours: 72,  tier_2_days: 180 },
  google_business: { tier_1_hours: 168, tier_2_days: 30 },
  google:          { tier_1_hours: 168, tier_2_days: 30 },
  here_comes_the_guide: { tier_1_hours: 72, tier_2_days: 365 },
  default:         { tier_1_hours: 72,  tier_2_days: 30 },
}

/**
 * Lookup a candidate's window with the right fallback chain:
 *   1. exact source_platform match
 *   2. lowercased source_platform (callers may pass mixed case)
 *   3. 'default' bucket
 *   4. hard-coded last resort (matches the pre-T2-D constants)
 */
export function windowsForPlatform(
  map: PerPlatformWindowMap,
  sourcePlatform: string | null | undefined,
): PerPlatformWindow {
  const HARD_DEFAULT: PerPlatformWindow = { tier_1_hours: 72, tier_2_days: 30 }
  if (!sourcePlatform) return map.default ?? HARD_DEFAULT
  const exact = map[sourcePlatform]
  if (exact) return exact
  const lower = map[sourcePlatform.toLowerCase()]
  if (lower) return lower
  return map.default ?? HARD_DEFAULT
}

/**
 * Load per-platform windows for a venue: defaults overlaid with any
 * keys present under venue_config.identity_match_config.per_platform.
 * Per-key merge — a venue can override Knot's tier_2_days without
 * having to redeclare every other platform.
 *
 * Defensive: tolerates a missing row (returns DEFAULTS), a missing
 * per_platform key (returns DEFAULTS), or partial per-platform
 * objects (the missing fields fall back to the defaults).
 */
export async function loadPerPlatformWindows(
  supabase: SupabaseClient,
  venueId: string,
): Promise<PerPlatformWindowMap> {
  const { data } = await supabase
    .from('venue_config')
    .select('identity_match_config')
    .eq('venue_id', venueId)
    .maybeSingle()

  const cfg = (data?.identity_match_config ?? {}) as Record<string, unknown>
  const overrides = (cfg.per_platform ?? {}) as Record<string, Partial<PerPlatformWindow>>

  const merged: PerPlatformWindowMap = { ...DEFAULT_PER_PLATFORM_WINDOWS }
  for (const [platform, partial] of Object.entries(overrides)) {
    const base = merged[platform] ?? merged.default ?? { tier_1_hours: 72, tier_2_days: 30 }
    merged[platform] = {
      tier_1_hours: typeof partial?.tier_1_hours === 'number' ? partial.tier_1_hours : base.tier_1_hours,
      tier_2_days: typeof partial?.tier_2_days === 'number' ? partial.tier_2_days : base.tier_2_days,
    }
  }
  return merged
}

/**
 * Persist a venue's per-platform overrides. Reads-modifies-writes the
 * jsonb column so we don't clobber other identity_match_config keys
 * (name_plus_partner_days etc. used by identity-resolution.ts).
 *
 * Pass an empty object to delete all overrides (revert to defaults).
 */
export async function savePerPlatformWindows(
  supabase: SupabaseClient,
  venueId: string,
  overrides: PerPlatformWindowMap,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: existing, error: readErr } = await supabase
    .from('venue_config')
    .select('identity_match_config')
    .eq('venue_id', venueId)
    .maybeSingle()
  if (readErr) return { ok: false, error: readErr.message }

  const cfg = (existing?.identity_match_config ?? {}) as Record<string, unknown>
  const next = { ...cfg, per_platform: overrides }

  const { error: writeErr } = await supabase
    .from('venue_config')
    .update({ identity_match_config: next })
    .eq('venue_id', venueId)
  if (writeErr) return { ok: false, error: writeErr.message }
  return { ok: true }
}
