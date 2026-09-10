/**
 * demo-reseed — deterministic pseudo-random helpers.
 *
 * Mulberry32. Small, fast, and the same sequence on every platform, which
 * is the only property that matters here: a test has to be able to assert
 * on the generated dataset, and the operator has to get the same demo
 * twice from the same seed.
 *
 * Pure. No IO, no clock reads, no crypto.
 */

export interface Rng {
  /** Float in [0, 1). */
  next(): number
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number
  /** Pick one element. Throws on an empty list, because a silent
   *  undefined here would show up three files later as a blank name. */
  pick<T>(items: readonly T[]): T
  /** True with probability p. */
  chance(p: number): boolean
  /** A shuffled copy. Fisher-Yates, driven by this stream. */
  shuffle<T>(items: readonly T[]): T[]
}

export function makeRng(seed: number): Rng {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const rng: Rng = {
    next,
    int(min, max) {
      if (max < min) throw new Error(`rng.int: max ${max} < min ${min}`)
      return min + Math.floor(next() * (max - min + 1))
    },
    pick(items) {
      if (items.length === 0) throw new Error('rng.pick: empty list')
      return items[Math.floor(next() * items.length)]
    },
    chance(p) {
      return next() < p
    },
    shuffle(items) {
      const out = items.slice()
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1))
        const tmp = out[i]
        out[i] = out[j]
        out[j] = tmp
      }
      return out
    },
  }
  return rng
}

/**
 * Weighted pick. Weights need not sum to one; they are normalised.
 * Deterministic given the rng stream.
 */
export function weightedPick<T extends string>(
  rng: Rng,
  weights: Record<T, number>,
): T {
  const entries = Object.entries(weights) as Array<[T, number]>
  const total = entries.reduce((sum, [, w]) => sum + w, 0)
  if (total <= 0) throw new Error('weightedPick: weights sum to zero')
  let roll = rng.next() * total
  for (const [key, w] of entries) {
    roll -= w
    if (roll <= 0) return key
  }
  return entries[entries.length - 1][0]
}
