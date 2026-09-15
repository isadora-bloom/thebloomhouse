import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * callAITools under AI_E2E_STUB=1 must answer from the fixture layer with no
 * model turn and no tool loop, the same contract callAI has. W73 found this
 * was the one path the stub did not cover.
 */
describe('callAITools under the e2e stub', () => {
  beforeEach(() => {
    vi.stubEnv('AI_E2E_STUB', '1')
    vi.stubEnv('VERCEL_ENV', 'preview')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('returns a generic answer with zero turns and never dispatches a tool', async () => {
    const { callAITools } = await import('@/lib/ai/tools')
    const dispatch = vi.fn(async () => ({ ok: true, result: '{}' })) as never
    const result = await callAITools(
      {
        systemPrompt: 'test',
        userPrompt: 'how many inquiries this week',
        taskType: 'intel_nlq',
        venueId: '00000000-0000-0000-0000-000000000000',
        promptVersion: 'no-such-fixture.v0',
        tools: [],
      } as never,
      dispatch,
    )
    expect(result.refused).toBe(false)
    if (result.refused) return
    expect(result.turns).toBe(0)
    expect(result.calls).toEqual([])
    expect(result.cost).toBe(0)
    expect(typeof result.text).toBe('string')
    expect(result.text.length).toBeGreaterThan(0)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('is inert in production even with the flag set', async () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    const { isStubActive } = await import('@/lib/ai/e2e-stub')
    expect(isStubActive()).toBe(false)
  })
})
