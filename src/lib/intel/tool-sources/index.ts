/**
 * Registry of wave-2 tool sources. Each workstream adds exactly one import and
 * one entry here; src/lib/intel/tools.ts loads this array lazily and puts every
 * source in front of the model alongside the five canonical readers.
 */
import type { IntelToolSource } from './types'
import { timeSeriesSource } from './time-series'
import { operatorPatternsSource } from './operator-patterns'
import { ghostRiskSource } from './ghost-risk'
import { completenessSource } from './completeness'
import { identityPrecisionSource } from './identity-precision'
import { signalsSource } from './signals'
import { reviewsToolSource } from './reviews'
import { lostDealsToolSource } from './lost-deals'
import { weatherToursToolSource } from './weather-tours'
import { capacityToolSource } from './capacity'
import { FOLLOW_UP_SOURCES } from './follow-ups'
import { tourCohortSource } from './tour-cohort'
import { platformShiftSource } from './platform-shift'
import { benchmarkToolSource } from './benchmark'

export const TOOL_SOURCES: readonly IntelToolSource[] = [
  // W12: time series and operator patterns (Q1 Q7 Q11 Q12 Q14, Q22 Q23 Q24)
  timeSeriesSource,
  operatorPatternsSource,
  // W13: built but unexposed (Q19, Q30, Q6 Q29 Q36, Q25 Q28)
  ghostRiskSource,
  completenessSource,
  identityPrecisionSource,
  signalsSource,
  // W14: reviews, lost deals, weather against tours, prime Saturdays (Q41 Q40 Q10 Q39)
  reviewsToolSource,
  lostDealsToolSource,
  weatherToursToolSource,
  capacityToolSource,
  // W15: follow-up state and proposals (Q34 Q37)
  ...FOLLOW_UP_SOURCES,
  // W32: explicit-window tour cohort, past or future (Q37 link 1)
  tourCohortSource,
  // W48 (wave 7): platform engagement shift over marketing_metric rows (Q42)
  platformShiftSource,
  // W56 (wave 8): anonymous cross-venue comparison (Q43). Refuses below
  // three peers, which is most of the time until a second real venue signs.
  benchmarkToolSource,
]
