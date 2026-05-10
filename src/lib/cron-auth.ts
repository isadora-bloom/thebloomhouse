/**
 * Cron auth helper. Tier-C #126.
 *
 * Two-tier model:
 *   - CRON_SECRET — required for every cron route. Verified by all
 *     callers, including Vercel's automatic cron triggers.
 *   - CRON_SECRET_DESTRUCTIVE — optional second tier. When set, jobs in
 *     DESTRUCTIVE_JOBS need EITHER a vercel-cron user-agent (Vercel-
 *     fired schedule) OR an explicit X-Destructive-Secret header. This
 *     blocks ad-hoc curl invocations of merge/prune/replay jobs from
 *     anyone holding only the base CRON_SECRET.
 *
 * Why not pure per-job env vars: Vercel cron triggers send a single
 * Authorization header derived from CRON_SECRET. Adding 39 separate
 * env vars (one per job) is incompatible with the Vercel cron model
 * AND adds rotation pain that exceeds the security gain. A single
 * destructive-class secret is the right granularity.
 *
 * The destructive secret is OPTIONAL by design: leaving CRON_SECRET_
 * DESTRUCTIVE unset preserves the current behaviour (single-secret
 * gate). Setting it enables the harder gate. Opt-in hardening.
 */

/**
 * Jobs that mutate identity-resolution state, dedup people / weddings,
 * delete telemetry, or send outbound emails to real people. Adding a
 * job here makes it require the destructive secret on non-Vercel-cron
 * traffic when CRON_SECRET_DESTRUCTIVE is set.
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
  'identity_backtrack',
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
])

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
    return { ok: false, status: 401, error: 'CRON_SECRET unset' }
  }
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${baseSecret}`) {
    return { ok: false, status: 401, error: 'invalid Authorization' }
  }

  // ----- Tier 2: destructive secondary (when configured) -----
  const isDestructive =
    opts.alwaysDestructive === true ||
    (opts.jobName ? DESTRUCTIVE_JOBS.has(opts.jobName) : false)

  if (!isDestructive) return { ok: true }

  const destSecret = process.env.CRON_SECRET_DESTRUCTIVE
  if (!destSecret) {
    // Opt-in hardening: when the destructive secret isn't configured,
    // we fall back to single-secret behaviour. Document this loudly
    // in the runbook so ops knows whether the gate is active.
    return { ok: true }
  }

  // Either Vercel-fired (UA matches) OR explicit secondary header.
  const ua = req.headers.get('user-agent') ?? ''
  const isVercelCron = ua.startsWith('vercel-cron/')

  if (isVercelCron) return { ok: true }

  const dstHeader = req.headers.get('x-destructive-secret')
  if (dstHeader !== destSecret) {
    return {
      ok: false,
      status: 403,
      error:
        'destructive job requires X-Destructive-Secret header or vercel-cron user-agent',
    }
  }

  return { ok: true }
}
