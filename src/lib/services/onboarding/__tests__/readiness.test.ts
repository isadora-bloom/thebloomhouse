/**
 * Unit tests for evaluateReadiness (T5-W5).
 *
 * runDataIntegrityChecks (src/lib/services/data-integrity.ts) is
 * mocked out entirely — it belongs to a different workstream and its
 * own correctness isn't this test's job. What IS this test's job:
 * proving evaluateReadiness aggregates the invariant results correctly
 * (readyForGoLive mirrors the CLI's exit-code semantics — invariants
 * are the hard gate, smoke tests are advisory and never block) and
 * that the four smoke tests classify pass/warn/fail correctly given
 * mocked table data.
 *
 * All Supabase access is mocked. No network traffic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { InvariantResult } from '@/lib/services/data-integrity'

const runDataIntegrityChecksMock = vi.fn<(sb: unknown, venueId: string) => Promise<InvariantResult[]>>()

vi.mock('@/lib/services/data-integrity', () => ({
  runDataIntegrityChecks: (...args: [unknown, string]) => runDataIntegrityChecksMock(...args),
}))

// ---------------------------------------------------------------------------
// Minimal thenable Supabase query-builder mock.
//
// Each `.from(table)` call gets a fresh builder. `.select(fields, opts)`
// records whether this is a head/count query and which fields were
// asked for; every filter method (.eq/.neq/.gte/...) is a no-op that
// returns `this` so real call chains don't throw. The builder is
// itself thenable — `await sb.from(t).select(...).eq(...)` resolves
// to whatever `resolve(table, fields, opts)` returns, matching how
// the real supabase-js PostgrestFilterBuilder works (no `.then()`
// call needed at the use site).
// ---------------------------------------------------------------------------

type Resolver = (table: string, fields: string, opts: { count?: string; head?: boolean } | undefined) => { data?: unknown[] | null; count?: number | null; error?: null }

function makeSupabaseMock(resolve: Resolver) {
  function builder(table: string) {
    let fields = ''
    let opts: { count?: string; head?: boolean } | undefined
    const chain = {
      select(f: string, o?: { count?: string; head?: boolean }) {
        fields = f
        opts = o
        return chain
      },
      eq() { return chain },
      neq() { return chain },
      gte() { return chain },
      gt() { return chain },
      lt() { return chain },
      in() { return chain },
      not() { return chain },
      is() { return chain },
      contains() { return chain },
      order() { return chain },
      limit() { return chain },
      range() { return chain },
      maybeSingle() { return Promise.resolve(resolve(table, fields, opts)) },
      single() { return Promise.resolve(resolve(table, fields, opts)) },
      then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
        return Promise.resolve(resolve(table, fields, opts)).then(onFulfilled, onRejected)
      },
    }
    return chain
  }
  return { from: (table: string) => builder(table) } as unknown as import('@supabase/supabase-js').SupabaseClient
}

const VENUE_ID = 'venue-uuid-1234'

function cleanInvariants(): InvariantResult[] {
  // 14 invariants, all clean (count 0) — matches a healthy venue.
  return Array.from({ length: 14 }, (_, i) => ({
    id: `invariant_${i}`,
    name: `Invariant ${i}`,
    meaning: 'test',
    count: 0,
    sample: [],
  }))
}

beforeEach(() => {
  runDataIntegrityChecksMock.mockReset()
})

describe('evaluateReadiness', () => {
  it('readyForGoLive=true when invariants are clean, even with smoke warnings', async () => {
    runDataIntegrityChecksMock.mockResolvedValue(cleanInvariants())
    const sb = makeSupabaseMock((table, fields) => {
      if (table === 'weddings' && fields.includes('heat_score')) return { data: [] } // no active leads -> smoke pass
      if (table === 'weddings' && fields.includes('source')) return { data: [] } // no weddings -> smoke pass
      if (table === 'weddings') return { count: 0 } // smokeWeddingsExist -> warn, not fail
      if (table === 'interactions') return { count: 0 } // smokeRecentActivity -> warn
      return { data: [], count: 0 }
    })

    const { evaluateReadiness } = await import('../readiness')
    const report = await evaluateReadiness(sb, VENUE_ID)

    expect(report.invariantsClean).toBe(true)
    expect(report.readyForGoLive).toBe(true)
    expect(report.smokeWarns).toBeGreaterThan(0) // weddings_present + recent_activity both warn on a fresh venue
    expect(report.smokeFails).toBe(0)
  })

  it('readyForGoLive=false when any invariant has violations, regardless of smoke status', async () => {
    const invariants = cleanInvariants()
    invariants[3] = { ...invariants[3], count: 5, sample: [{ id: 'x' }] }
    runDataIntegrityChecksMock.mockResolvedValue(invariants)
    const sb = makeSupabaseMock(() => ({ data: [], count: 100 })) // everything healthy on the smoke side

    const { evaluateReadiness } = await import('../readiness')
    const report = await evaluateReadiness(sb, VENUE_ID)

    expect(report.invariantsClean).toBe(false)
    expect(report.readyForGoLive).toBe(false)
    // Smoke tests are advisory — a clean smoke run does not overrule a
    // dirty invariant run.
  })

  it('readyForGoLive stays true even when a smoke test fails outright (invariants are the hard gate)', async () => {
    runDataIntegrityChecksMock.mockResolvedValue(cleanInvariants())
    const sb = makeSupabaseMock((table, fields) => {
      if (table === 'weddings' && fields.includes('heat_score')) {
        // 90% hot -> smokeHeatDistribution returns 'fail'
        return { data: Array.from({ length: 10 }, () => ({ heat_score: 95, temperature_tier: 'hot' })) }
      }
      if (table === 'weddings' && fields.includes('source')) return { data: [{ source: 'website' }] }
      if (table === 'weddings') return { count: 10 }
      if (table === 'interactions') return { count: 5 }
      return { data: [], count: 0 }
    })

    const { evaluateReadiness } = await import('../readiness')
    const report = await evaluateReadiness(sb, VENUE_ID)

    expect(report.smokeFails).toBe(1)
    expect(report.invariantsClean).toBe(true)
    expect(report.readyForGoLive).toBe(true)
    const heatSmoke = report.smoke.find((s) => s.id === 'heat_distribution')
    expect(heatSmoke?.status).toBe('fail')
  })

  it('smokeSourceMix warns when >95% of weddings share one non-unknown source', async () => {
    runDataIntegrityChecksMock.mockResolvedValue(cleanInvariants())
    const sourceRows = Array.from({ length: 20 }, () => ({ source: 'website' }))
    const sb = makeSupabaseMock((table, fields) => {
      if (table === 'weddings' && fields.includes('source')) return { data: sourceRows }
      if (table === 'weddings' && fields.includes('heat_score')) return { data: [] }
      if (table === 'weddings') return { count: 20 }
      if (table === 'interactions') return { count: 5 }
      return { data: [], count: 0 }
    })

    const { evaluateReadiness } = await import('../readiness')
    const report = await evaluateReadiness(sb, VENUE_ID)

    const sourceMix = report.smoke.find((s) => s.id === 'source_mix')
    expect(sourceMix?.status).toBe('warn')
  })

  it('passes the venueId through to runDataIntegrityChecks unchanged', async () => {
    runDataIntegrityChecksMock.mockResolvedValue(cleanInvariants())
    const sb = makeSupabaseMock(() => ({ data: [], count: 0 }))
    const { evaluateReadiness } = await import('../readiness')
    await evaluateReadiness(sb, VENUE_ID)
    expect(runDataIntegrityChecksMock).toHaveBeenCalledWith(sb, VENUE_ID)
  })
})
