/**
 * Registry of wave-2 tool sources. Each workstream adds exactly one import and
 * one entry here; the integrator wires this array into CANONICAL_TOOLS and the
 * dispatcher in src/lib/intel/tools.ts.
 */
import type { IntelToolSource } from './types'
import { timeSeriesSource } from './time-series'
import { operatorPatternsSource } from './operator-patterns'
import { reviewsToolSource } from './reviews'
import { lostDealsToolSource } from './lost-deals'
import { weatherToursToolSource } from './weather-tours'
import { capacityToolSource } from './capacity'
import { FOLLOW_UP_SOURCES } from './follow-ups'

export const TOOL_SOURCES: readonly IntelToolSource[] = [
  timeSeriesSource,
  operatorPatternsSource,
  // W13 (built-but-unexposed: ghost risk, completeness, identity precision, signals) appends here
  reviewsToolSource, // W14 Q41
  lostDealsToolSource, // W14 Q40
  weatherToursToolSource, // W14 Q10
  capacityToolSource, // W14 Q39
import { ghostRiskSource } from './ghost-risk'
import { completenessSource } from './completeness'
import { identityPrecisionSource } from './identity-precision'
import { signalsSource } from './signals'

export const TOOL_SOURCES: readonly IntelToolSource[] = [
  // W12 (time series + operator patterns) appends here
  // W13 (built-but-unexposed: ghost risk, completeness, identity precision, signals)
  ghostRiskSource,
  completenessSource,
  identityPrecisionSource,
  signalsSource,
  // W14 (reviews, lost deals, weather x tours, open Saturdays) appends here
  // W15 (drafting + follow-up state) appends here
  // W14 (reviews, lost deals, weather x tours, open Saturdays) appends here
  ...FOLLOW_UP_SOURCES, // W15 (drafting + follow-up state)
]
