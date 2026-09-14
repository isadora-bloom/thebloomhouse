/**
 * Benchmark tool-source tests (NOVEMBER-PLAN.md wave 8, W56).
 *
 * The source runs the real service against a fake client, so what is
 * being checked is the whole path: registration, the refusal below the
 * peer threshold, the answer above it, and that no peer identity reaches
 * the model. The model is the last place a leaked venue name would be
 * noticed, so the assertion here is a grep of the whole result rather
 * than a check of named fields.
 */
import { describe, it, expect } from 'vitest'
import { makeFakeSupabase } from './fake-supabase'
import { benchmarkToolSource, TOOL_GET_VENUE_BENCHMARK } from '../benchmark'
import { TOOL_SOURCES } from '../index'

const CALLER = '11111111-1111-1111-1111-1111111111aa'
const PEER_1 = '11111111-1111-1111-1111-1111111111bb'
const PEER_2 = '11111111-1111-1111-1111-1111111111cc'
const PEER_3 = '11111111-1111-1111-1111-1111111111dd'

interface Row {
  id: string
  is_demo: boolean
  onboarded: boolean
}

/** A fake that answers the peer-set queries and returns no spine rows for
 *  anything else, so every venue's metrics come back empty. That is fine:
 *  these tests are about the gate and the anonymity, not the maths. */
function supabaseWith(rows: Row[]) {
  return makeFakeSupabase((table) => {
    if (table === 'venues') return { data: rows.map((r) => ({ id: r.id, is_demo: r.is_demo })) }
    if (table === 'venue_config') {
      return { data: rows.map((r) => ({ venue_id: r.id, onboarding_completed: r.onboarded })) }
    }
    return { data: [] }
  })
}

function real(id: string, onboarded = true): Row {
  return { id, is_demo: false, onboarded }
}

async function run(rows: Row[], venueId = CALLER) {
  return benchmarkToolSource.run(venueId, {}, {
    supabase: supabaseWith(rows),
    today: '2026-09-14',
  }) as Promise<{
    n: number
    enoughData: boolean
    reason?: string
    demoPeers: boolean
    view: unknown
  }>
}

describe('benchmark tool source', () => {
  it('is registered once, against battery Q43', () => {
    expect(benchmarkToolSource.tool.name).toBe(TOOL_GET_VENUE_BENCHMARK)
    expect(benchmarkToolSource.batteryQuestions).toContain('43')
    const matches = TOOL_SOURCES.filter((s) => s.tool.name === TOOL_GET_VENUE_BENCHMARK)
    expect(matches).toHaveLength(1)
  })

  it('takes no model-supplied arguments at all', () => {
    // venueId is bound by the dispatcher. There is nothing here a model
    // could pass that would widen what it sees.
    expect(benchmarkToolSource.tool.input_schema.properties).toEqual({})
  })

  it('refuses below three peers and says how many there are', async () => {
    const out = await run([real(CALLER), real(PEER_1)])
    expect(out.enoughData).toBe(false)
    expect(out.n).toBe(1)
    expect(out.view).toBeNull()
    expect(out.reason).toContain('1 other venue')
  })

  it('refuses when the only other venues have not finished setting up', async () => {
    const out = await run([
      real(CALLER),
      real(PEER_1, false),
      real(PEER_2, false),
      real(PEER_3, false),
    ])
    expect(out.enoughData).toBe(false)
    expect(out.n).toBe(0)
  })

  it('answers once three peers exist', async () => {
    const out = await run([real(CALLER), real(PEER_1), real(PEER_2), real(PEER_3)])
    expect(out.enoughData).toBe(true)
    expect(out.n).toBe(3)
    expect(out.view).not.toBeNull()
  })

  it('puts no venue id or name in front of the model', async () => {
    const out = await run([real(CALLER), real(PEER_1), real(PEER_2), real(PEER_3)])
    const serialised = JSON.stringify(out)
    for (const id of [CALLER, PEER_1, PEER_2, PEER_3]) {
      expect(serialised).not.toContain(id)
    }
    expect(serialised).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
  })

  it('flags a demo comparison so the model cannot pass it off as the real market', async () => {
    const demo = (id: string): Row => ({ id, is_demo: true, onboarded: true })
    const out = await run(
      [demo(CALLER), demo(PEER_1), demo(PEER_2), demo(PEER_3)],
      CALLER,
    )
    expect(out.demoPeers).toBe(true)
    expect(out.enoughData).toBe(true)
  })
})
