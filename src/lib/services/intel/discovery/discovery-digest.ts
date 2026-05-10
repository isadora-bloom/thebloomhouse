/**
 * Bloom House — Wave 7D weekly discovery digest builder.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 7D closes the discovery loop. The
 *     digest is the weekly story of what the engine surfaced, what the
 *     validator confirmed, and which Wave 5/6 systems received feedback.)
 *   - bloom-wave4-5-6-master-plan.md (Wave 7D spec)
 *   - feedback_parallel_stream_safety.md (Wave 7D writes ONLY to mig-274
 *     tables; Wave 6D's marketing-spend/loop/digest-builder.ts is read-
 *     only — this is a SIBLING, not a modification.)
 *
 * What this module does
 * ---------------------
 * For one venue, build the weekly discovery digest:
 *   1. Pull top 3 newly-validated discoveries this week.
 *   2. Pull top 3 pending high-confidence (>= 70) discoveries.
 *   3. Roll up key feedback actions taken this week.
 *   4. Call Sonnet to write the headline + 2-3 sentence narrative.
 *   5. Upsert into discovery_digests (one row per (venue, week)).
 *
 * Idempotency
 * -----------
 * The unique index on (venue_id, digest_period_start, digest_period_end)
 * makes (venue, week) the natural identity. Re-running the builder for
 * the same week REPLACES digest_jsonb in place. Sonnet is called every
 * time so the narration reflects the latest evidence.
 *
 * Refusal
 * -------
 * The narrator refuses with "no validated discoveries this week" when
 * the evidence block is empty (no validated, no high-confidence pending,
 * no feedback actions). The empty-evidence short-circuit avoids burning
 * Sonnet on a refusal-shaped output.
 *
 * Cost target ~$0.04 per digest (one Sonnet call with ~1-2k tokens of
 * structured evidence + ~600 tokens of narrator output).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { callAI } from '@/lib/ai/client'
import { logEvent } from '@/lib/observability/logger'
import {
  DISCOVERY_DIGEST_PROMPT_VERSION,
  buildDiscoveryDigestSystemPrompt,
  buildDiscoveryDigestUserPrompt,
  validateDiscoveryDigestOutput,
  type DiscoveryDigestEvidence,
  type DiscoveryDigestOutput,
  type DigestValidatedEvidence,
  type DigestPendingEvidence,
  type DigestFeedbackActionEvidence,
} from '@/config/prompts/discovery-digest'

export { DISCOVERY_DIGEST_PROMPT_VERSION } from '@/config/prompts/discovery-digest'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildDiscoveryDigestOptions {
  supabase?: SupabaseClient
  /** Optional override for the digest week. Defaults to most-recent
   *  Monday-Sunday week (UTC). */
  periodStart?: string
  periodEnd?: string
  correlationId?: string
}

