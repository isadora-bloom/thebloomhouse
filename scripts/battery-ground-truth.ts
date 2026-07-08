// ---------------------------------------------------------------------------
// battery-ground-truth.ts — verified-facts probes for the battery judge.
//
// REMEDIATION-PLAN-2026-07-07.md R2. The old scorer could not check whether
// any number in an answer was true. These probes compute compact factual
// summaries straight from the canonical read functions (src/lib/intel/
// canonical.ts) and hand them to the LLM judge as "verified database facts",
// so a confident answer that contradicts them is scorable as confabulation
// and a refusal despite the facts existing is scorable as a false negative.
//
// Probes reuse the canonical readers rather than raw SQL on purpose: the
// canonical fns are the Phase-3 read surface, so the battery verifies against
// the same numbers the product itself will serve.
//
// Not every question has a probe. Questions without one are judged on
// calibration + shape alone (same information the old scorer had, but with a
// judge that reads the whole answer instead of a regex).
// ---------------------------------------------------------------------------

export type ProbeName = 'overview' | 'attribution' | 'cohort' | 'dailyList'

/** Which probes feed which question ids (battery-expected.ts ids). */
export const QUESTION_PROBES: Record<string, ProbeName[]> = {
  // Tier 1 — response-time mechanics live in the cohort intel
  '1': ['cohort'],
  '2': ['cohort'],
  '3': ['cohort'],
  '4': ['cohort', 'attribution'],
  '5': ['attribution'],
  // Tier 2
  '8': ['cohort'],
  '11': ['cohort'],
  // Tier 3
  '12': ['cohort'],
  '14': ['cohort'],
  // Tier 4 — false-premise traps need the real channel table to judge
  '32b': ['attribution'],
  // Tier 5
  '22': ['cohort'],
  // Tier 6
  '26': ['attribution'],
  '28': ['attribution'],
  // Tier 8 consistency — the judge needs the real ranking
  '33': ['attribution'],
  // Tier 9 — tour list for the weekend workflow
  '37': ['dailyList'],
  // Tier 12 — built-but-untested surfaces
  '38': ['attribution'],
  '39': ['overview', 'cohort'],
}

/** Truncate a JSON blob so four probes never blow the judge's context. */
function compact(value: unknown, max = 6000): string {
  let s: string
  try {
    s = JSON.stringify(value)
  } catch {
    return '[unserialisable probe result]'
  }
  return s.length <= max ? s : s.slice(0, max) + '…[truncated]'
}

/**
 * Compute all probes once per run. Individual probe failures degrade to an
 * explanatory string instead of failing the run — a judge without ground
 * truth is still better than a regex.
 */
export async function loadGroundTruth(
  venueId: string
): Promise<Map<ProbeName, string>> {
  // Dynamic import so run-battery's loadEnv() has already mirrored .env.local
  // onto process.env before the canonical module's service client initialises.
  const canonical = await import('../src/lib/intel/canonical')
  const out = new Map<ProbeName, string>()

  const jobs: Array<[ProbeName, () => Promise<unknown>]> = [
    ['overview', () => canonical.getVenueOverview(venueId)],
    [
      'attribution',
      async () => ({
        first_touch: await canonical.getSourceAttribution(venueId, { model: 'first_touch' }),
        last_touch: await canonical.getSourceAttribution(venueId, { model: 'last_touch' }),
      }),
    ],
    ['cohort', () => canonical.getCohortFunnel(venueId)],
    ['dailyList', () => canonical.getDailyList(venueId)],
  ]

  for (const [name, job] of jobs) {
    try {
      out.set(name, compact(await job()))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      out.set(name, `[probe "${name}" failed: ${msg} — judge without it]`)
    }
  }
  return out
}

/** Assemble the ground-truth block for one question, or null if it has none. */
export function groundTruthFor(
  questionId: string,
  probes: Map<ProbeName, string>
): string | null {
  const names = QUESTION_PROBES[questionId]
  if (!names || names.length === 0) return null
  return names
    .map((n) => `--- probe: ${n} ---\n${probes.get(n) ?? '[probe missing]'}`)
    .join('\n')
}
