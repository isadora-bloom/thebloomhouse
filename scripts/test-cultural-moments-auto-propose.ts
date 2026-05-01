/**
 * Unit tests — cultural-moments-auto-propose pure helpers (T3-E
 * INS-19.5.8).
 *
 * Targets bandaid traps the design wanted to avoid:
 *   - 20% threshold accepting noise as a "spike" (now z-score with
 *     persistence + magnitude triggers)
 *   - Single-week blip masquerading as a moment (persistence rule)
 *   - Volatile-baseline false positives (volatility floor blocks
 *     spike emission when std > mean*1.5)
 *   - Direction-blind titles (core ↑ vs damp ↑ should produce
 *     opposite-meaning titles)
 *   - Baseline contamination from the candidate spike (baseline
 *     EXCLUDES trailing 2 weeks)
 */

import { __test__ } from '../src/lib/services/insights/cultural-moments-auto-propose'

const { meanStd, detectSpikeForTerm, titleForSpike, buildProposeArgs, BASELINE_WEEKS, TRAILING_WEEKS } = __test__

let pass = 0
let fail = 0

function assert(cond: unknown, label: string) {
  if (cond) {
    console.log(`  ✓ ${label}`)
    pass++
  } else {
    console.error(`  ✗ ${label}`)
    fail++
  }
}

function approxEq(a: number, b: number, tol: number = 0.01): boolean {
  return Math.abs(a - b) < tol
}

// Helper: build a synthetic series of N weeks with a constant baseline
// + optional spike on the last `spikeLen` weeks.
function buildSeries(opts: {
  baseline: number
  baselineNoise?: number
  weeks: number
  trailingValues?: number[]
}): { week: string; interest: number }[] {
  const { baseline, baselineNoise = 0, weeks, trailingValues = [] } = opts
  const series: { week: string; interest: number }[] = []
  const startMs = Date.now() - weeks * 7 * 86_400_000
  for (let i = 0; i < weeks; i++) {
    const week = new Date(startMs + i * 7 * 86_400_000).toISOString().split('T')[0]
    const trailingIdx = trailingValues.length - (weeks - i)
    const interest = trailingIdx >= 0
      ? trailingValues[trailingIdx]
      : baseline + (baselineNoise > 0 ? (Math.sin(i * 0.7) * baselineNoise) : 0)
    series.push({ week, interest })
  }
  return series
}

console.log('\n=== meanStd (re-cover here, smoke for spike calls) ===')
{
  const { mean, std } = meanStd([10, 10, 10, 10])
  assert(mean === 10, 'constant array mean')
  assert(std === 1, 'constant array std=1 (no zero-div in z-score)')
}

console.log('\n=== detectSpikeForTerm — null when not enough data ===')
{
  const series = buildSeries({ baseline: 50, weeks: 10 })
  const spike = detectSpikeForTerm('wedding venue', 'core', series)
  assert(spike === null, 'less than 14 weeks → null')
}

console.log('\n=== detectSpikeForTerm — flat baseline + no spike ===')
{
  const series = buildSeries({ baseline: 50, weeks: 14, trailingValues: [50, 51] })
  const spike = detectSpikeForTerm('wedding venue', 'core', series)
  assert(spike === null, 'flat baseline + no deviation → null')
}

console.log('\n=== detectSpikeForTerm — single-week blip ===')
{
  // 12 weeks of baseline ~50 std=1, then [50, 200].
  // Trailing[0] is on-baseline (z=0). Trailing[1] is +150σ (huge).
  // Persistence FAILS (only one week). Magnitude PASSES (>3.5).
  const series = buildSeries({ baseline: 50, weeks: 14, trailingValues: [50, 200] })
  const spike = detectSpikeForTerm('wedding venue', 'core', series)
  assert(spike !== null, 'single huge week → magnitude trigger')
  assert(spike?.trigger === 'magnitude', 'trigger labelled magnitude')
  assert(spike?.direction === 'up', 'direction = up')
  assert(spike?.zScore !== undefined && spike.zScore > 3.5, 'zScore beyond magnitude threshold')
}

console.log('\n=== detectSpikeForTerm — sustained 2-week spike ===')
{
  // 12 weeks of baseline ~50 (std=1), trailing [60, 60]. Each is +10σ.
  // Persistence PASSES (both >2.5, same direction).
  const series = buildSeries({ baseline: 50, weeks: 14, trailingValues: [60, 60] })
  const spike = detectSpikeForTerm('engagement ring', 'leading', series)
  assert(spike !== null, 'sustained 2-week deviation → spike')
  assert(spike?.trigger === 'persistence', 'trigger labelled persistence')
}

console.log('\n=== detectSpikeForTerm — bidirectional persistence rejected ===')
{
  // Trailing [60, 40] with baseline 50, std=1 → z=[+10, -10]. Both
  // exceed |2.5| but in OPPOSITE directions. Persistence rule should
  // reject (not a coherent direction). But each is also magnitude
  // |10| > 3.5 → magnitude trigger fires on the dominant.
  const series = buildSeries({ baseline: 50, weeks: 14, trailingValues: [60, 40] })
  const spike = detectSpikeForTerm('wedding venue', 'core', series)
  assert(spike !== null, 'opposite-direction trailing weeks still trigger magnitude')
  assert(spike?.trigger === 'magnitude', 'persistence rejected, magnitude still fires')
}

