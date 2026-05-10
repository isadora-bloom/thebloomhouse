/**
 * Bloom House — Wave 7C validation orchestrator.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 7C closes the discovery loop —
 *     Wave 7A produces hypotheses, Wave 7C validates them, Wave 7D
 *     promotes validated discoveries into Wave 5/6 buckets.)
 *   - bloom-wave4-5-6-master-plan.md (Wave 7C spec)
 *   - bloom-data-integrity-sweep.md (aggregate ≠ disclose — designer +
 *     executor + interpreter all see anonymised aggregates only.)
 *   - bloom-may9-llm-vs-template.md (designer + interpreter are real
 *     Sonnet calls, never templates.)
 *   - feedback_audit_agents_overclaim.md (every cell here is verified
 *     end-to-end before reporting done — designer call, executor query,
 *     interpreter call, persisted run row, updated discovery state.)
 *
 * What this module does
 * ---------------------
 * For one intel_discoveries row, run the full validation pipeline:
 *   1. Load the discovery (and the venue's anonymised cohort context
 *      for the designer's evidence_summary input).
 *   2. Sonnet designer call → structured test plan.
 *   3. Persist the test plan onto intel_discoveries.validation_test_plan
 *      and start an in-progress hypothesis_validation_runs row.
 *   4. Run the test executor against the test plan.
 *   5. Sonnet interpreter call → categorical verdict + reasoning.
 *   6. Persist test_result + interpretation + reasoning onto the run row.
 *   7. Update intel_discoveries.validation_status:
 *        validated → 'validated'
 *        refuted → 'refuted'
 *        inconclusive | data_too_thin → 'in_progress'
 *      (Re-runs may flip in_progress to a verdict once cohort grows.)
 *   8. Bump intel_discoveries.validation_runs_count.
 *
 * Cost target ~$0.05-0.15 per validation (two Sonnet calls with
 * modest input/output token shapes — designer reads anonymised summary
 * + hypothesis text; interpreter reads test plan + numeric results).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { callAI } from '@/lib/ai/client'
import {
  HYPOTHESIS_VALIDATOR_PROMPT_VERSION,
  buildHypothesisDesignerSystemPrompt,
  buildHypothesisDesignerUserPrompt,
  buildHypothesisInterpreterSystemPrompt,
  buildHypothesisInterpreterUserPrompt,
  validateHypothesisDesignerOutput,
  validateHypothesisInterpreterOutput,
  type DesignerEvidence,
  type HypothesisTestPlan,
  type HypothesisInterpretation,
} from '@/config/prompts/hypothesis-validator'
import {
  executeValidationTest,
  type TestExecutionResult,
} from './test-executor'

export { HYPOTHESIS_VALIDATOR_PROMPT_VERSION } from '@/config/prompts/hypothesis-validator'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunHypothesisValidationInput {
  discoveryId: string
}

export interface RunHypothesisValidationOptions {
  supabase?: SupabaseClient
  /** Optional correlation id (threaded into api_costs.correlation_id). */
  correlationId?: string
}

