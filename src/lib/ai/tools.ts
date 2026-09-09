/**
 * Tool-use loop for Claude, sitting on top of `callAnthropicTurn`.
 *
 * W3 of NOVEMBER-PLAN.md. Before this file existed there was no tool-calling
 * anywhere in `src/lib/ai`: CallAIOptions had no `tools` field and `callAI`
 * flattened every response to `.text`. The "Ask your data" brain therefore had
 * only one way to answer, which was to be handed a dump of tables in the
 * prompt and asked to reason over it. That is how a channel came to be
 * reported converting at 86% when the canonical reader said 40% over n=392.
 *
 * Design notes:
 *
 *  - ONE provider. `callAI` has a two-floor contract (Claude, then OpenAI
 *    gpt-4o-mini). The fallback has no function calling, and answering a
 *    tool-grounded question WITHOUT the tools is precisely the failure mode
 *    this loop exists to remove. So when Claude is unavailable, or the
 *    operator has forced the fallback, this returns `{ refused: true }` with
 *    a reason. It does not pretend.
 *  - Hard turn cap. Six model turns, then stop. A loop that will not converge
 *    is a bug, not a budget question, and an unbounded one is a cost incident.
 *  - Every turn's cost is written to api_costs by `callAnthropicTurn`, exactly
 *    as a single callAI would be, so a tool-using answer is as auditable as a
 *    one-shot one.
 *  - Parallel tool_use blocks in one assistant turn are all dispatched, and
 *    every tool_result goes back in a SINGLE user message. Splitting them
 *    trains the model out of parallel calls.
 */

import type Anthropic from '@anthropic-ai/sdk'
import { callAnthropicTurn, type CallAIOptions } from '@/lib/ai/client'
import { isFallbackForced, isFallbackDisabled, shouldSkip, recordCall } from '@/lib/ai/circuit-breaker'
import { redactError } from '@/lib/observability/redact'

/** Hard ceiling on model turns in one loop. */
export const MAX_TOOL_TURNS = 6

/** One executed tool call, recorded in order. This is the evidence trail:
 *  a figure in the final answer is grounded only if it came back in one of
 *  these results. */
export interface ToolCallRecord {
  /** Tool name as declared in the manifest. */
  name: string
  /** Arguments the model supplied (venue scoping is added server-side and is
   *  deliberately NOT part of this). */
  args: Record<string, unknown>
  /** Serialised result handed back to the model. */
  result: string
  /** True when the dispatcher could not run the tool. */
  isError: boolean
}

/** A dispatcher runs one tool call and returns the string the model sees.
 *  Throwing is allowed; the loop converts a throw into an is_error result so
 *  a single bad call does not kill the answer. */
export type ToolDispatcher = (
  name: string,
  args: Record<string, unknown>,
) => Promise<string>

export type CallAIToolsResult =
  | {
      refused: false
      /** Final assistant text. */
      text: string
      /** Every tool call executed, in order. */
      calls: ToolCallRecord[]
      /** Total across all turns. */
      inputTokens: number
      outputTokens: number
      cost: number
      /** Number of model turns spent. */
      turns: number
      /** True when the loop hit MAX_TOOL_TURNS with the model still asking
       *  for tools. The text is then whatever the last turn said, which may
       *  be nothing; callers must treat this as incomplete. */
      truncated: boolean
    }
  | {
      refused: true
      /** Why no answer was produced. Callers surface this verbatim rather
       *  than substituting an answer of their own. */
      reason: string
      stage: 'fallback_provider' | 'claude_failed' | 'config_conflict'
      calls: ToolCallRecord[]
      inputTokens: number
      outputTokens: number
      cost: number
    }

function toolUseBlocks(content: Anthropic.ContentBlock[] | undefined): Anthropic.ToolUseBlock[] {
  if (!content) return []
  return content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
}

function asArgs(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {}
}

/**
 * Run a bounded tool-use loop and return the final text plus the trail of
 * tool calls that produced it.
 *
 * `opts.messages` seeds the transcript. `opts.tools` is the manifest. The
 * dispatcher owns execution and any server-side scoping (venue id, tenancy);
 * nothing the model supplies is trusted to select a tenant.
 */