export interface BuildDiscoveryDigestResult {
  ok: true
  digestId: string
  digestJsonb: DiscoveryDigestOutput
  costCents: number
  promptVersion: string
  periodStart: string
  periodEnd: string
  diagnostics: {
    validatedScanned: number
    pendingScanned: number
    feedbackActionsScanned: number
  }
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const MAX_OUTPUT_TOKENS = 1500
const TEMPERATURE = 0.4
const TOP_VALIDATED = 3
const TOP_PENDING = 3
const PENDING_CONFIDENCE_FLOOR = 70
const MS_PER_DAY = 86_400_000

// ---------------------------------------------------------------------------
// Period math (mirrors marketing-digest defaultDigestPeriod)
// ---------------------------------------------------------------------------

function isoDate(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function defaultDigestPeriod(): { start: string; end: string } {
  const now = new Date()
  const dayOfWeek = now.getUTCDay()
  const daysToLastSunday = dayOfWeek === 0 ? 7 : dayOfWeek
  const lastSunday = new Date(now.getTime() - daysToLastSunday * MS_PER_DAY)
  const lastMonday = new Date(lastSunday.getTime() - 6 * MS_PER_DAY)
  return { start: isoDate(lastMonday), end: isoDate(lastSunday) }
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function loadVenueLabel(
  supabase: SupabaseClient,
  venueId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('venues')
    .select('name')
    .eq('id', venueId)
    .maybeSingle()
  return ((data as { name?: string | null } | null)?.name ?? null) || null
}

async function loadValidatedThisWeek(
  supabase: SupabaseClient,
  venueId: string,
  periodStart: string,
  periodEnd: string,
): Promise<DigestValidatedEvidence[]> {
  const startIso = new Date(`${periodStart}T00:00:00Z`).toISOString()
  const endIso = new Date(`${periodEnd}T23:59:59Z`).toISOString()
  const { data, error } = await supabase
    .from('intel_discoveries')
    .select(
      'hypothesis_title, hypothesis_category, validated_at, confidence_0_100, validation_metric, feedback_applied_at',
    )
    .eq('venue_id', venueId)
    .eq('validation_status', 'validated')
    .gte('validated_at', startIso)
    .lte('validated_at', endIso)
    .order('validated_at', { ascending: false })
    .limit(20)
  if (error) {
    logEvent({
      level: 'warn',
      msg: 'discovery_digest.load_validated_failed',
      event_type: 'wave_7d.digest',
      outcome: 'fail',
      venueId,
      data: { error: error.message },
    })
    return []
  }
  const rows = (data ?? []) as Array<{
    hypothesis_title: string
    hypothesis_category: string
    validated_at: string | null
    confidence_0_100: number
    validation_metric: Record<string, unknown> | null
    feedback_applied_at: string | null
  }>
  return rows.slice(0, TOP_VALIDATED).map((r) => ({
    title: r.hypothesis_title,
    hypothesis_category: r.hypothesis_category,
    validated_at: r.validated_at,
    confidence_0_100: r.confidence_0_100,
    metric_summary: summariseMetric(r.validation_metric),
    feedback_applied: !!r.feedback_applied_at,
  }))
}

function summariseMetric(metric: Record<string, unknown> | null): string | null {
  if (!metric || typeof metric !== 'object') return null
  const parts: string[] = []
  const lift = metric.lift_pct
  if (typeof lift === 'number' && Number.isFinite(lift)) {
    parts.push(`lift=${lift.toFixed(1)}%`)
  }
  const nT = metric.n_treatment
  const nC = metric.n_control
  if (typeof nT === 'number' && typeof nC === 'number') {
    parts.push(`n=${nT}/${nC}`)
  } else if (typeof nT === 'number') {
    parts.push(`n=${nT}`)
  }
  const p = metric.p_value_approx
  if (typeof p === 'number' && Number.isFinite(p)) {
    parts.push(`p≈${p.toFixed(3)}`)
  }
  if (parts.length === 0) return null
  return parts.join(', ')
}

async function loadPendingHighConfidence(
  supabase: SupabaseClient,
  venueId: string,
): Promise<DigestPendingEvidence[]> {
  const { data, error } = await supabase
    .from('intel_discoveries')
    .select(
      'hypothesis_title, hypothesis_category, confidence_0_100, created_at',
    )
    .eq('venue_id', venueId)
    .eq('validation_status', 'pending')
    .gte('confidence_0_100', PENDING_CONFIDENCE_FLOOR)
    .order('confidence_0_100', { ascending: false })
    .limit(20)
  if (error) {
    logEvent({
      level: 'warn',
      msg: 'discovery_digest.load_pending_failed',
      event_type: 'wave_7d.digest',
      outcome: 'fail',
      venueId,
      data: { error: error.message },
    })
    return []
  }
  return ((data ?? []) as Array<{
    hypothesis_title: string
    hypothesis_category: string
    confidence_0_100: number
    created_at: string | null
  }>)
    .slice(0, TOP_PENDING)
    .map((r) => ({
      title: r.hypothesis_title,
      hypothesis_category: r.hypothesis_category,
      confidence_0_100: r.confidence_0_100,
      created_at: r.created_at,
    }))
}

async function loadFeedbackActionsThisWeek(
  supabase: SupabaseClient,
  venueId: string,
  periodStart: string,
  periodEnd: string,
): Promise<DigestFeedbackActionEvidence[]> {
  const startIso = new Date(`${periodStart}T00:00:00Z`).toISOString()
  const endIso = new Date(`${periodEnd}T23:59:59Z`).toISOString()
  const { data, error } = await supabase
    .from('discovery_feedback_actions')
    .select('target_system, action_type, error')
    .eq('venue_id', venueId)
    .gte('written_at', startIso)
    .lte('written_at', endIso)
    .limit(2000)
  if (error) {
    logEvent({
      level: 'warn',
      msg: 'discovery_digest.load_actions_failed',
      event_type: 'wave_7d.digest',
      outcome: 'fail',
      venueId,
      data: { error: error.message },
    })
    return []
  }
  const counts = new Map<string, number>()
  for (const r of (data ?? []) as Array<{
    target_system: string
    action_type: string
    error: string | null
  }>) {
    if (r.error) continue // exclude failed writes from the digest
    const key = `${r.target_system}|${r.action_type}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const out: DigestFeedbackActionEvidence[] = []
  for (const [key, count] of counts.entries()) {
    const [target_system, action_type] = key.split('|')
    out.push({ target_system, action_type, count })
  }
  out.sort((a, b) => b.count - a.count)
  return out.slice(0, 5)
}

// ---------------------------------------------------------------------------
// JSON fence stripping (defensive)
// ---------------------------------------------------------------------------

function stripJsonFences(text: string): string {
  return text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function buildDiscoveryDigest(
  venueId: string,
  options: BuildDiscoveryDigestOptions = {},
): Promise<BuildDiscoveryDigestResult> {
  const supabase = options.supabase ?? createServiceClient()
  const correlationId = options.correlationId

  const period =
    options.periodStart && options.periodEnd
      ? { start: options.periodStart, end: options.periodEnd }
      : defaultDigestPeriod()
  const { start: periodStart, end: periodEnd } = period

  const [venueLabel, validatedThisWeek, pendingHighConfidence, feedbackActionsThisWeek] =
    await Promise.all([
      loadVenueLabel(supabase, venueId),
      loadValidatedThisWeek(supabase, venueId, periodStart, periodEnd),
      loadPendingHighConfidence(supabase, venueId),
      loadFeedbackActionsThisWeek(supabase, venueId, periodStart, periodEnd),
    ])

  const evidence: DiscoveryDigestEvidence = {
    venueId,
    venueLabel,
    digestPeriodStart: periodStart,
    digestPeriodEnd: periodEnd,
    validatedThisWeek,
    pendingHighConfidence,
    feedbackActionsThisWeek,
  }

  const diagnostics = {
    validatedScanned: validatedThisWeek.length,
    pendingScanned: pendingHighConfidence.length,
    feedbackActionsScanned: feedbackActionsThisWeek.length,
  }

  // Empty-evidence short-circuit: if there's nothing to narrate, write a
  // refusal digest WITHOUT calling Sonnet.
  const evidenceIsEmpty =
    validatedThisWeek.length === 0 &&
    pendingHighConfidence.length === 0 &&
    feedbackActionsThisWeek.length === 0

  let output: DiscoveryDigestOutput
  let costCents = 0

  if (evidenceIsEmpty) {
    output = {
      headline: 'No validated discoveries this week',
      this_week_in_3_sentences:
        'No discoveries were validated, no high-confidence hypotheses are pending review, and no feedback actions landed this week. The discovery loop may be quiet because the engine has not run, the cohort is too thin, or the validator has only inconclusive runs. Run the Wave 7A discovery engine + Wave 7C validator before next week to confirm.',
      top_validated_discoveries: [],
      top_pending_high_confidence: [],
      key_feedback_actions: [],
      refusal:
        'No validated discoveries this week — no digest-worthy signal',
    }
  } else {
    const systemPrompt = buildDiscoveryDigestSystemPrompt()
    const userPrompt = buildDiscoveryDigestUserPrompt(evidence)
    const aiResult = await callAI({
      systemPrompt:
        systemPrompt +
        '\n\nRespond with valid JSON only. No markdown, no code blocks, no explanation.',
      userPrompt,
      tier: 'sonnet',
      taskType: 'discovery_digest',
      contentTier: 4, // anonymised aggregates only
      promptVersion: DISCOVERY_DIGEST_PROMPT_VERSION,
      venueId,
      maxTokens: MAX_OUTPUT_TOKENS,
      temperature: TEMPERATURE,
      correlationId,
    })

    const cleaned = stripJsonFences(aiResult.text)
    let parsed: unknown
    try {
      parsed = JSON.parse(cleaned)
    } catch (parseErr) {
      const message =
        parseErr instanceof Error ? parseErr.message : String(parseErr)
      throw new Error(
        `buildDiscoveryDigest: LLM returned non-JSON. parseError=${message} rawResponse=${cleaned.slice(0, 2000)}`,
      )
    }
    const validation = validateDiscoveryDigestOutput(parsed)
    if (!validation.ok) {
      throw new Error(
        `buildDiscoveryDigest: schema validation failed. error=${validation.error} rawResponse=${cleaned.slice(0, 2000)}`,
      )
    }
    output = validation.output
    costCents = aiResult.cost * 100
  }

  // Upsert. The unique index on (venue, period_start, period_end) handles
  // re-running the same week.
  const { data: written, error: writeErr } = await supabase
    .from('discovery_digests')
    .upsert(
      {
        venue_id: venueId,
        digest_period_start: periodStart,
        digest_period_end: periodEnd,
        digest_jsonb: output,
        cost_cents: costCents,
        prompt_version: DISCOVERY_DIGEST_PROMPT_VERSION,
        generated_at: new Date().toISOString(),
      },
      { onConflict: 'venue_id,digest_period_start,digest_period_end' },
    )
    .select('id')
    .single()
  if (writeErr || !written) {
    throw new Error(
      `buildDiscoveryDigest: upsert failed: ${writeErr?.message ?? 'no row returned'}`,
    )
  }

  logEvent({
    level: 'info',
    msg: 'discovery_digest.complete',
    event_type: 'wave_7d.digest',
    outcome: 'ok',
    venueId,
    data: {
      digestId: (written as { id: string }).id,
      periodStart,
      periodEnd,
      headline: output.headline,
      refusal: output.refusal,
      costCents,
      ...diagnostics,
    },
  })

  return {
    ok: true,
    digestId: (written as { id: string }).id,
    digestJsonb: output,
    costCents,
    promptVersion: DISCOVERY_DIGEST_PROMPT_VERSION,
    periodStart,
    periodEnd,
    diagnostics,
  }
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export interface StoredDiscoveryDigestRow {
  id: string
  venue_id: string
  digest_period_start: string
  digest_period_end: string
  digest_jsonb: DiscoveryDigestOutput
  delivered_via: string | null
  delivered_at: string | null
  cost_cents: number | string
  prompt_version: string | null
  generated_at: string
  created_at: string
}

export async function getLatestDiscoveryDigest(
  venueId: string,
  supabase: SupabaseClient = createServiceClient(),
): Promise<StoredDiscoveryDigestRow | null> {
  const { data, error } = await supabase
    .from('discovery_digests')
    .select(
      'id, venue_id, digest_period_start, digest_period_end, digest_jsonb, delivered_via, delivered_at, cost_cents, prompt_version, generated_at, created_at',
    )
    .eq('venue_id', venueId)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(`getLatestDiscoveryDigest: ${error.message}`)
  }
  return (data as StoredDiscoveryDigestRow | null) ?? null
}
