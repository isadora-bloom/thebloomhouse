/**
 * Cron auth helper. Tier-C #126, hardened by the 2026-09-14 security
 * audit (S2).
 *
 * Two-tier model:
 *   - CRON_SECRET — required for every cron route and every admin ops
 *     route. Verified by all callers, including Vercel's automatic cron
 *     triggers. Must be at least MIN_SECRET_LENGTH characters when
 *     VERCEL_ENV is 'production'.
 *   - CRON_SECRET_DESTRUCTIVE — second tier for jobs in DESTRUCTIVE_JOBS
 *     (and for routes passing alwaysDestructive). Those need EITHER a
 *     vercel-cron user-agent (Vercel-fired schedule) OR an explicit
 *     X-Destructive-Secret header. This blocks ad-hoc curl invocations of
 *     merge/prune/replay jobs from anyone holding only the base secret.
 *
 * Why not pure per-job env vars: Vercel cron triggers send a single
 * Authorization header derived from CRON_SECRET. Adding 39 separate
 * env vars (one per job) is incompatible with the Vercel cron model
 * AND adds rotation pain that exceeds the security gain. A single
 * destructive-class secret is the right granularity.
 *
 * S2 changes, all fail-closed:
 *   1. Comparison is constant-time (crypto.timingSafeEqual over
 *      equal-length buffers) rather than `===` on a template string.
 *      The old inline shape produced the literal `Bearer undefined` when
 *      CRON_SECRET was unset, which a caller could simply send.
 *   2. An unset CRON_SECRET is a 503 (server misconfigured), not a 401.
 *      Nothing runs.
 *   3. A CRON_SECRET shorter than MIN_SECRET_LENGTH is refused in
 *      production. Short secrets are guessable and the whole admin ops
 *      surface hangs off this one value.
 *   4. The destructive tier is no longer opt-in in production. It used
 *      to return ok when CRON_SECRET_DESTRUCTIVE was unset, which meant
 *      the hardening was off by default on the deployment that needed it
 *      most. Unset in production now refuses with a 503 naming the var.
 *      Local dev keeps the permissive behaviour behind a logged warning
 *      so nobody has to invent a second secret to run a sweep by hand.
 */

/**
 * Jobs that mutate identity-resolution state, dedup people / weddings,
 * delete telemetry, or send outbound emails to real people. Adding a
 * job here makes it require the destructive secret on non-Vercel-cron
 * traffic, and makes it refuse outright in production while
 * CRON_SECRET_DESTRUCTIVE is unset.
 *
 * Conservative bias: when in doubt, mark destructive. Cost of a
 * false-positive is "ops has to set the X-Destructive-Secret header
 * on a curl invocation"; cost of a false-negative is a leaked
 * CRON_SECRET triggering data corruption.
 */
