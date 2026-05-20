/**
 * Matcher name-rule regression tests.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §C.5 (Tier 8 §C.5).
 *
 * The "Kayla → Makayla" false-merge audit (2026-05-20) caught the
 * `nameWithinLevenshtein2` rule firing on name-truncation pairs. This
 * test file pins the doctrine fix:
 *
 *   1. Strict-substring guard — one name fully contains the other
 *      ("Kayla" ⊂ "Makayla", "Anna" ⊂ "Hannah", "Joel" ⊂ "Joelle") never
 *      passes Levenshtein-2.
 *   2. Length-aware cap — short names (< 6 chars) require distance ≤ 1.
 *      "Kayla" vs "Layla" (distance 1) still passes; "Kayla" vs "Karen"
 *      (distance 3 — three substitutions a→r, y→e, l→n... actually
 *      let's pick a true distance-2 short-name pair). "Maya" vs "Maja"
 *      (distance 1) passes; "Maya" vs "Mara" (distance 1) passes;
 *      "Anna" vs "Anya" (distance 2) does NOT pass under the new cap.
 *
 * A failure here means a real name-truncation false-positive shape has
 * regressed and Bloom is about to merge couples that share only a
 * name-substring relationship. Treat a failure as a doctrine event.
 */

import { describe, it, expect } from 'vitest'
import { scoreCandidate, type MatchableRecord } from '../matcher'

function rec(id: string, name: string): MatchableRecord {
  return { id, primary_name: name }
}

describe('matcher — name-rule doctrine', () => {
  it('does NOT fire name_levenshtein_within_2 on Kayla / Makayla (substring)', () => {
    const verdict = scoreCandidate(rec('a', 'Kayla'), rec('b', 'Makayla'))
    const nameSignal = verdict.signals.find((s) => s.name === 'name_match')
    expect(nameSignal).toBeUndefined()
  })

  it('does NOT fire on Anna / Hannah (substring)', () => {
    const verdict = scoreCandidate(rec('a', 'Anna'), rec('b', 'Hannah'))
    const nameSignal = verdict.signals.find((s) => s.name === 'name_match')
    expect(nameSignal).toBeUndefined()
  })

  it('does NOT fire on Joel / Joelle (substring)', () => {
    const verdict = scoreCandidate(rec('a', 'Joel'), rec('b', 'Joelle'))
    const nameSignal = verdict.signals.find((s) => s.name === 'name_match')
    expect(nameSignal).toBeUndefined()
  })

  it('does NOT fire on Anna / Lana at distance 2 (short-name cap)', () => {
    // 'anna' → 'lana' substitutes a→l at position 0 and n→a at position 1,
    // so true Levenshtein distance is 2. With the length-aware cap, short
    // names (<6 chars) only tolerate distance 1, so this distance-2 pair
    // is below the firing threshold. Neither contains the other.
    const verdict = scoreCandidate(rec('a', 'Anna'), rec('b', 'Lana'))
    const nameSignal = verdict.signals.find((s) => s.name === 'name_match')
    expect(nameSignal).toBeUndefined()
  })

  it('STILL fires on Stephanie / Stefanie (one substitution, longer names)', () => {
    // Long names (>= 6 chars) keep the original distance-2 tolerance,
    // and Stephanie / Stefanie are exactly the case the rule is meant
    // to catch — a real typo on the second letter (ph → f).
    // Need a full-name match shape (two tokens) so the matcher even
    // considers the Levenshtein branch under the full_name path; here
    // we add a matching last token so the pair is comparable.
    const verdict = scoreCandidate(
      rec('a', 'Stephanie Jones'),
      rec('b', 'Stefanie Jones'),
    )
    const nameSignal = verdict.signals.find((s) => s.name === 'name_match')
    expect(nameSignal).toBeDefined()
    expect(nameSignal?.evidence).toMatch(/levenshtein2/)
  })

  it('STILL fires on Kayla Williams / Kayla Williams (exact full name → cascade stage 2)', () => {
    // After the 2026-05-20 cascade reset, an exact full-name pair is
    // caught by cascade stage 2 (exact_full_name) before the legacy
    // Levenshtein path runs. The signal name changes from `name_match`
    // to `cascade_exact_full_name`; the doctrine outcome is the same
    // (high-confidence match).
    const verdict = scoreCandidate(
      rec('a', 'Kayla Williams'),
      rec('b', 'Kayla Williams'),
    )
    const cascadeSignal = verdict.signals.find((s) =>
      s.name.startsWith('cascade_'),
    )
    expect(cascadeSignal).toBeDefined()
    expect(cascadeSignal?.name).toBe('cascade_exact_full_name')
    expect(verdict.tier).toBe('high')
  })

  it('STILL fires on Layla / Kayla (true distance-1 short-name typo)', () => {
    // Single substitution L↔K. No substring relationship. Distance 1
    // passes the short-name cap.
    const verdict = scoreCandidate(rec('a', 'Layla'), rec('b', 'Kayla'))
    const nameSignal = verdict.signals.find((s) => s.name === 'name_match')
    expect(nameSignal).toBeDefined()
    expect(nameSignal?.evidence).toMatch(/levenshtein2/)
  })
})
