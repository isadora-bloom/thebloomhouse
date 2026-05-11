/**
 * Wave 16 — Knot/WeddingWire broadcast template detector.
 *
 * @deprecated since Wave 23 (mig 289). The Knot-specific implementation
 * has been generalised into `listing-platform-detector.ts`. This file
 * remains as a thin back-compat wrapper that dispatches to the
 * platform-agnostic detector with platform='the_knot'. Direct callers
 * should migrate to `detectListingBroadcast` so they can pass the
 * platform inferred from the attribution_event (HCTG, Brides.com,
 * Zola, Junebug, Carats & Cake, Style Me Pretty — all use the same
 * scoring mechanics via the unified detector).
 *
 * Anchor docs:
 *   - listing-platform-detector.ts (the generalised module)
 *   - bloom-constitution.md (forensic identity reconstruction; the
 *     detector reads the actual inquiry body and matches against
 *     operator-curated patterns. No self-report trust.)
 *   - bloom-may9-llm-vs-template.md (deterministic where signals are
 *     clear. The LLM judge only handles ambiguous templateScore 40-59.)
 *   - feedback_deep_fix_vs_bandaid.md (Wave 23's deep fix: generalise
 *     the layer rather than adding per-venue Knot-only overrides.)
 *
 * Why this wrapper exists
 * -----------------------
 * Wave 16 callers (currently only intent-classifier.ts but potentially
 * scripts or tests) import `detectKnotTemplateSignal`. Removing the
 * file would force a synchronous rewrite of every caller in the same
 * commit. Keeping a thin wrapper lets:
 *   - Wave 23's classifier migration land cleanly (it switches to
 *     `detectListingBroadcast` with the inferred platform).
 *   - Any straggler callers keep working with their original signature
 *     while a follow-up commit migrates them.
 *
 * The wrapper preserves the original input/output shapes verbatim so
 * back-compat is byte-for-byte. The only change a caller sees is a
 * `@deprecated` JSDoc nudging them at IDE-completion time.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  detectListingBroadcast,
  type ListingDetectorOutput,
} from './listing-platform-detector'

// ---------------------------------------------------------------------------
// Types — preserved verbatim from Wave 16 so wrapper is shape-compatible
// ---------------------------------------------------------------------------

export interface DetectorInteraction {
  /** Plain-text body. Subject-line text MAY be prepended by the caller. */
  body: string | null
  body_preview?: string | null
  subject?: string | null
  /** The venue name, used to detect "did the couple actually reference
   *  this venue?" — absence is a personalisation deficit. */
  venueName?: string | null
}

export interface DetectorInput {
  venueId: string
  interaction: DetectorInteraction
  supabase?: SupabaseClient
}

export interface DetectorOutput {
  /** 0-100, aggregated score across all matched patterns + personalisation deficit. */
  templateScore: number
  /** The pattern_value strings that fired. */
  matchedPatterns: string[]
  /** Components for debugging / audit. */
  components: {
    phraseScore: number
    regexScore: number
    personalisationDeficit: number
  }
  /** Hard threshold flag: templateScore >= 60. */
  isLikelyBroadcast: boolean
}

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `detectListingBroadcast` from
 * `./listing-platform-detector` and supply an explicit `platform`.
 * This wrapper hard-codes platform='the_knot' for back-compat with
 * Wave 16 callers — it WILL NOT detect HCTG/Brides.com/Zola/Junebug/
 * Carats & Cake/Style Me Pretty broadcast templates.
 */
export async function detectKnotTemplateSignal(
  input: DetectorInput,
): Promise<DetectorOutput> {
  const out: ListingDetectorOutput = await detectListingBroadcast({
    venueId: input.venueId,
    platform: 'the_knot',
    interaction: input.interaction,
    supabase: input.supabase,
  })
  // Strip the wrapped platform field — Wave 16's DetectorOutput did
  // not include it. Everything else is byte-for-byte identical.
  return {
    templateScore: out.templateScore,
    matchedPatterns: out.matchedPatterns,
    components: out.components,
    isLikelyBroadcast: out.isLikelyBroadcast,
  }
}
