/**
 * Per-platform identity match windows — client-safe constants
 * (T2-D / review pass 4).
 *
 * Pre-pass-4 the admin page at /agent/identity-windows duplicated the
 * DEFAULT_PER_PLATFORM_WINDOWS map inline because the service module
 * (identity-windows.ts) imports @supabase/supabase-js types and was
 * harder to consume from a 'use client' page. This module exists to
 * be the single source of truth: pure data, no DB imports, safe to
 * import from server or client.
 *
 * identity-windows.ts re-exports DEFAULT_PER_PLATFORM_WINDOWS from
 * here so the service-side resolver and the admin UI agree.
 */

export interface PerPlatformWindow {
  /** Tier 1 auto-link window in hours. */
  tier_1_hours: number
  /** Tier 2 wide-window in days. */
  tier_2_days: number
}

export type PerPlatformWindowMap = Record<string, PerPlatformWindow>

export const DEFAULT_PER_PLATFORM_WINDOWS: PerPlatformWindowMap = {
  knot:                 { tier_1_hours: 72,  tier_2_days: 365 },
  the_knot:             { tier_1_hours: 72,  tier_2_days: 365 },
  weddingwire:          { tier_1_hours: 72,  tier_2_days: 365 },
  wedding_wire:         { tier_1_hours: 72,  tier_2_days: 365 },
  zola:                 { tier_1_hours: 72,  tier_2_days: 365 },
  pinterest:            { tier_1_hours: 72,  tier_2_days: 540 },
  instagram:            { tier_1_hours: 72,  tier_2_days: 180 },
  facebook:             { tier_1_hours: 72,  tier_2_days: 180 },
  google_business:      { tier_1_hours: 168, tier_2_days: 30 },
  google:               { tier_1_hours: 168, tier_2_days: 30 },
  here_comes_the_guide: { tier_1_hours: 72,  tier_2_days: 365 },
  default:              { tier_1_hours: 72,  tier_2_days: 30 },
}
