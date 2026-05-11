/**
 * Wave 22 — Operator-triggered reclassification of v1-prompt-classified
 * attribution_events rows.
 *
 * Anchor docs:
 *   - PROMPT-BIAS-AUDIT.md (Wave 21 audit findings #4 + #18 — the v1
 *     channel-role-classifier and v1 inquiry-intent-judge contained
 *     direction-loaded language that biased the verdicts they were
 *     meant to discover)
 *   - feedback_measure_dont_assume.md (re-measure under v2 — neutral
 *     framing > assumption-loaded framing)
 *   - feedback_audit_agents_overclaim.md (when re-testing, report the
 *     actual numbers, not what we hoped for)
 *
 * Design contract
 * ---------------
 * Operator-triggered only. NOT registered as a cron sweep. The
 * operator-facing surface (POST /api/admin/attribution/reclassify-v1)
 * lets the operator preview "X% of your theknot classifications ran
 * under the bias-suspect prompt — re-run under v2?" and choose.
 *
 * What this module does NOT do
 * ----------------------------
 *   - It does NOT auto-execute. Caller decides when to fire.
 *   - It does NOT modify any other prompt's output.
 *   - It does NOT touch rows where prompt_version_classified_under is
 *     already v2 or NULL (the latter being rule-only paths).
 *
 * Re-test discipline
 * ------------------
 * The first 20 reclassifications on each venue form an audit sample
 * the caller can dump to compare v1 vs v2 verdicts. The Wave 22 audit
 * found Rixey's theknot classifications had ~18-19% reclassify as
 * validation under v1; the re-test reports the v2 number cleanly so
 * the operator sees whether the bias was load-bearing or not.
 *
 * TODO (post-launch): if the operator wants this on a cron, register
 * in vercel.json + cron/route.ts. Wave 22 deliberately ships
 * operator-only to keep the human decision in the loop. Do not
 * register the sweep without an Isadora go-ahead.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import {
  classifyAndPersistAttributionEvent,
  type ClassifyResult,
} from './classify'
import {
  classifyAndPersistInquiryIntent,
  type ClassifyIntentResult,
} from './intent-classifier'
import { CHANNEL_ROLE_CLASSIFIER_PROMPT_VERSION } from '@/config/prompts/channel-role-classifier'
import { INQUIRY_INTENT_JUDGE_PROMPT_VERSION } from '@/config/prompts/inquiry-intent-judge'

// ---------------------------------------------------------------------------
// Constants — the v1 prompt versions that Wave 22 deemed bias-suspect.
// ---------------------------------------------------------------------------
//
// Wave 16 (commit 97ab9ed) shipped to master during Wave 22. The
// inquiry-intent-judge.prompt.v1 was flagged critical by the Wave 21
// audit (finding #18) for the same direction-loaded language as the
// channel-role classifier. Wave 22 bumps both to v2.

const V1_PROMPT_VERSIONS = new Set<string>([
  'channel-role-classifier.prompt.v1',
  'inquiry-intent-judge.prompt.v1',
])

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReclassifyV1Options {
  /** Venue scope. Required — never sweep across venues without intent. */
  venueId: string
  /** Maximum rows to process. Default 20 — Wave 22 audit sample size. */
  limit?: number
  /** When true, perform the LLM calls and persist. When false, just
   *  count + return the candidate row IDs for preview. */
  dryRun?: boolean
  /** Optional caller-provided supabase client. */
  supabase?: SupabaseClient
  /** Optional correlation id for log threading. */
  correlationId?: string
}

export interface ReclassifyV1RowResult {
  attribution_event_id: string
  source_platform: string | null
  /** Verdict under the v1 prompt — captured before re-running. */
  v1_role: string | null
  v1_intent_class: string | null
  /** Verdict under the v2 prompt — null when dryRun or the dimension
   *  wasn't re-run. */
  v2_role: string | null
  v2_intent_class: string | null
  /** Which prompt actually re-ran (role / intent / both / none). */
  rerun_dimension: 'role' | 'intent' | 'both' | 'skip'
  error: string | null
}

export interface ReclassifyV1Summary {
  venue_id: string
  candidates_total: number
  processed: number
  dry_run: boolean
  /** Per-row results when not dry-run; empty when dry-run + many candidates. */
  rows: ReclassifyV1RowResult[]
  /** v1 vs v2 verdict tally for the role dimension (operator audit). */
  role_shift: {
    same: number
    changed: number
    /** breakdown of v2 role distribution, for the operator-facing report */
    v2_distribution: Record<string, number>
    v1_distribution: Record<string, number>
  }
  /** v1 vs v2 verdict tally for the intent dimension (operator audit). */
  intent_shift: {
    same: number
    changed: number
    v2_distribution: Record<string, number>
    v1_distribution: Record<string, number>
  }
}

// ---------------------------------------------------------------------------
// Internal types — rows we load before re-classifying.
// ---------------------------------------------------------------------------

interface CandidateRow {
  id: string
  source_platform: string | null
  role: string | null
  intent_class: string | null
  prompt_version_classified_under: string | null
}

