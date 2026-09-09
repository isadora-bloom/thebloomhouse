/**
 * Shared types for the onboarding data-cleanup pipeline (T5-W5).
 *
 * Six repair steps run in dependency order after a fresh venue's Gmail
 * backfill and before the readiness gate. Historically these only lived
 * as CLI scripts (scripts/onboard-data-cleanup.ts orchestrating six
 * sibling scripts under scripts/*.ts) that the founder ran by hand
 * against production. Extracted here so a coordinator can preview +
 * apply from POST /api/onboarding/project/cleanup with no terminal.
 *
 * Each step function takes an injected Supabase client (never creates
 * its own — the CLI wrapper and the API route each construct the
 * client appropriate to their context) plus a venueId and an apply
 * flag. dry-run (apply=false) computes and counts everything it WOULD
 * change but writes nothing.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface CleanupStepResult {
  /** Stable step id — matches CLEANUP_STEPS[].id below. */
  id: string
  /** Human-readable name for UI + CLI output. */
  name: string
  /** True once the step ran without a hard failure (soft per-row errors are tolerated and counted). */
  ok: boolean
  /** True when the step could not run at all (e.g. no Gmail connections) — distinct from ok=false-with-partial-progress. */
  skipped: boolean
  /** Why skipped, if skipped. */
  skipReason?: string
  /** Free-form counters, one line per metric — rendered as a table in the UI. */
  counts: Record<string, number>
  /** Up to a handful of human-readable sample lines for coordinator review. */
  samples: string[]
  /** Non-fatal per-row error messages, capped. */
  errors: string[]
}

export interface CleanupStepFn {
  (sb: SupabaseClient, venueId: string, apply: boolean): Promise<CleanupStepResult>
}

export function emptyResult(id: string, name: string): CleanupStepResult {
  return { id, name, ok: true, skipped: false, counts: {}, samples: [], errors: [] }
}
