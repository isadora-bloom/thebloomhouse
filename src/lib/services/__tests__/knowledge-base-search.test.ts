/**
 * searchKnowledgeBase filter safety — 2026-09-14 security review, item 5.
 *
 * The couple's raw chat message reaches this function before anything else
 * touches it (sage-brain calls it in the same Promise.all as the personality
 * load). What it builds from that message is a PostgREST `.or()` filter
 * string, so the message is, briefly, query syntax.
 *
 * Supabase is faked. The assertions are on the filter string the service
 * hands to `.or()`, because that is where the bug lived.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let capturedOr: string | null = null

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: () => {
      const builder: Record<string, unknown> = {}
      const chain = () => builder
      builder.select = chain
      builder.eq = chain
      builder.or = (expr: string) => {
        capturedOr = expr
        return builder
      }
      builder.order = async () => ({ data: [], error: null })
      return builder
    },
  }),
}))

const VENUE = '11111111-1111-4111-8111-111111111111'

beforeEach(() => {
  capturedOr = null
})

async function search(message: string) {
  const { searchKnowledgeBase } = await import('@/lib/services/knowledge-base')
  return searchKnowledgeBase(VENUE, message)
}

describe('searchKnowledgeBase', () => {
  it('does not error on a message made of filter punctuation', async () => {
    await expect(search('what about ,()% fees')).resolves.toEqual([])
    expect(capturedOr).toBeTruthy()
  })

  it('does not widen the match when the message contains a LIKE wildcard', async () => {
    await search('100% refund')
    // The clause for the word "100%" must escape the wildcard. An unescaped
    // `%` here would make `question.ilike.%100%%` match every row.
    expect(capturedOr).toContain('question.ilike.%100\\%%')
    expect(capturedOr).not.toContain('question.ilike.%100%%')
  })

  it('keeps one clause per word per column, whatever punctuation is in it', async () => {
    await search('deposit,refund')
    // "deposit,refund" is one word to the splitter. If the comma survived it
    // would split into two clauses and the second would be malformed.
    const clauses = (capturedOr ?? '').split(',')
    expect(clauses).toHaveLength(3)
    for (const clause of clauses) {
      expect(clause).toMatch(/^(?:keywords\.cs\.\{|question\.ilike\.|answer\.ilike\.)/)
    }
  })

  it('drops brackets rather than opening a group PostgREST cannot close', async () => {
    await search('cancellation (policy)')
    expect(capturedOr).not.toContain('(')
    expect(capturedOr).not.toContain(')')
  })

  it('caps how many words become clauses', async () => {
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ')
    await search(long)
    // 20 words, three clauses each.
    expect((capturedOr ?? '').split(',')).toHaveLength(60)
  })
})
