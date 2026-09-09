/**
 * callAITools — the bounded tool-use loop. W3 of NOVEMBER-PLAN.md.
 *
 * The Anthropic turn is mocked; no API key, no network, no database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'

type ScriptedTurn =
  | { kind: 'tool'; names: string[] }
  | { kind: 'text'; text: string }

const script: ScriptedTurn[] = []
let turnIndex = 0
let turnCalls = 0

let forced = false
let breakerOpen = false
let disabled = false
let throwOnTurn = -1

vi.mock('@/lib/ai/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/client')>()
  return {
    ...actual,
    callAnthropicTurn: vi.fn(async () => {
      turnCalls += 1
      if (throwOnTurn === turnCalls) throw new Error('provider exploded')
      const turn = script[turnIndex] ?? { kind: 'text' as const, text: 'done' }
      turnIndex += 1
      if (turn.kind === 'tool') {
        return {
          text: '',
          inputTokens: 10,
          outputTokens: 5,
          cost: 0.0001,
          stopReason: 'tool_use' as const,
          content: turn.names.map((n, i) => ({
            type: 'tool_use' as const,
            id: `tu_${turnIndex}_${i}`,
            name: n,
            input: { i },
          })),
        }
      }
      return {
        text: turn.text,
        inputTokens: 10,
        outputTokens: 5,
        cost: 0.0001,
        stopReason: 'end_turn' as const,
        content: [{ type: 'text' as const, text: turn.text, citations: null }],
      }
    }),
  }
})

vi.mock('@/lib/ai/circuit-breaker', () => ({
  recordCall: vi.fn(),
  shouldSkip: () => breakerOpen,
  isFallbackForced: () => forced,
  isFallbackDisabled: () => disabled,
}))

// Imported after the vi.mock calls, which vitest hoists above every import.
// Static rather than per-test dynamic, so the module load cost is not billed
// to the first test's timeout.
const { callAITools, MAX_TOOL_TURNS } = await import('@/lib/ai/tools')

const TOOLS: Anthropic.Tool[] = [
  { name: 'alpha', description: 'a', input_schema: { type: 'object', properties: {} } },
  { name: 'beta', description: 'b', input_schema: { type: 'object', properties: {} } },
]

function setScript(turns: ScriptedTurn[]): void {
  script.length = 0
  script.push(...turns)
  turnIndex = 0
}

beforeEach(() => {
  turnCalls = 0
  forced = false
  breakerOpen = false
  disabled = false
  throwOnTurn = -1
  setScript([])
})

describe('callAITools', () => {
  it('runs the loop, records every call, and returns the final text', async () => {
    setScript([{ kind: 'tool', names: ['alpha'] }, { kind: 'text', text: 'the answer' }])

    const r = await callAITools(
      { systemPrompt: 's', userPrompt: 'q', tools: TOOLS },
      async (name) => `result for ${name}`,
    )

    expect(r.refused).toBe(false)
    if (r.refused) return
    expect(r.text).toBe('the answer')
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0]).toMatchObject({ name: 'alpha', result: 'result for alpha', isError: false })
    expect(r.turns).toBe(2)
    expect(r.truncated).toBe(false)
    expect(r.cost).toBeCloseTo(0.0002, 6)
  })

  it('dispatches parallel tool_use blocks from one turn', async () => {
    setScript([{ kind: 'tool', names: ['alpha', 'beta'] }, { kind: 'text', text: 'both read' }])

    const r = await callAITools(
      { systemPrompt: 's', userPrompt: 'q', tools: TOOLS },
      async (name) => `ok ${name}`,
    )

    expect(r.refused).toBe(false)
    if (r.refused) return
    expect(r.calls.map((c) => c.name)).toEqual(['alpha', 'beta'])
    // Two calls, still only two model turns: the results went back together.
    expect(r.turns).toBe(2)
  })

  it('turns a dispatcher throw into an is_error result instead of dying', async () => {
    setScript([{ kind: 'tool', names: ['alpha'] }, { kind: 'text', text: 'carried on' }])

    const r = await callAITools({ systemPrompt: 's', userPrompt: 'q', tools: TOOLS }, async () => {
      throw new Error('reader unavailable')
    })

    expect(r.refused).toBe(false)
    if (r.refused) return
    expect(r.calls[0].isError).toBe(true)
    expect(r.calls[0].result).toContain('reader unavailable')
    expect(r.text).toBe('carried on')
  })

  it('stops at the turn cap and flags the answer as truncated', async () => {
    setScript(Array.from({ length: 20 }, () => ({ kind: 'tool' as const, names: ['alpha'] })))

    const r = await callAITools(
      { systemPrompt: 's', userPrompt: 'q', tools: TOOLS },
      async () => 'more',
    )

    expect(r.refused).toBe(false)
    if (r.refused) return
    expect(r.truncated).toBe(true)
    expect(r.turns).toBe(MAX_TOOL_TURNS)
  })

  it('refuses honestly rather than answering on the fallback provider', async () => {
    forced = true

    const r = await callAITools(
      { systemPrompt: 's', userPrompt: 'q', tools: TOOLS },
      async () => 'never reached',
    )

    expect(r.refused).toBe(true)
    if (!r.refused) return
    expect(r.stage).toBe('fallback_provider')
    expect(turnCalls).toBe(0)
  })

  it('refuses when the breaker has the primary provider skipped', async () => {
    breakerOpen = true

    const r = await callAITools(
      { systemPrompt: 's', userPrompt: 'q', tools: TOOLS },
      async () => 'never reached',
    )

    expect(r.refused).toBe(true)
    if (!r.refused) return
    expect(r.stage).toBe('fallback_provider')
  })

  it('refuses when the provider fails part-way through the loop', async () => {
    setScript([{ kind: 'tool', names: ['alpha'] }, { kind: 'text', text: 'unreachable' }])
    throwOnTurn = 2

    const r = await callAITools(
      { systemPrompt: 's', userPrompt: 'q', tools: TOOLS },
      async () => 'partial data',
    )

    expect(r.refused).toBe(true)
    if (!r.refused) return
    expect(r.stage).toBe('claude_failed')
    // The work already done is still reported, so the caller can say what it
    // managed to read.
    expect(r.calls).toHaveLength(1)
  })

  it('surfaces a force-and-disable config conflict rather than picking one', async () => {
    forced = true
    disabled = true

    const r = await callAITools(
      { systemPrompt: 's', userPrompt: 'q', tools: TOOLS },
      async () => 'never reached',
    )

    expect(r.refused).toBe(true)
    if (!r.refused) return
    expect(r.stage).toBe('config_conflict')
  })
})
