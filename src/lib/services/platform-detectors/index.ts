/**
 * Platform-detector dispatcher.
 *
 * Runs every registered detector against the supplied headers + sample
 * rows. Returns the highest-confidence match with all its evidence,
 * plus the runner-up — useful for the coordinator confirmation UI
 * ("we think this is Knot at 95% confidence; if that's wrong, click
 * here for WeddingWire at 60%").
 *
 * Detectors are deliberately additive — they don't compete on a
 * shared score; each independently inspects and emits its own
 * confidence. This means an unfamiliar CSV may match multiple
 * detectors weakly; the dispatcher resolves by max confidence.
 *
 * If no detector hits the threshold, the result is `unknown` and the
 * caller should either prompt the coordinator to pick a platform or
 * fall through to the generic AI classifier.
 */

import type { PlatformDetector } from './types'
import { TheKnotDetector } from './the-knot'
import { WeddingWireDetector } from './wedding-wire'
import { InstagramDetector } from './instagram'
import { PinterestDetector } from './pinterest'
import { GoogleBusinessDetector } from './google-business'
import { FacebookDetector } from './facebook'

const DETECTORS: PlatformDetector[] = [
  TheKnotDetector,
  WeddingWireDetector,
  InstagramDetector,
  PinterestDetector,
  GoogleBusinessDetector,
  FacebookDetector,
]

/** Confidence threshold below which we call it "unknown" and ask. */
const MIN_CONFIDENT = 60

export interface PlatformMatch {
  detector: PlatformDetector
  confidence: number
  evidence: string[]
}

export interface DetectionResult {
  best: PlatformMatch | null
  /** Up to 2 runner-up matches the coordinator can override to. */
  alternatives: PlatformMatch[]
  /** All detectors with non-null detect() result, descending by confidence. */
  all: PlatformMatch[]
}

export function detectPlatformSource(
  headers: readonly string[],
  sampleRows: readonly string[][]
): DetectionResult {
  const matches: PlatformMatch[] = []
  for (const det of DETECTORS) {
    try {
      const r = det.detect(headers, sampleRows)
      if (r) matches.push({ detector: det, confidence: r.confidence, evidence: r.evidence })
    } catch (err) {
      console.warn(`[platform-detector] ${det.key} detect threw:`, err)
    }
  }
  matches.sort((a, b) => b.confidence - a.confidence)

  const best = matches[0] && matches[0].confidence >= MIN_CONFIDENT ? matches[0] : null
  const alternatives = matches.slice(best ? 1 : 0, best ? 3 : 2)
  return { best, alternatives, all: matches }
}

export function detectorByKey(key: string): PlatformDetector | undefined {
  return DETECTORS.find((d) => d.key === key)
}

export const ALL_DETECTOR_KEYS = DETECTORS.map((d) => d.key)

export type { PlatformDetector, UniversalSignalRow } from './types'