console.log('\n=== detectSpikeForTerm — volatile baseline ignored ===')
{
  // Build a baseline that swings 0..100 (std much bigger than mean*1.5).
  const series: { week: string; interest: number }[] = []
  const start = Date.now() - 14 * 7 * 86_400_000
  // Alternate 0 and 100 for 12 baseline weeks → mean=50, std=~52.
  // std (52) > mean (50) * 1.5 (75)? 52 > 75 false. Hmm need bigger swing.
  // Use 0 / 100 / 0 / 100... Actually std = sqrt(sum((x-50)^2)/n-1) for n=12
  // alternating gives std = sqrt(12*2500/11) = sqrt(2727) ≈ 52. So 52 < 75.
  // Need to shift baseline lower to make std/mean ratio higher.
  // Use values 5, 80, 5, 80, ... mean = 42.5, std ≈ 39. 39 > 42.5 * 1.5? no (63.75).
  // Use 1, 95, 1, 95... mean = 48, std ≈ 49. 49 > 72? no.
  // The volatility check is mean > 5 AND std > mean*1.5. So try mean ~10
  // with big swings — say 0 / 30 / 0 / 30 → mean=15, std ≈ 16. 16 > 22.5? no.
  // Try 0 / 50 → mean=25, std ≈ 26. 26 > 37.5? no.
  // The check is conservative on purpose: only blocks when std > 150% of
  // mean. For 12-step alternating-binary this rarely fires. Use 1 / 100
  // mix where most are 1 and one is huge → mean low std huge.
  for (let i = 0; i < 12; i++) {
    series.push({
      week: new Date(start + i * 7 * 86_400_000).toISOString().split('T')[0],
      interest: i === 5 ? 100 : i === 8 ? 80 : 1,
    })
  }
  // Trailing weeks
  series.push({ week: new Date(start + 12 * 7 * 86_400_000).toISOString().split('T')[0], interest: 90 })
  series.push({ week: new Date(start + 13 * 7 * 86_400_000).toISOString().split('T')[0], interest: 90 })

  const spike = detectSpikeForTerm('wedding venue', 'core', series)
  // Compute mean/std of baseline manually for assertion clarity.
  const baselineVals = series.slice(0, 12).map((s) => s.interest)
  const m = baselineVals.reduce((a, b) => a + b, 0) / 12
  const v = baselineVals.reduce((acc, x) => acc + (x - m) * (x - m), 0) / 11
  const s = Math.sqrt(v)
  if (m > 5 && s > m * 1.5) {
    assert(spike === null, `volatile baseline (mean=${m.toFixed(1)}, std=${s.toFixed(1)}) → null`)
  } else {
    // baseline isn't volatile enough to trip the check; make sure detector behaves normally
    assert(true, 'baseline not volatile enough to test volatility check (skipped)')
  }
}

console.log('\n=== titleForSpike — direction-aware ===')
{
  const baseSpike = {
    term: 'wedding venue',
    termCategory: 'core' as const,
    weekStart: '2026-04-20',
    weekEnd: '2026-04-27',
    recentAvg: 80,
    baselineMean: 50,
    baselineStd: 5,
    zScore: 6,
    direction: 'up' as const,
    trigger: 'persistence' as const,
  }
  assert(
    titleForSpike(baseSpike).title.includes('demand spike'),
    'core ↑ → "demand spike"',
  )
  assert(
    titleForSpike({ ...baseSpike, direction: 'down', zScore: -6 }).title.includes('softening'),
    'core ↓ → "softening"',
  )
  assert(
    titleForSpike({ ...baseSpike, termCategory: 'leading' }).title.includes('Engagement-intent spike'),
    'leading ↑ → "Engagement-intent spike"',
  )
  assert(
    titleForSpike({ ...baseSpike, termCategory: 'dampener' }).title.includes('headwind'),
    'dampener ↑ → "headwind"',
  )
  assert(
    titleForSpike({ ...baseSpike, termCategory: 'dampener', direction: 'down' }).title.includes('tailwind'),
    'dampener ↓ → "tailwind"',
  )
}

console.log('\n=== buildProposeArgs — evidence shape ===')
{
  const spike = {
    term: 'engagement ring',
    termCategory: 'leading' as const,
    weekStart: '2026-04-20',
    weekEnd: '2026-04-27',
    recentAvg: 75,
    baselineMean: 50,
    baselineStd: 4,
    zScore: 6.25,
    direction: 'up' as const,
    trigger: 'persistence' as const,
  }
  const args = buildProposeArgs(spike)
  assert(args.title.includes('Engagement-intent'), 'title from titleForSpike')
  assert(args.evidence['kind'] === 'auto_trend_spike', 'evidence.kind set for dedup fingerprint')
  assert(args.evidence['term'] === 'engagement ring', 'evidence.term carries the term')
  assert(args.evidence['weekStart'] === '2026-04-20', 'evidence.weekStart carries the anchor week')
  assert(args.evidence['zScore'] === 6.25, 'evidence.zScore preserved')
  assert(args.evidence['direction'] === 'up', 'evidence.direction preserved')
  assert(args.geoScope === null, 'geo_scope null by default (coordinator refines on confirm)')
  assert(args.endAt === null, 'end_at null (open-ended; coordinator can close)')
  assert(args.startAt.startsWith('2026-04-20'), 'start_at anchored to weekStart')
}

// Confirm constants are sensible.
assert(BASELINE_WEEKS === 12, 'BASELINE_WEEKS=12 (3 months baseline)')
assert(TRAILING_WEEKS === 2, 'TRAILING_WEEKS=2 (persistence requires 2 weeks)')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