export const DESTRUCTIVE_JOBS: ReadonlySet<string> = new Set([
  // Identity-resolution mutations
  'data_integrity_sweep',
  'backtrace_scan',
  'phase_b_sweep',
  'merge_people_aliases',
  'booked_data_recovery',
  're_engagement_attribution',
  // Telemetry / data deletion
  'prune_telemetry',
  'prune_rate_limits',
  'prune_maintenance',
  'prune_brain_dump_stale',
  'prune_expired_pulse_snoozes',
  // Outbound to real people
  'follow_up_sequences',
  // Voice DNA mutates per-venue voice anchors
  'voice_dna_refresh',
  // Wave 4 Phase 2 (2026-05-09). Identity-judge sweep spends Sonnet budget
  // per couple. Conservative classification: a leaked CRON_SECRET being
  // used to fire-and-forget thousands of curl invocations could rack up
  // significant LLM cost. Add the destructive gate so non-Vercel-cron
  // callers must carry the secondary header.
  'identity_judge_sweep',
  // Wave 5A (2026-05-09). Per-couple intel derive sweep. Same Sonnet
  // cost class as identity_judge_sweep — drains couple_intel_jobs and
  // refreshes drift. Same destructive treatment.
  'couple_intel_sweep',
  // Wave 5B (2026-05-10). Per-venue cohort rollup synthesizer.
  'cohort_rollup_sweep',
  // Wave 6A (2026-05-10). Marketing spend connector sync.
  'spend_sync_sweep',
  // Wave 7B (2026-05-10). Forensic channel-role classifier.
  'attribution_role_sweep',
  // Wave 5C (2026-05-10). External-signal cohort matcher (vendor
  // mentions, competitor scan, cohort-fit cultural moment scoring).
  'external_match_sweep',
  // Wave 6B (2026-05-10). Persona × channel × revenue rollup recompute.
  'persona_channel_rollup_sweep',
  // Wave 7A (2026-05-10). Pattern discovery engine — Sonnet hypothesis hunter.
  'discovery_engine_sweep',
  // Wave 5D (2026-05-10). Venue thesis + cross-venue overlap.
  'venue_thesis_sweep',
  // Wave 6C (2026-05-10). Marketing reallocation recommendations analyst.
  'marketing_recommendation_sweep',
  // Wave 7C (2026-05-10). Hypothesis validation engine.
  'hypothesis_validation_sweep',
  // Wave 6D (2026-05-10). Spend loop flag detector.
  'spend_loop_flag_sweep',
  // Wave 6D (2026-05-10). Weekly marketing digest builder.
  'marketing_digest_sweep',
  // Wave 8 (2026-05-10). External signals health-check + auto-derive sweep.
  'external_signals_health_sweep',
  // Wave 9 (2026-05-10). Data-integrity remediation sweep.
  'integrity_remediation_sweep',
  // Wave 11 (2026-05-10). Lifecycle state machine sweep.
  'lifecycle_sweep',
  // Wave 13 (2026-05-11). Tour-prep brief generator (Sonnet write).
  'tour_prep_brief_sweep',
  // Wave 13 (2026-05-11). Review solicitation sweep (drafts queued, never auto-sent).
  'review_solicit_sweep',
  // Wave 14 (2026-05-10). Referral extractor sibling-of-reconstruction.
  'referral_extraction_sweep',
  // Wave 14 (2026-05-10). Alumni cohort generator (Sonnet aggregator).
  'alumni_cohort_sweep',
  // W6 / November Plan (2026-09-08). Loop-closure dispatchers — each
  // fans out to sweeps that are already individually destructive
  // (spend_sync_sweep, attribution_role_sweep, persona_channel_rollup_sweep,
  // marketing_recommendation_sweep, spend_loop_flag_sweep,
  // marketing_digest_sweep, voice_dna_refresh's sibling voice_dna_sweep)
  // or spend Sonnet budget (calibration_sweep's catch-up pass is cheap
  // but the whole chain adds up). Same conservative bias as the rest
  // of this file.
  'loops_daily',
  'loops_weekly',
  // W6 (2026-09-08). Drains measure_outcome_jobs + writes
  // prediction_outcomes. Data-mutation class, same treatment as its
  // sibling sweeps above.
  'calibration_sweep',
  // W6 (2026-09-08). Mutates voice_dna_derivations + spends Sonnet
  // budget per venue, same class as voice_dna_refresh above.
  'voice_dna_sweep',
])

import { timingSafeEqual } from 'node:crypto'

/**
 * Minimum CRON_SECRET length accepted in production. `openssl rand -hex
 * 32` gives 64 characters; 32 is the floor below which the value is
 * almost certainly a hand-typed placeholder rather than random bytes.
 */
export const MIN_SECRET_LENGTH = 32

/** Vercel sets VERCEL_ENV to 'production' only on the production deployment. */
function inProduction(): boolean {
  return process.env.VERCEL_ENV === 'production'
}

