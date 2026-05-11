/**
 * Bloom House — Wave 17 disagreement narrator service.
 *
 * Anchor docs:
 *   - bloom-constitution.md (operator-readable, never auto-resolves)
 *   - feedback_self_reported_sources_not_truth.md (the disagreement is
 *     the gold; the narrator makes it legible without pre-judging
 *     which side is right)
 *   - bloom-may9-llm-vs-template.md (Haiku tier for bounded-output
 *     narration with low cost; cost target ~$0.002 per finding)
 *
 * What this module does
 * ---------------------
 * For active disagreement_findings rows without a cached narrator_text
 * (or whose stated/forensic values have moved since the cache was
 * written — the detector clears the cache in that case), generate a
 * one-paragraph "the gap and why it matters" narration and cache it on
 * the row.
 *
 * Cost is recorded per row in narrator_cost_cents. Errors are swallowed
 * (logged, never thrown) so one bad row never blocks the sweep.
 *
 * NEVER auto-resolves a disagreement. Operator decides.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { callAI } from '@/lib/ai/client'
import {
  DISAGREEMENT_NARRATOR_PROMPT_VERSION,
  buildDisagreementNarratorSystemPrompt,
  buildDisagreementNarratorUserPrompt,
  validateDisagreementNarratorOutput,
  type DisagreementAxis,
  type DisagreementNarratorEvidence,
} from '@/config/prompts/disagreement-narrator'

interface NarrateArgs {
  /** Narrate one finding by id. */
  findingId?: string
  /** Narrate all uncached active findings for one venue. */
  venueId?: string
  /** Hard cap on findings narrated per call. */
  limit?: number
  /** Supabase override (service-role default). */
  supabase?: SupabaseClient
}

interface NarrateResult {
  scanned: number
  narrated: number
  skipped: number
  errors: string[]
  totalCostCents: number
}

interface FindingRow {
  id: string
  venue_id: string
  wedding_id: string | null
  axis: string
  stated_value: unknown
  stated_source_kind: string | null
  forensic_value: unknown
  forensic_source_kind: string | null
  magnitude_score: number | null
  confidence_0_100: number | null
  narrator_text: string | null
}

interface WeddingLite {
  id: string
  status: string | null
  event_code: string | null
  booking_value: number | null
}

function stripJsonFences(s: string): string {
  return s.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
}

