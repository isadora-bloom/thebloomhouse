/**
 * Bloom House — Wave 25 per-source narrator.
 *
 * Anchor docs:
 *   - feedback_measure_dont_assume.md (Sonnet describes; never invents)
 *   - PROMPT-BIAS-AUDIT.md (refuses on > 50% v1 contamination)
 *
 * Wraps the channel-source-narrator prompt with the callAI client.
 * Falls back to a stub on parse/validate failure rather than throwing —
 * the page should always render something.
 */

import { callAI } from '@/lib/ai/client'
import {
  CHANNEL_SOURCE_NARRATOR_PROMPT_VERSION,
  buildChannelSourceSystemPrompt,
  buildChannelSourceUserPrompt,
  buildSourceNarratorEvidence,
  validateChannelSourceNarratorOutput,
} from '@/config/prompts/channel-source-narrator'
import type { ChannelSnapshot, NarrationResult } from './types'

function stripJsonFences(s: string): string {
  return s.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
}

export async function narrateSourceStory(args: {
  snapshot: ChannelSnapshot
  venueLabel: string
}): Promise<NarrationResult> {
  const { snapshot, venueLabel } = args

  // Deterministic refusals before we burn a Sonnet call:
  //   - thin sample
  //   - v1-contamination > 50%
  if (snapshot.sample_sizes.ae_total < 10) {
    return stubRefusal(
      `Insufficient sample: only ${snapshot.sample_sizes.ae_total} attribution events in window.`,
    )
  }
  const v1Pct =
    snapshot.sample_sizes.ae_total > 0
      ? (snapshot.confidence_signals.v1_contaminated_count /
          snapshot.sample_sizes.ae_total) *
        100
      : 0
  if (v1Pct > 50) {
    return stubRefusal(
      `${v1Pct.toFixed(0)}% of classifications relied on a bias-suspect v1 prompt. Re-run reclassify-v1 sweep before narrating.`,
    )
  }

  const evidence = buildSourceNarratorEvidence({ snapshot, venueLabel })
  const systemPrompt = buildChannelSourceSystemPrompt()
  const userPrompt = buildChannelSourceUserPrompt(evidence)

  let result
  try {
    result = await callAI({
      systemPrompt,
      userPrompt,
      tier: 'sonnet',
      taskType: 'channel_source_narrate',
      contentTier: 4,
      promptVersion: CHANNEL_SOURCE_NARRATOR_PROMPT_VERSION,
      venueId: snapshot.venue_id,
      maxTokens: 1100,
      temperature: 0.2,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return stubRefusal(`narrator unavailable: ${msg}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonFences(result.text))
  } catch {
    return stubRefusal('narrator returned non-JSON output')
  }
  const validation = validateChannelSourceNarratorOutput(parsed)
  if (!validation.ok || !validation.output) {
    return stubRefusal(`narrator validation failed: ${validation.error ?? 'unknown'}`)
  }

  return {
    headline_pull_quote: validation.output.headline_pull_quote,
    story_arc_paragraph: validation.output.story_arc_paragraph,
    cac_reveal_paragraph: validation.output.cac_reveal_paragraph,
    recommendation_if_any: validation.output.recommendation_if_any,
    refusal_reason: validation.output.refusal_reason,
    prompt_version: CHANNEL_SOURCE_NARRATOR_PROMPT_VERSION,
  }
}

function stubRefusal(reason: string): NarrationResult {
  return {
    headline_pull_quote: '',
    story_arc_paragraph: '',
    cac_reveal_paragraph: '',
    recommendation_if_any: null,
    refusal_reason: reason,
    prompt_version: CHANNEL_SOURCE_NARRATOR_PROMPT_VERSION,
  }
}
