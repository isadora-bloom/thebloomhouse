'use client'

import { useVenueScope } from '@/lib/contexts/venue-scope-context'

/**
 * Read the per-venue AI assistant name (venue_ai_config.ai_name).
 *
 * Backed by VenueScopeProvider which resolves it server-side at the same
 * time as venueId so this hook is synchronous, hydration-safe, and races
 * nothing. See lib/api/resolve-platform-scope.ts for the server-side
 * resolution.
 *
 * Returns "your AI assistant" when the venue hasn't named theirs yet
 * (mid-onboarding). Outbound brain paths use requireAiName() instead and
 * throw — the UI fallback is purely cosmetic.
 *
 * White-label rationale (T5-β.2): every coordinator-facing string that
 * named the AI used to literal "Sage", which leaked Hawthorne's brand
 * into Oakwood's ("Ivy") admin shell. This hook is the canonical reader.
 */
export function useAiName(): string {
  return useVenueScope().aiName
}
