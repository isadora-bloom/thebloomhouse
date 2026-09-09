/**
 * Registry of wave-2 tool sources. Each workstream adds exactly one import and
 * one entry here; the integrator wires this array into CANONICAL_TOOLS and the
 * dispatcher in src/lib/intel/tools.ts.
 */
import type { IntelToolSource } from './types'

export const TOOL_SOURCES: readonly IntelToolSource[] = [
  // W12 (time series + operator patterns) appends here
  // W13 (built-but-unexposed: ghost risk, completeness, identity precision, signals) appends here
  // W14 (reviews, lost deals, weather x tours, open Saturdays) appends here
  // W15 (drafting + follow-up state) appends here
]
