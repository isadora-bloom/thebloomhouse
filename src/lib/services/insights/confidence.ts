/**
 * Sample-size + effect-size aware confidence scoring for T3 insights.
 *
 * Per Tier 3 audit gate: "Every insight surfaces with confidence
 * indicator." A naive 0.5 default confidence on every row is dishonest;
 * a small sample with a big effect IS more confident than a small
 * sample with a tiny effect, and the surfacing UI should reflect that.
 *
 * Returns:
 *   - numeric 0..1 for the intelligence_insights.confidence column
 *   - level 'low' | 'medium' | 'high' for badge rendering
 *
 * Formula choice:
 *   - sample weight: tanh(N / 30). At N=30 sample weight is ~0.76;
 *     at N=10 it's ~0.32. Caps at ~1.0 around N=100. Wedding-domain
 *     samples are usually small (a venue books 50-150 weddings/year);
 *     the curve is calibrated for that regime.
 *   - effect weight: just the effect_size (already 0..1).
 *   - combined: geometric mean (sqrt(sample * effect)). Penalises
 *     "big effect, no sample" AND "huge sample, tiny effect" symmetrically.
 *
 * Honest ceilings:
 *   - At sampleSize < 5, confidence is capped at 0.4 regardless of
 *     effect. A pattern from 4 weddings is suggestive, not definitive.
 *   - At sampleSize > 100 with effect > 0.5, confidence floors at 0.7.
 */

import type { ConfidenceLevel } from './types'

export interface ConfidenceArgs {
  sampleSize: number
  /** 0..1. If unknown, pass 0.5 (neutral). */
  effectSize?: number
}

export function confidenceFor(args: ConfidenceArgs): { value: number; level: ConfidenceLevel } {
  const sampleSize = Math.max(0, args.sampleSize)
  const effectSize = Math.max(0, Math.min(1, args.effectSize ?? 0.5))

  // Hard floor for tiny samples.
  if (sampleSize < 5) {
    const value = Math.min(0.4, effectSize * 0.6)
    return { value, level: 'low' }
  }

  const sampleWeight = Math.tanh(sampleSize / 30)
  const combined = Math.sqrt(sampleWeight * effectSize)

  // Big-sample + clear-effect floor — never report less than 0.7.
  let value = combined
  if (sampleSize >= 100 && effectSize >= 0.5) {
    value = Math.max(0.7, combined)
  }

  // Clamp to [0, 1].
  value = Math.max(0, Math.min(1, value))

  let level: ConfidenceLevel
  if (value >= 0.7) level = 'high'
  else if (value >= 0.45) level = 'medium'
  else level = 'low'

  return { value, level }
}

/**
 * Stable hash of a list of inputs → cache_key. Same inputs → same
 * key → idempotent insight upsert. Order-stable (sorts the keys).
 *
 * Uses a small FNV-1a 32-bit hash; collisions are theoretically
 * possible at scale but acceptable for cache keys (false-positive =
 * wrong row reused; the next read regenerates). Encoded as
 * lowercase hex so it sorts and prints cleanly.
 */
export function buildCacheKey(inputs: Record<string, unknown>): string {
  const orderedJson = JSON.stringify(inputs, Object.keys(inputs).sort())
  // FNV-1a 32-bit
  let hash = 0x811c9dc5
  for (let i = 0; i < orderedJson.length; i++) {
    hash ^= orderedJson.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  // Convert to unsigned 32-bit, hex.
  return (hash >>> 0).toString(16).padStart(8, '0')
}