export async function callAITools(
  opts: CallAIOptions & { tools: Anthropic.Tool[] },
  dispatch: ToolDispatcher,
): Promise<CallAIToolsResult> {
  const calls: ToolCallRecord[] = []
  let inputTokens = 0
  let outputTokens = 0
  let cost = 0

  // Provider honesty gate. The OpenAI fallback cannot call tools, so rather
  // than quietly answering from priors we refuse and say which floor failed.
  if (isFallbackForced() && isFallbackDisabled()) {
    return {
      refused: true,
      reason:
        'AI config conflict: AI_FORCE_FALLBACK and AI_DISABLE_FALLBACK are both set, so no provider can be selected.',
      stage: 'config_conflict',
      calls,
      inputTokens,
      outputTokens,
      cost,
    }
  }
  if (isFallbackForced() || shouldSkip('anthropic')) {
    return {
      refused: true,
      reason:
        'Grounded answers need tool calling, which only the primary provider supports. The primary is currently ' +
        (isFallbackForced() ? 'switched off by operator override' : 'failing health checks') +
        ', and the fallback provider cannot read the canonical figures. I would rather say nothing than guess.',
      stage: 'fallback_provider',
      calls,
      inputTokens,
      outputTokens,
      cost,
    }
  }

  const messages: Anthropic.MessageParam[] = [
    ...(opts.messages ?? [{ role: 'user' as const, content: opts.userPrompt }]),
  ]

  let turns = 0
  let lastText = ''

  while (turns < MAX_TOOL_TURNS) {
    turns += 1
    let turn
    try {
      turn = await callAnthropicTurn({ ...opts, messages })
      recordCall('anthropic', true)
    } catch (err) {
      recordCall('anthropic', false)
      console.warn(
        JSON.stringify({
          event: 'tool_loop_provider_error',
          taskType: opts.taskType ?? 'general',
          turn: turns,
          error: redactError(err),
        }),
      )
      return {
        refused: true,
        reason:
          'The primary provider failed part-way through gathering the figures, and the fallback provider cannot ' +
          'call the canonical readers. No answer, rather than an ungrounded one.',
        stage: 'claude_failed',
        calls,
        inputTokens,
        outputTokens,
        cost,
      }
    }

    inputTokens += turn.inputTokens
    outputTokens += turn.outputTokens
    cost += turn.cost
    if (turn.text) lastText = turn.text

    const pending = toolUseBlocks(turn.content)
    if (turn.stopReason !== 'tool_use' || pending.length === 0) {
      return {
        refused: false,
        text: turn.text,
        calls,
        inputTokens,
        outputTokens,
        cost,
        turns,
        truncated: false,
      }
    }

    // Append the assistant turn verbatim, tool_use blocks included.
    messages.push({ role: 'assistant', content: turn.content ?? [] })

    // Dispatch every pending call, then return ALL results in one user
    // message. A failed tool comes back as is_error rather than being
    // dropped, so the model can say what it could not read.
    const results: Anthropic.ToolResultBlockParam[] = []
    for (const block of pending) {
      const args = asArgs(block.input)
      let out: string
      let isError = false
      try {
        out = await dispatch(block.name, args)
      } catch (err) {
        isError = true
        out = `Tool "${block.name}" failed: ${err instanceof Error ? err.message : String(err)}`
      }
      calls.push({ name: block.name, args, result: out, isError })
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: out,
        ...(isError ? { is_error: true } : {}),
      })
    }
    messages.push({ role: 'user', content: results })
  }

  // Cap reached with the model still asking for tools.
  console.warn(
    JSON.stringify({
      event: 'tool_loop_truncated',
      taskType: opts.taskType ?? 'general',
      turns,
      toolCalls: calls.length,
    }),
  )
  return {
    refused: false,
    text: lastText,
    calls,
    inputTokens,
    outputTokens,
    cost,
    turns,
    truncated: true,
  }
}