async function loadCandidates(
  sb: SupabaseClient,
  venueId: string,
  limit: number,
): Promise<CandidateRow[]> {
  const { data, error } = await sb
    .from('attribution_events')
    .select(
      'id, source_platform, role, intent_class, prompt_version_classified_under',
    )
    .eq('venue_id', venueId)
    .in('prompt_version_classified_under', Array.from(V1_PROMPT_VERSIONS))
    .is('reverted_at', null)
    .order('decided_at', { ascending: false })
    .limit(limit)
  if (error) {
    throw new Error(`reclassifyV1.loadCandidates: ${error.message}`)
  }
  return (data ?? []) as CandidateRow[]
}

async function countCandidates(
  sb: SupabaseClient,
  venueId: string,
): Promise<number> {
  const { count, error } = await sb
    .from('attribution_events')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .in('prompt_version_classified_under', Array.from(V1_PROMPT_VERSIONS))
    .is('reverted_at', null)
  if (error) {
    throw new Error(`reclassifyV1.countCandidates: ${error.message}`)
  }
  return count ?? 0
}

function bumpDistribution(
  dist: Record<string, number>,
  key: string | null,
): void {
  const k = key ?? '__null__'
  dist[k] = (dist[k] ?? 0) + 1
}

/**
 * Re-run channel-role and inquiry-intent classifiers on v1-classified
 * attribution_events for a venue. Returns a summary the operator-
 * facing endpoint can render as "N rows re-classified, X% verdict
 * shift" without exposing per-row LLM detail.
 */
export async function reclassifyV1AttributionsSweep(
  options: ReclassifyV1Options,
): Promise<ReclassifyV1Summary> {
  const sb = options.supabase ?? createServiceClient()
  const limit = options.limit ?? 20
  const dryRun = options.dryRun ?? false

  const candidates_total = await countCandidates(sb, options.venueId)
  const rows = await loadCandidates(sb, options.venueId, limit)

  const summary: ReclassifyV1Summary = {
    venue_id: options.venueId,
    candidates_total,
    processed: 0,
    dry_run: dryRun,
    rows: [],
    role_shift: {
      same: 0,
      changed: 0,
      v1_distribution: {},
      v2_distribution: {},
    },
    intent_shift: {
      same: 0,
      changed: 0,
      v1_distribution: {},
      v2_distribution: {},
    },
  }

  if (dryRun) {
    return summary
  }

  for (const row of rows) {
    const result: ReclassifyV1RowResult = {
      attribution_event_id: row.id,
      source_platform: row.source_platform,
      v1_role: row.role,
      v1_intent_class: row.intent_class,
      v2_role: null,
      v2_intent_class: null,
      rerun_dimension: 'skip',
      error: null,
    }

    const isV1Role = row.prompt_version_classified_under === 'channel-role-classifier.prompt.v1'
    const isV1Intent = row.prompt_version_classified_under === 'inquiry-intent-judge.prompt.v1'

    try {
      let didRoleRerun = false
      let didIntentRerun = false

      if (isV1Role) {
        const roleResult: ClassifyResult = await classifyAndPersistAttributionEvent(
          { attributionEventId: row.id },
          { supabase: sb, correlationId: options.correlationId },
        )
        result.v2_role = roleResult.role
        didRoleRerun = true
      }

      if (isV1Intent) {
        const intentResult: ClassifyIntentResult = await classifyAndPersistInquiryIntent(
          { attributionEventId: row.id },
          { supabase: sb, correlationId: options.correlationId },
        )
        result.v2_intent_class = intentResult.intentClass
        didIntentRerun = true
      }

      if (didRoleRerun && didIntentRerun) result.rerun_dimension = 'both'
      else if (didRoleRerun) result.rerun_dimension = 'role'
      else if (didIntentRerun) result.rerun_dimension = 'intent'
      else result.rerun_dimension = 'skip'

      // Tally verdict-shift for the operator report.
      if (didRoleRerun) {
        bumpDistribution(summary.role_shift.v1_distribution, row.role)
        bumpDistribution(summary.role_shift.v2_distribution, result.v2_role)
        if ((row.role ?? null) === (result.v2_role ?? null)) {
          summary.role_shift.same += 1
        } else {
          summary.role_shift.changed += 1
        }
      }
      if (didIntentRerun) {
        bumpDistribution(summary.intent_shift.v1_distribution, row.intent_class)
        bumpDistribution(
          summary.intent_shift.v2_distribution,
          result.v2_intent_class,
        )
        if ((row.intent_class ?? null) === (result.v2_intent_class ?? null)) {
          summary.intent_shift.same += 1
        } else {
          summary.intent_shift.changed += 1
        }
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err)
    }

    summary.rows.push(result)
    summary.processed += 1
  }

  // Reference v2 prompt-version constants so a future contributor
  // cannot accidentally let the sweep run under stale versions
  // without bumping this file.
  void CHANNEL_ROLE_CLASSIFIER_PROMPT_VERSION
  void INQUIRY_INTENT_JUDGE_PROMPT_VERSION

  return summary
}
