/**
 * Unit tests for checkAutoSendEligible (Tier-B audit #68 — "Audit
 * auto-send actually fires").
 *
 * The eligibility check is the gate between an inbound email and an
 * autonomous reply. The audit concern was that subtle silent failures
 * (rule schema drift, status CHECK rejecting auto_send_pending,
 * confidence-scale mismatches) had previously broken auto-send without
 * loud signals. Email-pipeline.ts:2763 already added a `.select()` to
 * fail loudly on the status transition; this test pins the eligibility
 * decision logic itself.
 *
 * 7 gates exercised: cost-ceiling pause, direction filter, prompt-injection
 * signal, no-rule-found, rule disabled, confidence-below-threshold,
 * thread-cap, daily-limit, require_new_contact, happy path.
 *
 * No real Supabase / no real config tables. createServiceClient and
 * isAutonomousPaused are mocked to return canned responses.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks. Defined BEFORE the import of the module under test so vitest
// hoists them ahead of the eager imports inside autonomous-sender.ts.
// ---------------------------------------------------------------------------

// In-test mutable state. Each test resets via beforeEach.
const mockState: {
  paused: boolean
  rules: Array<{
    venue_id: string
    context: string
    source: string
    enabled: boolean
    confidence_threshold: number
    daily_limit: number
    thread_cap_24h: number
    require_new_contact: boolean
  }>
  todayCount: number
  threadCount: number
  priorInteractionsCount: number
} = {
  paused: false,
  rules: [],
  todayCount: 0,
  threadCount: 0,
  priorInteractionsCount: 0,
}

// Minimal Supabase query-builder mock. Each chain returns `this` so the
// caller's .from(...).select(...).eq(...).limit(...) shape resolves to a
// promise that returns canned data. Only supports the access patterns
// actually used inside checkAutoSendEligible's call path.
function makeMockClient() {
  const buildBuilder = (table: string) => {
    const predicates: Array<{ col: string; val: unknown }> = []
    let isHead = false

    const builder: any = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        isHead = opts?.head === true
        return builder
      },
      eq(col: string, val: unknown) {
        predicates.push({ col, val })
        return builder
      },
      gte(_col: string, _val: unknown) {
        return builder
      },
      in(col: string, vals: unknown[]) {
        predicates.push({ col, val: vals })
        return builder
      },
      limit(_n: number) {
        return builder._resolve()
      },
      // For `.select('id', { count: 'exact', head: true })` path used
      // inside require_new_contact gate, AND the chain that ends with
      // .gte() instead of .limit() in getTodayAutoSendCount /
      // getRecentThreadAutoSendCount. Both await the builder; thenable
      // resolution shape matches supabase-js.
      then(onResolve: (v: any) => any, onReject?: (e: unknown) => any) {
        return Promise.resolve(builder._resolve()).then(onResolve, onReject)
      },
      _resolve() {
        if (table === 'auto_send_rules') {
          const sourcePred = predicates.find((p) => p.col === 'source')?.val
          const contextPred = predicates.find((p) => p.col === 'context')?.val
          const venuePred = predicates.find((p) => p.col === 'venue_id')?.val
          const matched = mockState.rules.filter(
            (r) =>
              r.venue_id === venuePred &&
              r.context === contextPred &&
              r.source === sourcePred,
          )
          return { data: matched, error: null }
        }
        if (table === 'interactions' && isHead) {
          return { count: mockState.priorInteractionsCount, error: null }
        }
        // drafts queries land here. Two callers exist:
        //   - getTodayAutoSendCount: predicates {venue_id, auto_sent,
        //     context_type, gte(created_at)} → returns data.length-based
        //     count via mockState.todayCount.
        //   - getRecentThreadAutoSendCount step 2: predicates
        //     {venue_id, auto_sent, in(interaction_id), gte(sent_at)} →
        //     returns mockState.threadCount.
        // Disambiguate on `interaction_id IN (…)` predicate.
        if (table === 'drafts') {
          const hasInList = predicates.some((p) => p.col === 'interaction_id')
          const n = hasInList ? mockState.threadCount : mockState.todayCount
          return { data: Array.from({ length: n }, (_, i) => ({ id: `d${i}` })), error: null }
        }
        // interactions queries: getRecentThreadAutoSendCount step 1 looks
        // up interaction rows by gmail_thread_id. Return one row when a
        // thread is being checked so the count branch fires.
        if (table === 'interactions' && !isHead) {
          const hasThreadId = predicates.some((p) => p.col === 'gmail_thread_id')
          if (hasThreadId) {
            return { data: [{ id: 'int-1' }], error: null }
          }
        }
        return { data: [], error: null }
      },
    }
    return builder
  }
  return { from: (table: string) => buildBuilder(table) }
}

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => makeMockClient(),
}))

vi.mock('@/lib/services/cost-ceiling', () => ({
  isAutonomousPaused: vi.fn(async () => mockState.paused),
}))

vi.mock('@/lib/observability/metrics', () => ({
  recordCounter: vi.fn().mockResolvedValue(undefined),
  recordHistogram: vi.fn().mockResolvedValue(undefined),
}))

// The per-thread + per-day counter helpers are exported from the same
// module as checkAutoSendEligible, so vi.mock can't replace them
// independently — vitest's same-module-import-doesn't-go-through-mock
// rule. Instead the makeMockClient() above intercepts the underlying
// supabase queries those helpers make and returns mockState.threadCount
// / mockState.todayCount. Same end behaviour, fewer moving parts.
import { checkAutoSendEligible } from '@/lib/services/email/autonomous-sender'

const VENUE = 'venue-test-1'

const HAPPY_RULE = {
  venue_id: VENUE,
  context: 'inquiry',
  source: 'the_knot',
  enabled: true,
  confidence_threshold: 70,
  daily_limit: 10,
  thread_cap_24h: 3,
  require_new_contact: false,
}

beforeEach(() => {
  mockState.paused = false
  mockState.rules = [HAPPY_RULE]
  mockState.todayCount = 0
  mockState.threadCount = 0
  mockState.priorInteractionsCount = 0
})

describe('checkAutoSendEligible', () => {
  it('happy path — eligible when all gates pass', async () => {
    const r = await checkAutoSendEligible(VENUE, {
      contextType: 'inquiry',
      confidenceScore: 85,
      source: 'the_knot',
      threadId: 'thread-1',
      direction: 'inbound',
    })
    expect(r.eligible).toBe(true)
    expect(r.reason).toContain('approved')
  })

  it('blocks when cost-ceiling pause is active', async () => {
    mockState.paused = true
    const r = await checkAutoSendEligible(VENUE, {
      contextType: 'inquiry',
      confidenceScore: 85,
      source: 'the_knot',
      direction: 'inbound',
    })
    expect(r.eligible).toBe(false)
    expect(r.reason).toContain('autonomous behavior is paused')
  })

  it('blocks when direction is outbound (INV-15)', async () => {
    const r = await checkAutoSendEligible(VENUE, {
      contextType: 'inquiry',
      confidenceScore: 85,
      source: 'the_knot',
      direction: 'outbound',
    })
    expect(r.eligible).toBe(false)
    expect(r.reason).toContain("direction is 'outbound'")
  })

  it('blocks unconditionally when injection suspected', async () => {
    const r = await checkAutoSendEligible(VENUE, {
      contextType: 'inquiry',
      confidenceScore: 99,
      source: 'the_knot',
      direction: 'inbound',
      injectionSuspected: true,
    })
    expect(r.eligible).toBe(false)
    expect(r.reason).toContain('prompt-injection')
  })

  it('blocks when no rule exists for the (context, source) pair', async () => {
    mockState.rules = []
    const r = await checkAutoSendEligible(VENUE, {
      contextType: 'inquiry',
      confidenceScore: 85,
      source: 'the_knot',
      direction: 'inbound',
    })
    expect(r.eligible).toBe(false)
    expect(r.reason).toContain('No auto-send rule')
  })

  it('blocks when matching rule is disabled', async () => {
    mockState.rules = [{ ...HAPPY_RULE, enabled: false }]
    const r = await checkAutoSendEligible(VENUE, {
      contextType: 'inquiry',
      confidenceScore: 85,
      source: 'the_knot',
      direction: 'inbound',
    })
    expect(r.eligible).toBe(false)
    expect(r.reason).toContain('Auto-send disabled')
  })

  it('blocks when confidence is below the rule threshold', async () => {
    const r = await checkAutoSendEligible(VENUE, {
      contextType: 'inquiry',
      confidenceScore: 50,
      source: 'the_knot',
      direction: 'inbound',
    })
    expect(r.eligible).toBe(false)
    expect(r.reason).toContain('Confidence 50 below threshold 70')
  })

  it('blocks when thread cap exhausted', async () => {
    mockState.threadCount = 3
    const r = await checkAutoSendEligible(VENUE, {
      contextType: 'inquiry',
      confidenceScore: 85,
      source: 'the_knot',
      threadId: 'thread-hot',
      direction: 'inbound',
    })
    expect(r.eligible).toBe(false)
    expect(r.reason).toContain('Thread cap reached')
  })

  it('blocks when daily venue cap exhausted', async () => {
    mockState.todayCount = 10
    const r = await checkAutoSendEligible(VENUE, {
      contextType: 'inquiry',
      confidenceScore: 85,
      source: 'the_knot',
      threadId: 'thread-2',
      direction: 'inbound',
    })
    expect(r.eligible).toBe(false)
    expect(r.reason).toContain('Daily limit reached')
  })

  it('blocks via require_new_contact when wedding has prior interactions', async () => {
    mockState.rules = [{ ...HAPPY_RULE, require_new_contact: true }]
    mockState.priorInteractionsCount = 5
    const r = await checkAutoSendEligible(VENUE, {
      contextType: 'inquiry',
      confidenceScore: 85,
      source: 'the_knot',
      threadId: 'thread-3',
      weddingId: 'wedding-x',
      direction: 'inbound',
    })
    expect(r.eligible).toBe(false)
    expect(r.reason).toContain('require_new_contact')
  })

  it('allows via require_new_contact when no priors (≤1 — current itself)', async () => {
    mockState.rules = [{ ...HAPPY_RULE, require_new_contact: true }]
    mockState.priorInteractionsCount = 1 // just the current interaction
    const r = await checkAutoSendEligible(VENUE, {
      contextType: 'inquiry',
      confidenceScore: 85,
      source: 'the_knot',
      threadId: 'thread-4',
      weddingId: 'wedding-y',
      direction: 'inbound',
    })
    expect(r.eligible).toBe(true)
  })
})
