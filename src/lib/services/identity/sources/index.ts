/**
 * Source adapter registry for the Phase B Backwards Tracer.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §4.
 *
 * The Tracer iterates this registry in order. Anchors first (defines
 * ground truth), then full-identity channels (Gmail, Calendly), then
 * partial-identity channels (Knot, Instagram). The order matters: an
 * anchor's wedding_id is the strongest possible identity assertion,
 * so when subsequent signals carry a legacy_wedding_id back-pointer
 * we attach them directly via couples.source_wedding_id without
 * re-running the matcher.
 *
 * Adding a new adapter
 * --------------------
 *   1. New file in this folder implementing the SourceAdapter interface
 *      from ./types.
 *   2. Import + push into the array below.
 *   3. Optionally adjust order if it must run before/after another.
 *
 * Disabling an adapter at runtime
 * --------------------------------
 * Tracer accepts an `adapters: string[]` option that filters by name.
 * In normal full-sweep mode, no filter is set and every adapter runs.
 */

import anchors from './anchors'
import gmail from './gmail'
import calendly from './calendly'
import knot from './knot'
import instagram from './instagram'
import type { SourceAdapter } from './types'

export const ALL_ADAPTERS: SourceAdapter[] = [
  anchors,
  gmail,
  calendly,
  knot,
  instagram,
]

export function adaptersByName(names?: string[]): SourceAdapter[] {
  if (!names || names.length === 0) return ALL_ADAPTERS
  const set = new Set(names)
  return ALL_ADAPTERS.filter((a) => set.has(a.name))
}

export type { SourceAdapter, NormalizedSignal, SourceAdapterArgs } from './types'
