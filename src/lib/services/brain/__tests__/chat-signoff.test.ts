/**
 * The chat sign-off is a chokepoint, not a step in one branch.
 * 2026-09-14 security review, item 4.
 *
 * The sign-off is the couple-chat equivalent of the email disclosure
 * footer: it names the AI and gives a one-line escape to a person. It was
 * appended inside generateSageResponse, which covered one of the five ways
 * a reply leaves /api/portal/sage. The route then replaced that text on low
 * confidence, appended after it on medium confidence, and never reached the
 * generator at all for the human-requested, forbidden-topic and outage
 * replies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const config: Record<string, unknown> = { ai_name: 'Wren', ai_role: 'AI concierge' }

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const builder: Record<string, unknown> = {}
      const chain = () => builder
      builder.select = chain
      builder.eq = chain
      builder.order = async () => ({ data: [] })
      builder.single = async () => ({
        data: table === 'venue_ai_config' ? config : {},
      })
      builder.maybeSingle = async () => ({
        data:
          table === 'venues'
            ? { name: 'Hawthorne Manor' }
            : table === 'venue_config'
              ? { coordinator_name: 'Nadia' }
              : {},
      })
      builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: [] })
      return builder
    },
  }),
}))

// Static import on purpose. The sage module pulls in the whole prompt stack,
// and a dynamic import inside the first `it` spends the 5s test budget on
// module resolution rather than on the assertion.
import {
  appendChatSignoff,
  buildChatSignoff,
  hasChatSignoff,
  withChatSignoff,
} from '@/lib/services/brain/sage'

const VENUE = '88888888-8888-4888-8888-888888888888'

beforeEach(() => {
  config.ai_name = 'Wren'
  config.ai_role = 'AI concierge'
})

describe('buildChatSignoff', () => {
  it('names the assistant, the venue and the way out', async () => {
    const out = buildChatSignoff({
      aiName: 'Wren',
      venueName: 'Hawthorne Manor',
      aiRole: 'AI concierge',
      coordinatorName: 'Nadia',
    })
    expect(out).toContain('Wren')
    expect(out).toContain('Hawthorne Manor')
    expect(out).toContain('AI concierge')
    expect(out).toContain('Type "I\'d like a human"')
    expect(out).toContain('Nadia step in')
  })

  it('falls back to a generic AI role when the configured one does not say AI', async () => {
    expect(
      buildChatSignoff({ aiName: 'Wren', venueName: 'Hawthorne Manor', aiRole: 'concierge' }),
    ).toContain('AI assistant')
  })
})

describe('withChatSignoff', () => {
  it('appends once and only once', async () => {
    const signoff = buildChatSignoff({ aiName: 'Wren', venueName: 'Hawthorne Manor' })
    const once = withChatSignoff('Here is your answer.', signoff)
    expect(hasChatSignoff(once)).toBe(true)
    expect(withChatSignoff(once, signoff)).toBe(once)
  })
})

describe('appendChatSignoff', () => {
  it('signs a canned reply that never went near the model', async () => {
    const signed = await appendChatSignoff(
      "That's an important question. I've flagged it for your coordinator.",
      VENUE,
    )
    expect(hasChatSignoff(signed)).toBe(true)
    expect(signed).toContain('Wren')
    expect(signed).toContain('Nadia step in')
  })

  it('is idempotent, so a reply that already carries the sign-off is untouched', async () => {
    const first = await appendChatSignoff('Answer.', VENUE)
    expect(await appendChatSignoff(first, VENUE)).toBe(first)
  })

  it('returns the reply unchanged rather than throwing when the venue has no ai_name', async () => {
    config.ai_name = ''
    const out = await appendChatSignoff('Answer.', VENUE)
    expect(out).toBe('Answer.')
    expect(hasChatSignoff(out)).toBe(false)
  })
})

describe('generateSageResponse no longer owns the sign-off', () => {
  it('does not append it inside the generator', async () => {
    // Asserted against the source rather than by running the generator,
    // which would need the whole prompt stack. The point of the fix is that
    // the concatenation is not in this function any more; if it comes back,
    // the route would double-append or, worse, someone would decide the
    // route no longer needs to.
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/lib/services/brain/sage.ts', 'utf8')
    const generator = src.slice(src.indexOf('export async function generateSageResponse'))
    expect(generator).not.toContain('buildChatSignoff({')
    expect(generator).toContain('response: result.text')
  })
})

describe('the route signs every branch', () => {
  it('has an appendChatSignoff call for each reply it can return', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/app/api/portal/sage/route.ts', 'utf8')
    // human requested, forbidden topic, provider outage, generated reply.
    const calls = src.match(/appendChatSignoff\(/g) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(4)
    // And nothing returns the generator's text directly any more.
    expect(src).not.toContain('response: sageResult.response')
  })

  it('signs AFTER the confidence rewrites, not before', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/app/api/portal/sage/route.ts', 'utf8')
    const rewrite = src.indexOf("let finalResponse = sageResult.response")
    const caveat = src.indexOf("flagged this for your coordinator to confirm")
    const sign = src.indexOf('finalResponse = await appendChatSignoff(')
    expect(rewrite).toBeGreaterThan(-1)
    expect(caveat).toBeGreaterThan(rewrite)
    expect(sign).toBeGreaterThan(caveat)
  })
})
