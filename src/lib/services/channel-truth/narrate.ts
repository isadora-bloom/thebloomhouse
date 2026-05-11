/**
 * Wave 24 — narrator wrapper.
 *
 * Given a ComputedAnswer, calls the Channel Truth narrator (Sonnet)
 * and returns the prose output. Hard refusals bypass the narrator and
 * return a stub.
 */

import { callAI } from '@/lib/ai/client'
import {
  CHANNEL_TRUTH_NARRATOR_PROMPT_VERSION,
  buildChannelTruthNarratorSystemPrompt,
  buildChannelTruthNarratorUserPrompt,
  validateChannelTruthNarratorOutput,
  type NarratorEvidence,
  type NarratorOutput,
} from '@/config/prompts/channel-truth-narrator'
import type { ComputedAnswer } from './types'

function stripJsonFences(s: string): string {
  return s.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
}

export async function narrateAnswer(args: {
  answer: ComputedAnswer
  venueLabel: string
  venueId: string
}): Promise<{ narrator: NarratorOutput; narrator_prompt_version: string }> {
  const { answer, venueLabel, venueId } = args

  // Hard refusal short-circuit: don't burn a Sonnet call when the
  // deterministic side already refused.
  if (answer.hard_refusal) {
    return {
      narrator: {
        narration_paragraph: '',
        headline_pull_quote: '',
        recommendation_if_any: null,
        refusal_reason: answer.hard_refusal.reason,
      },
      narrator_prompt_version: CHANNEL_TRUTH_NARRATOR_PROMPT_VERSION,
    }
  }

  const evidence: NarratorEvidence = {
    question_id: answer.question_id,
    question_text: answer.question_text,
    venue_label: venueLabel,
    cells: answer.cells.map((c) => ({
      label: c.label,
      n: c.n,
      headline_value: c.headline_value,
      ci_95_half_width: c.ci_95_half_width,
      v1_contaminated_pct: c.v1_contaminated_pct,
    })),
    min_sample_size: answer.min_sample_size,
    overall_v1_contamination_pct: answer.v1_contamination_pct,
    data_freshness_iso: answer.data_freshness_iso,
    context_notes: answer.context_notes,
  }

  const systemPrompt = buildChannelTruthNarratorSystemPrompt()
  const userPrompt = buildChannelTruthNarratorUserPrompt(evidence)

  let result
  try {
    result = await callAI({
      systemPrompt,
      userPrompt,
      tier: 'sonnet',
      taskType: 'channel_truth_narrate',
      contentTier: 4, // aggregate / structured only
      promptVersion: CHANNEL_TRUTH_NARRATOR_PROMPT_VERSION,
      venueId,
      maxTokens: 800,
      temperature: 0.2,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      narrator: {
        narration_paragraph: '',
        headline_pull_quote: '',
        recommendation_if_any: null,
        refusal_reason: `narrator unavailable: ${msg}`,
      },
      narrator_prompt_version: CHANNEL_TRUTH_NARRATOR_PROMPT_VERSION,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonFences(result.text))
  } catch {
    return {
      narrator: {
        narration_paragraph: '',
        headline_pull_quote: '',
        recommendation_if_any: null,
        refusal_reason: 'narrator returned non-JSON output',
      },
      narrator_prompt_version: CHANNEL_TRUTH_NARRATOR_PROMPT_VERSION,
    }
  }
  const validation = validateChannelTruthNarratorOutput(parsed)
  if (!validation.ok || !validation.output) {
    return {
      narrator: {
        narration_paragraph: '',
        headline_pull_quote: '',
        recommendation_if_any: null,
        refusal_reason: `narrator validation failed: ${validation.error ?? 'unknown'}`,
      },
      narrator_prompt_version: CHANNEL_TRUTH_NARRATOR_PROMPT_VERSION,
    }
  }
  return {
    narrator: validation.output,
    narrator_prompt_version: CHANNEL_TRUTH_NARRATOR_PROMPT_VERSION,
  }
}
