/**
 * Source type re-export for the identity pipeline.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §4 + PHASE-1.1-TRACER-FOLD.md.
 *
 * The Backwards Tracer's mirror-reading adapter sweep (Phase 1.1) has
 * been removed: touchpoint creation now comes from origin-replay through
 * `linkSignal` rather than per-adapter `walk()` reads of the legacy
 * tables. The five adapter modules (gmail / calendly / knot / instagram
 * / anchors) and the `ALL_ADAPTERS` registry are gone. This module now
 * only re-exports the shared signal types from `./types`, which the
 * Forwards Linker, route-by-tier, and the origin-replay primitives
 * continue to consume.
 */

export type { SourceAdapter, NormalizedSignal, SourceAdapterArgs } from './types'
