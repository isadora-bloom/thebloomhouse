/**
 * askIntel grounding contract — W3 of NOVEMBER-PLAN.md.
 *
 * The AI client and the canonical readers are both mocked. Nothing here
 * touches the Anthropic API or Supabase; the tool turns are scripted, so the
 * cases are deterministic and cost nothing to run.
 *
 * What is locked:
 *   - a grounded figure survives and comes back 'high' with evidence naming
 *     the readers it stands on;
 *   - a figure that no tool result supports turns the whole answer into a
 *     'refused' that names the claim;
 *   - an out-of-scope question refuses and names what the readers do cover;
 *   - an empty venue refuses without any AI call at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolDispatcher } from '@/lib/ai/tools'
import type { CallAIOptions } from '@/lib/ai/client'

// --- mocked AI client -------------------------------------------------------
// Scripted turns. Each entry is either a tool request (the loop dispatches it
// and comes back for the next entry) or a final text answer.
type ScriptedTurn =
  | { kind: 'tool'; name: string; args?: Record<string, unknown> }
  | { kind: 'text'; text: string }

const script: ScriptedTurn[] = []
let turnIndex = 0
let anthropicCallCount = 0

vi.mock('@/lib/ai/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/client')>()
  return {
    ...actual,
    CLAUDE_MODEL: 'claude-sonnet-4-6',
    callAnthropicTurn: vi.fn(async (_opts: CallAIOptions) => {
      anthropicCallCount += 1
      const turn = script[turnIndex] ?? { kind: 'text' as const, text: '' }
      turnIndex += 1
      if (turn.kind === 'tool') {
        return {
          text: '',
          inputTokens: 100,
          outputTokens: 20,
          cost: 0.001,
          stopReason: 'tool_use' as const,
          content: [
            {
              type: 'tool_use' as const,
              id: `tu_${turnIndex}`,
              name: turn.name,
              input: turn.args ?? {},
            },
          ],
        }
      }
      return {
        text: turn.text,
        inputTokens: 100,
        outputTokens: 40,
        cost: 0.002,
        stopReason: 'end_turn' as const,
        content: [{ type: 'text' as const, text: turn.text, citations: null }],
      }
    }),
  }
})

// --- mocked circuit breaker: primary provider healthy -----------------------
vi.mock('@/lib/ai/circuit-breaker', () => ({
  recordCall: vi.fn(),
  shouldSkip: () => false,
  isFallbackForced: () => false,
  isFallbackDisabled: () => false,
}))

// --- fake canonical readers -------------------------------------------------
// Injected through the AskIntelOpts.readers seam rather than module-mocked, so
// the dispatcher's dynamic import is never reached and no database is needed.
// 0.4023 is deliberately awkward: it is the kind of ratio a model renders as
// "40%", and the grounding check has to allow that rounding.
const GENERATED_AT = '2026-09-08T00:00:00.000Z'

const fakeReaders: import('@/lib/intel/tools').CanonicalReaders = {
  getSourceAttribution: async () => ({
    model: 'first_touch' as const,
    channels: [
      {
        channel: 'knot',
        n: 392,
        conversion: { value: 0.4023, n: 392, enoughData: true },
        cac: { value: null, n: 0, enoughData: false, reason: 'no_data' as const },
        revenuePerDollar: { value: null, n: 0, enoughData: false, reason: 'no_data' as const },
      },
    ],
    topByVolume: 'knot',
    topByConversion: 'knot',
    generatedAt: GENERATED_AT,
  }),
  getDailyList: async () => ({
    needsReply: [],
    goingCold: [],
    toursThisWeek: [],
    highIntent: [],
    generatedAt: GENERATED_AT,
  }),
  getCoupleJourney: async () => ({
    couple: null,
    ribbon: [],
    progression: [],
    identityProfile: null,
    lookAlikeCohort: [],
    generatedAt: GENERATED_AT,
  }),
  getVenueOverview: async () => ({
    couples: {
      total: 0,
      byLifecycle: {
        channel_scoped: 0,
        resolved: 0,
        booked: 0,
        completed: 0,
        ghost: 0,
        agent: 0,
      },
    },
    recentActivity: [],
    dataMaturity: { backfillStatus: 'empty', oldestTouchpoint: null, n: 0 },
    generatedAt: GENERATED_AT,
  }),
  getCohortFunnel: async () => ({
    funnel: [],
    responseTime: { value: null, n: 0, enoughData: false, reason: 'no_data' as const },
    leadTime: { value: null, n: 0, enoughData: false, reason: 'no_data' as const },
    conversionCurve: [],
    knee: null,
    textPatterns: [],
    generatedAt: GENERATED_AT,
  }),
}

// Supabase must never be reached. If anything tries, this throws and the
// best-effort log catch swallows it, which is the behaviour we want anyway.
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => {
    throw new Error('no database in unit tests')
  },
}))

// Imported after the vi.mock calls, which vitest hoists above every import.
// Static rather than per-test dynamic, so the module load cost is not billed
// to the first test's timeout.
const { askIntel, composeIntelAnswer } = await import('@/lib/intel/canonical')
const tools = await import('@/lib/intel/tools')

const VENUE = '11111111-1111-1111-1111-111111111111'

function setScript(turns: ScriptedTurn[]): void {
  script.length = 0
  script.push(...turns)
  turnIndex = 0
}

beforeEach(() => {
  anthropicCallCount = 0
  setScript([])
  delete process.env.NLQ_LEGACY
})

describe('askIntel — grounded answers', () => {
  it('keeps a figure that came back from a tool, and cites the reader', async () => {
    setScript([
      { kind: 'tool', name: 'get_source_attribution', args: { model: 'first_touch' } },
      {
        kind: 'text',
        text: 'Knot converts at 40% (n=392), and it is also your biggest channel by volume.',
      },
    ])

    const r = await askIntel(VENUE, 'which channel converts best?', { skipLog: true, readers: fakeReaders })

    expect(r.confidence).toBe('high')
    expect(r.answer).toContain('40%')
    expect(r.evidence).toHaveLength(1)
    expect(r.evidence[0].ref).toContain('get_source_attribution')
    expect(r.path).toBe('tools')
  })

  it('refuses when a figure appears that no tool result supports', async () => {
    setScript([
      { kind: 'tool', name: 'get_source_attribution', args: { model: 'first_touch' } },
      { kind: 'text', text: 'Unknown converts at 86%, well ahead of everything else.' },
    ])

    const r = await askIntel(VENUE, 'which channel converts best?', { skipLog: true, readers: fakeReaders })

    expect(r.confidence).toBe('refused')
    // The refusal names the claim it could not stand behind, and replaces
    // the answer rather than annotating it.
    expect(r.answer).toContain('could not stand behind')
    expect(r.answer).toContain('86%')
    // The evidence trail survives the refusal, so the operator can see what
    // was actually read.
    expect(r.evidence).toHaveLength(1)
  })

  it('never lets a name through when the tour bucket came back empty', async () => {
    setScript([
      { kind: 'tool', name: 'get_daily_list', args: { bucket: 'all' } },
      {
        kind: 'text',
        text: 'You toured with Rebecca and Aaron on Saturday. I can draft follow-ups to both.',
      },
    ])

    const r = await askIntel(VENUE, 'find everyone I had a tour with this weekend', {
      skipLog: true,
      readers: fakeReaders,
    })

    expect(r.confidence).toBe('refused')
    expect(r.answer).toMatch(/Rebecca|Aaron/)
  })

  it('accepts an honest empty-bucket answer for the same question', async () => {
    setScript([
      { kind: 'tool', name: 'get_daily_list', args: { bucket: 'toursThisWeek' } },
      {
        kind: 'text',
        text: 'There are no tours in that window, so there is nobody to follow up with yet.',
      },
    ])

    const r = await askIntel(VENUE, 'find everyone I had a tour with this weekend', {
      skipLog: true,
      readers: fakeReaders,
    })

    expect(r.confidence).toBe('high')
    expect(r.answer).toContain('no tours')
  })
})

describe('askIntel — refusals', () => {
  it('refuses an out-of-scope question and names what the readers do cover', async () => {
    setScript([
      {
        kind: 'text',
        text:
          'I have no weather data and no marketing spend by month, so I cannot answer that. ' +
          'What I can tell you about is channel attribution, the funnel with response and lead ' +
          'times, one couple end to end, and the daily lists.',
      },
    ])

    const r = await askIntel(VENUE, 'will it rain on the June weddings?', { skipLog: true, readers: fakeReaders })

    // No number was stated, so the grounding check has nothing to reject and
    // the answer stands as the model's own honest refusal.
    expect(r.answer).toContain('cannot answer')
    expect(r.evidence).toHaveLength(0)
    expect(anthropicCallCount).toBe(1)
  })

  it('refuses an empty venue without calling the model at all', async () => {
    const r = await askIntel('', 'which channel converts best?')

    expect(r.confidence).toBe('refused')
    expect(anthropicCallCount).toBe(0)
    expect(r.evidence).toEqual([])
  })

  it('refuses a sensitive-theme naming question before any model call', async () => {
    const r = await askIntel(VENUE, 'which couples are dealing with grief?', { skipLog: true, readers: fakeReaders })

    expect(r.confidence).toBe('refused')
    expect(anthropicCallCount).toBe(0)
    expect(r.answer).toContain('consent')
  })
})

describe('composeIntelAnswer — pure grounding contract', () => {
  it('marks a truncated loop as hedged and says so', async () => {
    const r = composeIntelAnswer({
      question: 'how many couples?',
      text: 'You have 0 couples on record.',
      calls: [
        {
          name: 'get_venue_overview',
          args: {},
          result: JSON.stringify({ couples: { total: 0 } }),
          isError: false,
        },
      ],
      truncated: true,
    })
    expect(r.confidence).toBe('hedged')
    expect(r.answer).toContain('partial')
  })

  it('refuses an empty answer rather than returning a blank', async () => {
    const r = composeIntelAnswer({ question: 'anything?', text: '   ', calls: [], truncated: false })
    expect(r.confidence).toBe('refused')
  })

  it('checks a currency amount rather than skipping it', async () => {
    const r = composeIntelAnswer({
      question: 'what is my cost per booking on knot?',
      text: 'Knot costs you $4,200 per booking.',
      calls: [
        {
          name: 'get_source_attribution',
          args: { model: 'first_touch' },
          result: JSON.stringify({
            channels: [{ channel: 'knot', n: 392, cac: { value: null, n: 0, enoughData: false } }],
          }),
          isError: false,
        },
      ],
      truncated: false,
    })
    expect(r.confidence).toBe('refused')
    expect(r.answer).toContain('4,200')
  })

  it('allows a figure the operator supplied in their own question', async () => {
    const r = composeIntelAnswer({
      question: 'why did inquiry volume spike 40% in March 2024?',
      text: 'I do not see a 40% spike in March 2024. What made you think there was one?',
      calls: [
        {
          name: 'get_cohort_funnel',
          args: {},
          result: JSON.stringify({ funnel: [] }),
          isError: false,
        },
      ],
      truncated: false,
    })
    expect(r.confidence).not.toBe('refused')
  })
})

describe('tool dispatcher', () => {
  it('binds venueId server-side and never exposes it in a schema', async () => {
    for (const tool of tools.CANONICAL_TOOLS) {
      const schema = tool.input_schema as { properties?: Record<string, unknown> }
      expect(Object.keys(schema.properties ?? {})).not.toContain('venue_id')
      expect(Object.keys(schema.properties ?? {})).not.toContain('venueId')
    }
  })

  it('records every (tool, args, result) triple it runs', async () => {
    const { dispatch, calls } = tools.createCanonicalDispatcher(VENUE, fakeReaders)
    const out = await (dispatch as ToolDispatcher)('get_source_attribution', {
      model: 'last_touch',
    })
    expect(out).toContain('knot')
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('get_source_attribution')
    expect(calls[0].args).toEqual({ model: 'last_touch' })
    expect(calls[0].isError).toBe(false)
  })

  it('rejects an unknown tool name instead of guessing', async () => {
    const { dispatch } = tools.createCanonicalDispatcher(VENUE, fakeReaders)
    const out = await (dispatch as ToolDispatcher)('run_arbitrary_sql', { q: 'select 1' })
    expect(out).toContain('Unknown tool')
  })
})