export interface RunHypothesisValidationResult {
  runId: string
  discoveryId: string
  venueId: string
  interpretation: HypothesisInterpretation
  confidence_0_100: number
  testPlan: HypothesisTestPlan
  testResult: TestExecutionResult
  costCents: number
  promptVersion: string
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

interface DiscoveryRow {
  id: string
  venue_id: string
  hypothesis_title: string
  hypothesis_text: string
  hypothesis_category: string
  evidence_summary: Record<string, unknown> | null
  recommended_test: string | null
  validation_runs_count: number | null
}

async function loadDiscovery(
  supabase: SupabaseClient,
  discoveryId: string,
): Promise<DiscoveryRow | null> {
  const { data } = await supabase
    .from('intel_discoveries')
    .select(
      'id, venue_id, hypothesis_title, hypothesis_text, hypothesis_category, evidence_summary, recommended_test, validation_runs_count',
    )
    .eq('id', discoveryId)
    .maybeSingle()
  return (data as DiscoveryRow | null) ?? null
}

interface CohortSnapshot {
  channel_role_summary: DesignerEvidence['channel_role_summary']
  persona_labels: string[]
  total_couples_in_cohort: number
}

async function loadCohortSnapshot(
  supabase: SupabaseClient,
  venueId: string,
): Promise<CohortSnapshot> {
  const [attrRes, intelRes] = await Promise.all([
    supabase
      .from('attribution_events')
      .select('source_platform, role')
      .eq('venue_id', venueId)
      .is('reverted_at', null)
      .limit(2000),
    supabase
      .from('couple_intel')
      .select('persona_label')
      .eq('venue_id', venueId)
      .limit(2000),
  ])

  const attributions =
    (attrRes.data ?? []) as Array<{ source_platform: string; role: string | null }>
  const intel = (intelRes.data ?? []) as Array<{ persona_label: string | null }>

  const channelMap = new Map<
    string,
    { acquisition_count: number; validation_count: number; conversion_count: number }
  >()
  for (const a of attributions) {
    const key = (a.source_platform || 'other').toLowerCase()
    let entry = channelMap.get(key)
    if (!entry) {
      entry = { acquisition_count: 0, validation_count: 0, conversion_count: 0 }
      channelMap.set(key, entry)
    }
    const role = (a.role || 'unknown').toLowerCase()
    if (role === 'acquisition') entry.acquisition_count += 1
    else if (role === 'validation') entry.validation_count += 1
    else if (role === 'conversion') entry.conversion_count += 1
  }

  const channelRoleSummary: CohortSnapshot['channel_role_summary'] = []
  for (const [platform, counts] of channelMap.entries()) {
    channelRoleSummary.push({
      source_platform: platform,
      ...counts,
    })
  }
  channelRoleSummary.sort((a, b) => {
    const ta = a.acquisition_count + a.validation_count + a.conversion_count
    const tb = b.acquisition_count + b.validation_count + b.conversion_count
    return tb - ta
  })

  const personaSet = new Set<string>()
  for (const r of intel) {
    if (r.persona_label) personaSet.add(r.persona_label)
  }

  return {
    channel_role_summary: channelRoleSummary.slice(0, 12),
    persona_labels: Array.from(personaSet).slice(0, 30),
    total_couples_in_cohort: intel.length,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripJsonFences(text: string): string {
  return text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
}

function statusForInterpretation(
  interpretation: HypothesisInterpretation,
): string {
  if (interpretation === 'validated') return 'validated'
  if (interpretation === 'refuted') return 'refuted'
  // inconclusive + data_too_thin: keep the discovery in_progress so the
  // dashboard shows it as an active validation cycle that can be re-run
  // when cohort grows.
  return 'in_progress'
}

interface DesignerEvidenceSummaryFragment {
  signal_type?: unknown
  n_couples?: unknown
}

function extractEvidenceFragment(
  evidenceSummary: Record<string, unknown> | null,
): { signal_type: string | null; n_couples: number | null } {
  if (!evidenceSummary || typeof evidenceSummary !== 'object') {
    return { signal_type: null, n_couples: null }
  }
  const frag = evidenceSummary as DesignerEvidenceSummaryFragment
  const signalType =
    typeof frag.signal_type === 'string' ? (frag.signal_type as string) : null
  const nCouples =
    typeof frag.n_couples === 'number' && Number.isFinite(frag.n_couples)
      ? (frag.n_couples as number)
      : null
  return { signal_type: signalType, n_couples: nCouples }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runHypothesisValidation(
  input: RunHypothesisValidationInput,
  options: RunHypothesisValidationOptions = {},
): Promise<RunHypothesisValidationResult> {
  const supabase = options.supabase ?? createServiceClient()
  const correlationId = options.correlationId

  const discoveryId = input.discoveryId
  if (!discoveryId) {
    throw new Error('runHypothesisValidation: discoveryId required')
  }

  // Step 1 — load discovery + cohort snapshot.
  const discovery = await loadDiscovery(supabase, discoveryId)
  if (!discovery) {
    throw new Error(
      `runHypothesisValidation: discovery ${discoveryId} not found`,
    )
  }
  const venueId = discovery.venue_id

  const cohort = await loadCohortSnapshot(supabase, venueId)
  const evFrag = extractEvidenceFragment(discovery.evidence_summary)

  // Step 2 — Sonnet designer call.
  const designerEvidence: DesignerEvidence = {
    hypothesis_title: discovery.hypothesis_title,
    hypothesis_text: discovery.hypothesis_text,
    hypothesis_category: discovery.hypothesis_category,
    recommended_test: discovery.recommended_test,
    evidence_signal_type: evFrag.signal_type,
    evidence_n_couples: evFrag.n_couples,
    total_couples_in_cohort: cohort.total_couples_in_cohort,
    channel_role_summary: cohort.channel_role_summary,
    persona_labels: cohort.persona_labels,
  }

  // Mark validation_started_at so a stuck run is observable.
  await supabase
    .from('intel_discoveries')
    .update({ validation_started_at: new Date().toISOString() })
    .eq('id', discoveryId)

  const designerSystem = buildHypothesisDesignerSystemPrompt()
  const designerUser = buildHypothesisDesignerUserPrompt(designerEvidence)

  // Designer: temperature 0.2 — deterministic test design. contentTier 2
  // (anonymised cohort context only). maxTokens 1500 — test plan + brief
  // reasoning fits comfortably.
  const designerCall = await callAI({
    systemPrompt: designerSystem,
    userPrompt: designerUser,
    tier: 'sonnet',
    taskType: 'hypothesis_test_designer',
    contentTier: 2,
    promptVersion: HYPOTHESIS_VALIDATOR_PROMPT_VERSION,
    venueId,
    maxTokens: 1500,
    temperature: 0.2,
    correlationId,
  })

  let designerParsed: unknown
  try {
    designerParsed = JSON.parse(stripJsonFences(designerCall.text))
  } catch (parseErr) {
    const message = parseErr instanceof Error ? parseErr.message : String(parseErr)
    throw new Error(
      `runHypothesisValidation: designer LLM returned non-JSON. parseError=${message}`,
    )
  }
  const designerValidation = validateHypothesisDesignerOutput(designerParsed)
  if (!designerValidation.ok) {
    throw new Error(
      `runHypothesisValidation: designer schema validation failed. error=${designerValidation.error}`,
    )
  }
  const designerOutput = designerValidation.output
  const testPlan = designerOutput.test_plan

  // Step 3 — persist the test plan + open a run row in pending state.
  await supabase
    .from('intel_discoveries')
    .update({ validation_test_plan: testPlan as unknown as Record<string, unknown> })
    .eq('id', discoveryId)

  // Step 4 — execute the test.
  const testResult = await executeValidationTest({
    testPlan,
    venueId,
    supabase,
  })

  // Step 5 — Sonnet interpreter call.
  const interpreterSystem = buildHypothesisInterpreterSystemPrompt()
  const interpreterUser = buildHypothesisInterpreterUserPrompt({
    hypothesis_title: discovery.hypothesis_title,
    hypothesis_text: discovery.hypothesis_text,
    test_plan: testPlan,
    test_result: {
      metric_value_treatment: testResult.metric_value_treatment,
      metric_value_control: testResult.metric_value_control,
      lift_pct: testResult.lift_pct,
      n_treatment: testResult.n_treatment,
      n_control: testResult.n_control,
      p_value_approx: testResult.p_value_approx,
      statistical_test_used: testResult.statistical_test_used,
      errors: testResult.errors,
    },
  })

  // Interpreter: temperature 0.2 — deterministic verdict. maxTokens 1200.
  const interpreterCall = await callAI({
    systemPrompt: interpreterSystem,
    userPrompt: interpreterUser,
    tier: 'sonnet',
    taskType: 'hypothesis_result_interpreter',
    contentTier: 2,
    promptVersion: HYPOTHESIS_VALIDATOR_PROMPT_VERSION,
    venueId,
    maxTokens: 1200,
    temperature: 0.2,
    correlationId,
  })

  let interpreterParsed: unknown
  try {
    interpreterParsed = JSON.parse(stripJsonFences(interpreterCall.text))
  } catch (parseErr) {
    const message = parseErr instanceof Error ? parseErr.message : String(parseErr)
    throw new Error(
      `runHypothesisValidation: interpreter LLM returned non-JSON. parseError=${message}`,
    )
  }
  const interpreterValidation =
    validateHypothesisInterpreterOutput(interpreterParsed)
  if (!interpreterValidation.ok) {
    throw new Error(
      `runHypothesisValidation: interpreter schema validation failed. error=${interpreterValidation.error}`,
    )
  }
  const interpreterOutput = interpreterValidation.output

  // Step 6 — persist hypothesis_validation_runs row.
  const totalCostCents = (designerCall.cost + interpreterCall.cost) * 100

  const { data: insertedRun, error: insertErr } = await supabase
    .from('hypothesis_validation_runs')
    .insert({
      discovery_id: discoveryId,
      venue_id: venueId,
      test_plan: testPlan as unknown as Record<string, unknown>,
      test_result: testResult as unknown as Record<string, unknown>,
      interpretation: interpreterOutput.interpretation,
      confidence_0_100: interpreterOutput.confidence_0_100,
      reasoning: interpreterOutput.reasoning,
      cost_cents: totalCostCents,
      prompt_version: HYPOTHESIS_VALIDATOR_PROMPT_VERSION,
    })
    .select('id')
    .single()

  if (insertErr || !insertedRun) {
    throw new Error(
      `runHypothesisValidation: failed to insert run row: ${insertErr?.message ?? 'unknown'}`,
    )
  }

  const runId = (insertedRun as { id: string }).id

  // Step 7 — update intel_discoveries with verdict + counter + completed_at.
  const newStatus = statusForInterpretation(interpreterOutput.interpretation)
  const newRunsCount = (discovery.validation_runs_count ?? 0) + 1
  const completedAt = new Date().toISOString()

  const updatePayload: Record<string, unknown> = {
    validation_status: newStatus,
    validation_runs_count: newRunsCount,
    validation_completed_at: completedAt,
  }
  if (interpreterOutput.interpretation === 'validated') {
    updatePayload['validated_at'] = completedAt
  }
  // Mirror a short summary onto the discovery's existing summary columns
  // so dashboards reading from intel_discoveries (e.g. Wave 7D) can show
  // the latest verdict without a join. Keep raw audit on the run row.
  updatePayload['validation_result_summary'] = interpreterOutput.reasoning.slice(
    0,
    1000,
  )
  updatePayload['validation_metric'] = {
    metric: testPlan.metric,
    metric_value_treatment: testResult.metric_value_treatment,
    metric_value_control: testResult.metric_value_control,
    lift_pct: testResult.lift_pct,
    n_treatment: testResult.n_treatment,
    n_control: testResult.n_control,
    p_value_approx: testResult.p_value_approx,
    interpretation: interpreterOutput.interpretation,
    confidence_0_100: interpreterOutput.confidence_0_100,
  }

  const { error: updErr } = await supabase
    .from('intel_discoveries')
    .update(updatePayload)
    .eq('id', discoveryId)
  if (updErr) {
    // The run row is already persisted — surface the error but don't
    // throw, the caller can reconcile.
    console.warn(
      '[run-hypothesis-validation] failed to update intel_discoveries:',
      updErr.message,
    )
  }

  // Wave 7D — non-fatal post-validation hook. When this run produced a
  // 'validated' verdict, fire applyDiscoveryFeedback so the consuming
  // Wave 5/6 systems incorporate the insight automatically. Mirrors the
  // Wave 5A → persona-overlay pattern: try/catch swallows the failure
  // so a feedback-loop bug never blocks the validator's primary output.
  // The discovery's feedback_applied_at + the discovery_feedback_actions
  // audit log carry the truth even on partial failure.
  if (newStatus === 'validated') {
    try {
      const { applyDiscoveryFeedback } = await import(
        '../discovery/feedback-loop'
      )
      const fb = await applyDiscoveryFeedback({
        discoveryId,
        supabase,
      })
      if (fb.errors.length > 0) {
        console.warn(
          '[run-hypothesis-validation] feedback-loop reported errors',
          { discoveryId, errors: fb.errors, actionsApplied: fb.actionsApplied },
        )
      }
    } catch (err) {
      console.warn(
        '[run-hypothesis-validation] feedback-loop hook threw',
        {
          discoveryId,
          error: err instanceof Error ? err.message : String(err),
        },
      )
    }
  }

  return {
    runId,
    discoveryId,
    venueId,
    interpretation: interpreterOutput.interpretation,
    confidence_0_100: interpreterOutput.confidence_0_100,
    testPlan,
    testResult,
    costCents: totalCostCents,
    promptVersion: HYPOTHESIS_VALIDATOR_PROMPT_VERSION,
  }
}

// ---------------------------------------------------------------------------
// Read helper — used by GET /validation-result endpoint.
// ---------------------------------------------------------------------------

export interface StoredValidationRunRow {
  id: string
  discovery_id: string
  venue_id: string
  test_plan: Record<string, unknown>
  test_result: Record<string, unknown>
  interpretation: HypothesisInterpretation
  confidence_0_100: number
  reasoning: string | null
  cost_cents: number
  prompt_version: string
  run_at: string
}

export async function getMostRecentValidationRun(
  discoveryId: string,
  supabase: SupabaseClient = createServiceClient(),
): Promise<StoredValidationRunRow | null> {
  const { data, error } = await supabase
    .from('hypothesis_validation_runs')
    .select(
      'id, discovery_id, venue_id, test_plan, test_result, interpretation, confidence_0_100, reasoning, cost_cents, prompt_version, run_at',
    )
    .eq('discovery_id', discoveryId)
    .order('run_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    throw new Error(`getMostRecentValidationRun: ${error.message}`)
  }
  return (data as StoredValidationRunRow | null) ?? null
}
