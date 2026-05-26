/**
 * Spine canonical writers — the allowed-writer surface.
 *
 * Day 4-5 of CONSOLIDATION-PLAN-25-DAY-ANCHORED.md. Per the doctrine in
 * CASCADE-CANONICAL-WRITER.md: the cascade is a CREATION BOUNDARY — the
 * only paths that may CREATE a couple / person / wedding or BIND a
 * touchpoint. This module re-exports those chokepoints under one import
 * path (`@/lib/spine/cascade`) so:
 *
 *   1. Every new caller imports the canonical writer from here, not from
 *      the scattered `services/identity/*` files.
 *   2. The CI guard (`check-cascade-only-writer`, §1.6 — NOT yet built)
 *      will have ONE explicit allowed-writer surface to verify against.
 *
 * This is NOT a stub. Every writer below is real, tested code. This file
 * is a namespace, not an implementation:
 *
 *   linkSignal        — THE ORCHESTRATOR. Whole-cascade entry: match ->
 *                       judge -> route-by-tier -> mint/attach/candidate/
 *                       fragment. Every Batch-1 identity/touchpoint
 *                       writer calls THIS (not lockAndMintCouple direct —
 *                       that skips the matcher and mints duplicates).
 *                       Live at pipeline.ts:4109: awaited, but still
 *                       SHADOW — the LinkResult is discarded, errors are
 *                       swallowed by an empty catch, the call sits last.
 *                       Phase 1 §1.1 / §P5 promotes it to load-bearing.
 *   lockAndMintCouple — couple + touchpoint chokepoint (new `couples`/
 *                       `touchpoints` spine). Advisory-locked via the
 *                       `lock_and_mint_couple` RPC (migration 359).
 *                       A LEAF — reached only via applyTierRouting inside
 *                       linkSignal; not called directly by limb writers.
 *   mintPerson        — `people` rows (legacy people-table chokepoint).
 *                       Carries the partner2 enrich-or-skip invariant
 *                       (weddingId+role, Phase 1 §P2).
 *   mintWedding       — legacy `weddings`-table chokepoint
 *                       (adopted 2026-05-12).
 *
 * Anything that INSERTs/UPSERTs `couples` / `people` / `weddings` /
 * `touchpoints` outside this surface is a bug the CI guard must catch.
 * Lifecycle / heat / metadata UPDATEs are NOT constrained here — R1 is a
 * creation boundary, not a commit boundary.
 *
 * Day-7 open items — RESOLVED 2026-05-22 (PHASE-1-BATCH-1.md §1.7, §8):
 *   (a) `lock_and_mint_couple` did NOT write a `couple_merge_events`
 *       audit row — confirmed gap; migration 366 adds a `couple_minted`
 *       row inside the RPC mint branch.
 *   (b) `CascadeSignal` and `NormalizedSignal` are distinct types with no
 *       direct adapter; the live path round-trips lossily through
 *       `MatchableRecord`, dropping body text (cascadeMatch stages 6-8
 *       never fire from linkSignal — see PHASE-1-BATCH-1.md Q5).
 */

export {
  linkSignal,
  linkSignalBatch,
  type LinkSignalArgs,
  type LinkResult,
  type LinkAction,
} from '@/lib/services/identity/forwards-linker'

/**
 * Phase 1 Batch 2 — Pbatch2-8: lifecycle-aware wrapper around linkSignal.
 *
 * Optional drop-in replacement that dispatches the matching per-channel
 * lifecycle helper (recordSmsLifecycleSignal / recordZoomLifecycleSignal)
 * AFTER linkSignal returns. Bare linkSignal remains the default; Batch-2
 * SMS / Zoom / OpenPhone flips use this wrapper to keep lifecycle
 * bookkeeping uniform across adapters. Net-additive primitive — see
 * `link-with-lifecycle.ts` for the dispatch table + the REVIEW Pbatch2-8
 * gap on phone/voicemail.
 */
export { linkSignalWithLifecycle } from '@/lib/services/identity/link-with-lifecycle'

export {
  lockAndMintCouple,
  computeLockKey,
  hasSufficientIdentity,
  type MintCoupleResult,
} from '@/lib/services/identity/mint-couple'

export {
  mintPerson,
  type MintPersonInput,
  type MintPersonResult,
  type PersonMintSource,
} from '@/lib/services/identity/mint-person'

export {
  mintWedding,
  type MintWeddingInput,
  type MintWeddingResult,
  type MintWeddingSignals,
} from '@/lib/services/identity/mint-wedding'

export type { NormalizedSignal } from '@/lib/services/identity/sources/types'