async function narrateOne(
  supabase: SupabaseClient,
  finding: FindingRow,
): Promise<{ ok: boolean; costCents: number; error?: string }> {
  // Pull a tiny bit of wedding context for the narrator.
  let weddingCode: string | null = null
  let weddingStage: string | null = null
  let bookingValue: number | null = null
  if (finding.wedding_id) {
    const { data: wedRaw } = await supabase
      .from('weddings')
      .select('id, status, event_code, booking_value')
      .eq('id', finding.wedding_id)
      .maybeSingle()
    const wed = (wedRaw ?? null) as unknown as WeddingLite | null
    weddingCode = wed?.event_code ?? null
    weddingStage = wed?.status ?? null
    bookingValue = wed?.booking_value ?? null
  }

  const contextNote =
    finding.axis === 'close_prediction' && bookingValue !== null
      ? `Booking value at outcome: $${bookingValue}`
      : null

  const evidence: DisagreementNarratorEvidence = {
    axis: finding.axis as DisagreementAxis,
    wedding_code: weddingCode,
    wedding_stage: weddingStage,
    stated_value: finding.stated_value,
    stated_source_kind: finding.stated_source_kind,
    forensic_value: finding.forensic_value,
    forensic_source_kind: finding.forensic_source_kind,
    magnitude_score: finding.magnitude_score,
    confidence_0_100: finding.confidence_0_100,
    context_note: contextNote,
  }

  const systemPrompt = buildDisagreementNarratorSystemPrompt()
  const userPrompt = buildDisagreementNarratorUserPrompt(evidence)

  let result
  try {
    result = await callAI({
      systemPrompt,
      userPrompt,
      tier: 'haiku',
      taskType: 'disagreement_narrate',
      contentTier: 4, // structured-only, no raw email bodies
      promptVersion: DISAGREEMENT_NARRATOR_PROMPT_VERSION,
      venueId: finding.venue_id,
      maxTokens: 600,
      temperature: 0.2,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, costCents: 0, error: `callAI failed: ${msg}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonFences(result.text))
  } catch {
    return {
      ok: false,
      costCents: result.cost ?? 0,
      error: 'narrator returned non-JSON output',
    }
  }
  const validation = validateDisagreementNarratorOutput(parsed)
  if (!validation.ok) {
    return {
      ok: false,
      costCents: result.cost ?? 0,
      error: `validation failed: ${validation.error}`,
    }
  }

  const combined = `${validation.output.headline}\n\n${validation.output.paragraph}`
  const { error: updErr } = await supabase
    .from('disagreement_findings')
    .update({
      narrator_text: combined,
      narrator_generated_at: new Date().toISOString(),
      narrator_prompt_version: DISAGREEMENT_NARRATOR_PROMPT_VERSION,
      narrator_cost_cents: result.cost ?? 0,
    })
    .eq('id', finding.id)
  if (updErr) {
    return { ok: false, costCents: result.cost ?? 0, error: `update failed: ${updErr.message}` }
  }
  return { ok: true, costCents: result.cost ?? 0 }
}

/**
 * Narrate uncached active disagreement findings.
 */
export async function narrateDisagreements(
  args: NarrateArgs,
): Promise<NarrateResult> {
  const supabase = args.supabase ?? createServiceClient()
  const errors: string[] = []
  let scanned = 0
  let narrated = 0
  let skipped = 0
  let totalCostCents = 0

  let findings: FindingRow[] = []
  if (args.findingId) {
    const { data, error } = await supabase
      .from('disagreement_findings')
      .select(
        'id, venue_id, wedding_id, axis, stated_value, stated_source_kind, ' +
          'forensic_value, forensic_source_kind, magnitude_score, ' +
          'confidence_0_100, narrator_text',
      )
      .eq('id', args.findingId)
      .maybeSingle()
    if (error) {
      errors.push(`load finding: ${error.message}`)
      return { scanned, narrated, skipped, errors, totalCostCents }
    }
    if (data) findings = [data as unknown as FindingRow]
  } else if (args.venueId) {
    const limit = args.limit ?? 50
    const { data, error } = await supabase
      .from('disagreement_findings')
      .select(
        'id, venue_id, wedding_id, axis, stated_value, stated_source_kind, ' +
          'forensic_value, forensic_source_kind, magnitude_score, ' +
          'confidence_0_100, narrator_text',
      )
      .eq('venue_id', args.venueId)
      .eq('status', 'active')
      .is('narrator_text', null)
      .order('magnitude_score', { ascending: false, nullsFirst: false })
      .limit(limit)
    if (error) {
      errors.push(`load findings: ${error.message}`)
      return { scanned, narrated, skipped, errors, totalCostCents }
    }
    findings = (data ?? []) as unknown as FindingRow[]
  } else {
    errors.push('narrateDisagreements: must pass findingId or venueId')
    return { scanned, narrated, skipped, errors, totalCostCents }
  }

  for (const f of findings) {
    scanned += 1
    if (f.narrator_text && f.narrator_text.trim().length > 0) {
      skipped += 1
      continue
    }
    try {
      const out = await narrateOne(supabase, f)
      totalCostCents += out.costCents
      if (out.ok) {
        narrated += 1
      } else {
        errors.push(`finding ${f.id}: ${out.error}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`finding ${f.id}: ${msg}`)
    }
  }

  return { scanned, narrated, skipped, errors, totalCostCents }
}
