/**
 * Pure-statistics helpers for the correlation engine (T2-C / OPS-21.6.x).
 *
 * Pre-fix the Bonferroni correction was a heuristic
 *   corrected_r = baseline_r * sqrt(log(numTests + 1) / log(2))
 * with magic constants. This module replaces it with a proper
 * derivation:
 *
 *   1. Bonferroni-adjust alpha:        alpha' = alpha / numTests
 *   2. Inverse normal at 1 - alpha'/2:  z_crit = qnorm(1 - alpha'/2)
 *   3. Cornish-Fisher t-correction:     t_crit ≈ z + (z + z³)/(4·df)
 *   4. Solve t = r·sqrt(df) / sqrt(1 - r²) for r:
 *      r_crit = t_crit / sqrt(df + t_crit²)
 *
 * For our typical setup (WINDOW_DAYS=90, df=88, ~20 channels × 5 lags
 * = 1900 tests, family-wise alpha = 0.05) the proper math gives
 * r_crit ≈ 0.43; with the safety floor at 0.6 the binding constraint
 * is "meaningful effect size" not "statistical significance" — which
 * matches Bloom's surfacing requirement (we want NOTABLE correlations,
 * not just non-random ones).
 *
 * Pure functions, no DB or supabase types. Easy to unit-test.
 */

/**
 * Acklam's algorithm — inverse standard normal CDF. Accurate to about
 * 1.15 × 10⁻⁹ in the tails. Public domain.
 *
 * Returns the value z such that Φ(z) = p, for p in (0, 1).
 */
export function inverseNormalCdf(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error(`inverseNormalCdf domain: ${p}`)

  // Coefficients for the rational approximation.
  const a = [-3.969683028665376e+01,  2.209460984245205e+02,
             -2.759285104469687e+02,  1.383577518672690e+02,
             -3.066479806614716e+01,  2.506628277459239e+00]
  const b = [-5.447609879822406e+01,  1.615858368580409e+02,
             -1.556989798598866e+02,  6.680131188771972e+01,
             -1.328068155288572e+01]
  const c = [-7.784894002430293e-03, -3.223964580411365e-01,
             -2.400758277161838e+00, -2.549732539343734e+00,
              4.374664141464968e+00,  2.938163982698783e+00]
  const d = [ 7.784695709041462e-03,  3.224671290700398e-01,
              2.445134137142996e+00,  3.754408661907416e+00]

  const pLow = 0.02425
  const pHigh = 1 - pLow

  let q: number, r: number

  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0]*q + c[1])*q + c[2])*q + c[3])*q + c[4])*q + c[5]) /
           ((((d[0]*q + d[1])*q + d[2])*q + d[3])*q + 1)
  } else if (p <= pHigh) {
    q = p - 0.5
    r = q * q
    return (((((a[0]*r + a[1])*r + a[2])*r + a[3])*r + a[4])*r + a[5])*q /
           (((((b[0]*r + b[1])*r + b[2])*r + b[3])*r + b[4])*r + 1)
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0]*q + c[1])*q + c[2])*q + c[3])*q + c[4])*q + c[5]) /
           ((((d[0]*q + d[1])*q + d[2])*q + d[3])*q + 1)
  }
}

/**
 * Cornish-Fisher first-order correction from a standard-normal critical
 * value to a Student-t critical value at given degrees of freedom.
 * Accurate to a few percent for df ≥ 30 (we use df = WINDOW_DAYS - 2 = 88).
 */
function cornishFisherTCrit(zCrit: number, df: number): number {
  if (df <= 0) return zCrit
  return zCrit + (zCrit + zCrit * zCrit * zCrit) / (4 * df)
}

/**
 * Bonferroni-corrected critical Pearson |r| for a family of `numTests`
 * comparisons at family-wise alpha `familyAlpha`, sample size `n`.
 *
 * Returns a value in (0, 1) that the engine compares |r| against. Passes
 * mean the correlation is significant after correction.
 *
 * Floor: callers typically max() this against a meaningful-effect-size
 * threshold (CORRELATION_THRESHOLD = 0.6) so the binding constraint is
 * "notable" not "non-random."
 */
export function bonferroniCriticalR(
  numTests: number,
  n: number,
  familyAlpha: number = 0.05,
): number {
  if (numTests < 1 || n < 4) return 1  // refuse to test
  const perTestAlpha = familyAlpha / numTests
  // Two-sided test: split alpha across tails.
  const upperTail = 1 - perTestAlpha / 2
  const zCrit = inverseNormalCdf(upperTail)
  const df = n - 2
  const tCrit = cornishFisherTCrit(zCrit, df)
  // r = t / sqrt(df + t²)
  return tCrit / Math.sqrt(df + tCrit * tCrit)
}