/**
 * Whether a cron secret exists at all. For routes that offer a second
 * credential (the test harness, say) and want to answer 501 "no
 * credential configured" rather than 401 "wrong credential". Reading
 * process.env.CRON_SECRET inside a route is a CI failure by design —
 * scripts/check-cron-auth-helper.mjs — so ask here instead.
 */
export function isCronSecretConfigured(): boolean {
  return Boolean(process.env.CRON_SECRET)
}

/**
 * Constant-time compare of two secrets. Unequal lengths short-circuit —
 * timingSafeEqual throws on mismatched buffers — so the length is
 * observable but never the bytes.
 */
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf-8')
  const b = Buffer.from(expected, 'utf-8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export type CronAuthResult =
  | { ok: true }
  | { ok: false; status: number; error: string }

export interface CronAuthOpts {
  /**
   * Job name from the route's query param. Required if the route
   * dispatches multiple jobs from one path (e.g., /api/cron?job=...).
   * If absent, treats the request as non-destructive.
   */
  jobName?: string
  /**
   * Force destructive treatment regardless of jobName lookup. Use for
   * routes that are always destructive (e.g., replay-paused-skipped,
   * recover-booked-data).
   */
  alwaysDestructive?: boolean
}

/**
 * Verify a cron route is being hit with valid credentials. Caller
 * decides what to do with the failure (return 401 or 403).
 */
export function verifyCronAuth(req: Request, opts: CronAuthOpts = {}): CronAuthResult {
  // ----- Tier 1: base secret (always required) -----
  const baseSecret = process.env.CRON_SECRET
  if (!baseSecret) {
    // 503, not 401: the caller did nothing wrong, the deployment is
    // misconfigured. Either way nothing downstream runs.
    return { ok: false, status: 503, error: 'CRON_SECRET unset' }
  }
  if (inProduction() && baseSecret.length < MIN_SECRET_LENGTH) {
    return {
      ok: false,
      status: 503,
      error: `CRON_SECRET shorter than ${MIN_SECRET_LENGTH} characters`,
    }
  }
  const auth = req.headers.get('authorization')
  if (!auth || !secretsMatch(auth, `Bearer ${baseSecret}`)) {
    return { ok: false, status: 401, error: 'invalid Authorization' }
  }

  // ----- Tier 2: destructive secondary (when configured) -----
  const isDestructive =
    opts.alwaysDestructive === true ||
    (opts.jobName ? DESTRUCTIVE_JOBS.has(opts.jobName) : false)

  if (!isDestructive) return { ok: true }

  const destSecret = process.env.CRON_SECRET_DESTRUCTIVE
  if (!destSecret) {
    if (inProduction()) {
      // Was: fall through to single-secret behaviour. That made the
      // destructive gate inert exactly where it matters — a leaked
      // CRON_SECRET could fire every merge, prune and replay job in the
      // set. Refuse instead, and name the variable so the fix is obvious
      // from the response body.
      return {
        ok: false,
        status: 503,
        error:
          'destructive job refused: CRON_SECRET_DESTRUCTIVE is unset in production',
      }
    }
    console.warn(
      '[cron-auth] CRON_SECRET_DESTRUCTIVE is unset. Allowing this ' +
        'destructive job because VERCEL_ENV is not production. Set the ' +
        'variable in Vercel before the next production deploy or every ' +
        'destructive job will answer 503.',
    )
    return { ok: true }
  }

  // Either Vercel-fired (UA matches) OR explicit secondary header.
  const ua = req.headers.get('user-agent') ?? ''
  const isVercelCron = ua.startsWith('vercel-cron/')

  if (isVercelCron) return { ok: true }

  const dstHeader = req.headers.get('x-destructive-secret')
  if (!dstHeader || !secretsMatch(dstHeader, destSecret)) {
    return {
      ok: false,
      status: 403,
      error:
        'destructive job requires X-Destructive-Secret header or vercel-cron user-agent',
    }
  }

  return { ok: true }
}
