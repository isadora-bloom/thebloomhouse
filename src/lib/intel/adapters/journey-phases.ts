/**
 * Journey phases — Discovery / Point zero / Known couple.
 *
 * HANDLE-IDENTITY-SPEC.md §3: "the ribbon reads: first seen (as what,
 * where), discovery touchpoints, point zero, then the known-couple
 * history." `getCoupleJourney` (canonical.ts) already stamps every
 * touchpoint's `zeroPhase` against the couple's `pointZeroAt` and builds
 * the discovery summary from `firstSeenAt` + `handles`. This adapter does
 * no further derivation — it only regroups the ribbon the reader already
 * returned into the three bands a couple page renders, and picks out the
 * one touchpoint that established point zero so it draws once, as a
 * marker, rather than twice (once in discovery-or-known, once again as
 * "the moment").
 *
 * Pure. Unit-tested in ./__tests__/journey-phases.test.ts.
 */

import type { CoupleJourney, TouchpointRibbon } from '@/lib/intel/canonical'
import { clientTerm } from '@/lib/copy/client-terms'

export interface PhaseTouchpoint extends TouchpointRibbon {
  /** True on the single touchpoint that established point_zero_at. Lets a
   *  renderer that iterates `knownCouple` (which this touchpoint is
   *  never a member of — see below) or the raw ribbon draw a marker
   *  without re-deriving anything. */
  isPointZero: boolean
}

export interface JourneyPhaseLabels {
  discovery: string
  pointZero: string
  knownCouple: string
}

export interface HandleChip {
  platform: string
  handle: string
  /** Profile URL a coordinator can click through to. Null for a platform
   *  with no public profile convention (none currently — every
   *  `HandlePlatform` has one — kept optional so an unrecognised future
   *  platform degrades to a plain chip instead of a broken link). */
  url: string | null
}

/** Profile URL prefix per handle platform (HANDLE-IDENTITY-SPEC.md §1's
 *  closed `HandlePlatform` list, `src/lib/services/identity/handles.ts`).
 *  Kept here rather than imported so this adapter stays free of the
 *  identity-service layer; the platform keys are the same closed set,
 *  just used to build a display link instead of to normalise a handle. */
const PROFILE_URL_PREFIX: Record<string, string> = {
  instagram: 'https://instagram.com/',
  tiktok: 'https://tiktok.com/@',
  facebook: 'https://facebook.com/',
  pinterest: 'https://pinterest.com/',
  twitter: 'https://x.com/',
  knot: 'https://www.theknot.com/',
  weddingwire: 'https://www.weddingwire.com/',
  zola: 'https://www.zola.com/',
}

/** Handles as chips a page can render + link out from. Never invents a
 *  handle: only platforms actually present in the map produce a chip. */
export function handleChips(handles: Partial<Record<string, string>>): HandleChip[] {
  return Object.entries(handles)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
    .map(([platform, handle]) => ({
      platform,
      handle,
      url: PROFILE_URL_PREFIX[platform] ? `${PROFILE_URL_PREFIX[platform]}${handle}` : null,
    }))
}

export interface JourneyPhases {
  /** Pre-zero touchpoints, chronological. Empty when the couple has no
   *  discovery history — either nothing predates point zero, or point
   *  zero has not happened yet and every touchpoint so far is discovery
   *  (in which case they are all in `discovery`, not here — see
   *  `pointZero: null`). */
  discovery: PhaseTouchpoint[]
  /** The touchpoint that established point_zero_at, when the ribbon
   *  carries it. Null when point_zero_at is unset (the couple has not
   *  reached point zero yet — every touchpoint so far is discovery). */
  pointZero: PhaseTouchpoint | null
  /** Post-zero touchpoints, chronological, excluding the point-zero
   *  touchpoint itself (it is `pointZero` above, drawn once). */
  knownCouple: PhaseTouchpoint[]
  /** Plain-English band labels, sourced from client-terms.ts. */
  labels: JourneyPhaseLabels
  /** The discovery sentence, straight from `CoupleJourney.discovery`. */
  discoverySummary: string
  /** Days between first-seen and point-zero, straight through. Null when
   *  either timestamp is missing. */
  daysBeforePointZero: number | null
  /** True when the couple predates point zero by more than a day — the
   *  threshold at which a page shows the gap ("41 days of discovery
   *  before they wrote to us") rather than staying silent. */
  showDiscoveryGap: boolean
  /** "41 days of discovery before they wrote to us" — set only when
   *  `showDiscoveryGap` is true. Null otherwise, including when the gap
   *  is zero or one day (not worth a headline) or unknowable. */
  discoveryGapPhrase: string | null
  /** Handles known for this couple, platform -> handle, straight through
   *  from `CoupleJourney.handles`. */
  handles: Partial<Record<string, string>>
  /** The same handles, shaped as chips ready to render + link out from. */
  chips: HandleChip[]
}

const DAY_MS = 86_400_000

function decorate(t: TouchpointRibbon, pointZeroAt: string | null): PhaseTouchpoint {
  return { ...t, isPointZero: pointZeroAt !== null && t.occurredAt === pointZeroAt }
}

/**
 * Split a couple's ribbon into the three Wave-3 bands. Input is
 * deliberately narrow (`Pick`) so a caller building this from a fetched
 * `CoupleJourney` doesn't have to construct the rest of the object.
 */
export function buildJourneyPhases(
  journey: Pick<CoupleJourney, 'ribbon' | 'pointZeroAt' | 'discovery' | 'handles'>,
): JourneyPhases {
  const { ribbon, pointZeroAt, discovery, handles } = journey

  const discoveryTouchpoints: PhaseTouchpoint[] = []
  const knownCouple: PhaseTouchpoint[] = []
  let pointZero: PhaseTouchpoint | null = null

  for (const t of ribbon) {
    const decorated = decorate(t, pointZeroAt)
    if (decorated.isPointZero && !pointZero) {
      // Drawn once, as the marker — never duplicated into either band.
      pointZero = decorated
      continue
    }
    if (t.zeroPhase === 'pre_zero') {
      discoveryTouchpoints.push(decorated)
    } else {
      // 'post_zero', or null (predates migration 381's telemetry) — both
      // read as known-couple history; a null phase is never guessed into
      // discovery, which would overstate how long discovery ran.
      knownCouple.push(decorated)
    }
  }

  const daysBeforePointZero = discovery.daysBeforePointZero
  const showDiscoveryGap = daysBeforePointZero !== null && daysBeforePointZero > 1

  return {
    discovery: discoveryTouchpoints,
    pointZero,
    knownCouple,
    labels: {
      discovery: clientTerm('pre_zero'),
      pointZero: clientTerm('point zero at'),
      knownCouple: clientTerm('post_zero'),
    },
    discoverySummary: discovery.summary,
    daysBeforePointZero,
    showDiscoveryGap,
    discoveryGapPhrase: showDiscoveryGap
      ? `${daysBeforePointZero} days of discovery before they wrote to us`
      : null,
    handles,
    chips: handleChips(handles),
  }
}
