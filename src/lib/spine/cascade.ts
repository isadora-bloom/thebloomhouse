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
 *   2. The Day 12 CI guard (`check-cascade-only-writer`) has ONE explicit
 *      allowed-writer surface to verify against.
 *
 * This is NOT a stub. Every writer below is real, tested code. This file
 * is a namespace, not an implementation:
 *
 *   lockAndMintCouple — couple + touchpoint (new `couples`/`touchpoints`
 *                       spine). Advisory-locked via the
 *                       `lock_and_mint_couple` RPC (migration 359).
 *                       Built AND wired — but in SHADOW MODE: live paths
 *                       are route-by-tier.ts -> identity_first_tracer
 *                       cron, and pipeline.ts:4109 -> linkSignal (fire-
 *                       and-forget). Runs parallel to the legacy
 *                       weddings/interactions pipeline. Days 9-11 work
 *                       is PROMOTION (shadow -> primary), not adoption.
 *   mintPerson        — `people` rows (legacy people-table chokepoint).
 *   mintWedding       — legacy `weddings`-table chokepoint
 *                       (adopted 2026-05-12).
 *
 * Anything that INSERTs/UPSERTs `couples` / `people` / `weddings` /
 * `touchpoints` outside this surface is a bug the CI guard must catch.
 * Lifecycle / heat / metadata UPDATEs are NOT constrained here — R1 is a
 * creation boundary, not a commit boundary.
 *
 * Verify-Day-7 open items (CASCADE-CANONICAL-WRITER.md §3.1, §4):
 *   (a) does `lock_and_mint_couple` write a `couple_merge_events` audit row
 *   (b) the `CascadeSignal`-vs-`NormalizedSignal` adaptation
 */

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
