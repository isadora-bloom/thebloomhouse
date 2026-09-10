/**
 * Unit tests for the demo-reseed applier and its venue guard, against a
 * fake Supabase client.
 *
 * Nothing here touches a database. The point is to prove three things
 * before the operator ever runs the real thing:
 *
 *   1. The guard refuses anything that is not a live `is_demo` venue.
 *   2. A dry run writes nothing at all — not a delete, not a writer call.
 *   3. Under apply, every creation goes through an injected cascade
 *      writer, in replay order, with the minted wedding id substituted
 *      for the plan's placeholder.
 */

import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { applyReseed, runDelete, withWeddingId, type ReseedWriters } from '../apply'
import { assertKnownDemoVenueIds, checkVenuesAreDemo } from '../guard'
import { generateDemoDataset } from '../generate'
import { buildReseedPlan } from '../plan'
import { DEMO_VENUE_IDS, HERO_WEDDING_ID } from '../roster'

const TODAY = '2026-09-09T12:00:00.000Z'

// ---------------------------------------------------------------------------
// Fake client. Chainable, thenable, and it records every call so a test
// can assert on the shape of the query rather than on a mock's identity.
// ---------------------------------------------------------------------------

interface RecordedCall {
  table: string
  op: string
  payload?: unknown
  filters: Array<[string, ...unknown[]]>
}

interface FakeClient {
  client: SupabaseClient
  calls: RecordedCall[]
}

function makeFakeClient(
  venues: Array<{ id: string; name: string; is_demo: boolean | null }>,
  selectData: Record<string, unknown> = {},
): FakeClient {
  const calls: RecordedCall[] = []

  const from = (table: string) => {
    const call: RecordedCall = { table, op: 'select', filters: [] }
    let data: unknown = table === 'venues' ? venues : (selectData[table] ?? [])

    const chain: Record<string, unknown> = {}
    const push = (name: string) => (...args: unknown[]) => {
      call.filters.push([name, ...args])
      return chain
    }

    Object.assign(chain, {
      select: (...args: unknown[]) => {
        call.op = 'select'
        call.payload = args[0]
        return chain
      },
      delete: () => {
        call.op = 'delete'
        calls.push(call)
        data = null
        return chain
      },
      insert: (row: unknown) => {
        call.op = 'insert'
        call.payload = row
        calls.push(call)
        return Promise.resolve({ data: null, error: null })
      },
      update: (patch: unknown) => {
        call.op = 'update'
        call.payload = patch
        calls.push(call)
        data = null
        return chain
      },
      in: push('in'),
      eq: push('eq'),
      is: push('is'),
      not: push('not'),
      maybeSingle: () =>
        Promise.resolve({
          data: Array.isArray(data) ? ((data as unknown[])[0] ?? null) : data,
          error: null,
        }),
      single: () =>
        Promise.resolve({
          data: Array.isArray(data) ? ((data as unknown[])[0] ?? null) : data,
          error: null,
        }),
      then: (resolve: (value: { data: unknown; error: null }) => unknown) => {
        if (call.op === 'select') calls.push(call)
        return Promise.resolve({ data, error: null }).then(resolve)
      },
    })
    return chain
  }

  return { client: { from } as unknown as SupabaseClient, calls }
}

const ALL_DEMO = DEMO_VENUE_IDS.map((id, i) => ({
  id,
  name: `Demo venue ${i + 1}`,
  is_demo: true,
}))

// ---------------------------------------------------------------------------
// Recording writers
// ---------------------------------------------------------------------------

interface WriterLog {
  writers: ReseedWriters
  minted: string[]
  mirrored: Array<{ weddingId: string }>
  linked: Array<{ externalId: string; legacyWeddingId: string | null | undefined }>
  heat: Array<{ weddingId: string; events: string[]; occurredAt: string }>
}

function makeWriters(): WriterLog {
  const log: WriterLog = {
    minted: [],
    mirrored: [],
    linked: [],
    heat: [],
    writers: {} as ReseedWriters,
  }
  let counter = 0
  log.writers = {
    async mintWedding() {
      counter++
      const weddingId = `minted-${String(counter).padStart(3, '0')}`
      log.minted.push(weddingId)
      return { weddingId }
    },
    async mirrorCouple(input) {
      log.mirrored.push({ weddingId: input.weddingId })
      return { coupleId: `couple-for-${input.weddingId}` }
    },
    async linkSignal(args) {
      log.linked.push({
        externalId: args.signal.external_id,
        legacyWeddingId: args.signal.legacy_wedding_id,
      })
      return { action: 'attached', duplicate: false }
    },
    async recordHeat(_venueId, weddingId, events, _direction, occurredAt) {
      log.heat.push({ weddingId, events: events.map((e) => e.eventType), occurredAt })
      return null
    },
  }
  return log
}

function smallPlan() {
  const dataset = generateDemoDataset({ seed: 909, today: TODAY, coupleCount: 8 })
  return { dataset, plan: buildReseedPlan(dataset) }
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

describe('venue guard', () => {
  it('refuses an id that is not a Crestwood demo venue before opening a connection', () => {
    expect(() => assertKnownDemoVenueIds(['deadbeef-0000-0000-0000-000000000000'])).toThrow(
      /not Crestwood demo venues/,
    )
  })

  it('refuses an empty venue list', () => {
    expect(() => assertKnownDemoVenueIds([])).toThrow(/empty venue list/)
  })

  it('passes when every venue comes back with is_demo true', async () => {
    const { client } = makeFakeClient(ALL_DEMO)
    const result = await checkVenuesAreDemo(client, DEMO_VENUE_IDS)
    expect(result.ok).toBe(true)
    expect(result.problems).toEqual([])
  })

  it('refuses when a venue has is_demo false', async () => {
    const venues = ALL_DEMO.map((v, i) => (i === 2 ? { ...v, is_demo: false } : v))
    const { client } = makeFakeClient(venues)
    const result = await checkVenuesAreDemo(client, DEMO_VENUE_IDS)
    expect(result.ok).toBe(false)
    expect(result.problems.join(' ')).toContain('is_demo=false')
  })

  it('refuses when a venue is missing entirely', async () => {
    const { client } = makeFakeClient(ALL_DEMO.slice(0, 3))
    const result = await checkVenuesAreDemo(client, DEMO_VENUE_IDS)
    expect(result.ok).toBe(false)
    expect(result.problems.join(' ')).toContain('does not exist')
  })

  it('stops the applier dead when the guard fails', async () => {
    const { dataset, plan } = smallPlan()
    const venues = ALL_DEMO.map((v, i) => (i === 0 ? { ...v, is_demo: null } : v))
    const { client, calls } = makeFakeClient(venues)
    const log = makeWriters()
    await expect(
      applyReseed({ supabase: client, plan, dataset, writers: log.writers, dryRun: false }),
    ).rejects.toThrow(/refusing to run/)
    expect(calls.filter((c) => c.op === 'delete')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

describe('applyReseed — dry run', () => {
  it('writes nothing and calls no writer', async () => {
    const { dataset, plan } = smallPlan()
    const { client, calls } = makeFakeClient(ALL_DEMO)
    const log = makeWriters()
    const result = await applyReseed({
      supabase: client,
      plan,
      dataset,
      writers: log.writers,
      dryRun: true,
    })

    expect(result.dryRun).toBe(true)
    expect(calls.filter((c) => c.op !== 'select')).toHaveLength(0)
    expect(log.minted).toHaveLength(0)
    expect(log.mirrored).toHaveLength(0)
    expect(log.linked).toHaveLength(0)
    expect(log.heat).toHaveLength(0)
    expect(result.errors).toEqual([])
  })

  it('still reports the counts it would have written', async () => {
    const { dataset, plan } = smallPlan()
    const { client } = makeFakeClient(ALL_DEMO)
    const log = makeWriters()
    const result = await applyReseed({
      supabase: client,
      plan,
      dataset,
      writers: log.writers,
      dryRun: true,
    })
    expect(result.signalsLinked).toBe(plan.summary.signals)
    expect(result.heatEventsWritten).toBe(plan.summary.heatEvents)
    expect(result.minted).toBe(dataset.stories.filter((s) => !s.hero).length)
    expect(result.mirrored).toBe(dataset.stories.length)
    expect(result.deletes.every((d) => d.performed === false)).toBe(true)
  })

  it('still runs the guard, so a dry run that would have been refused says so', async () => {
    const { dataset, plan } = smallPlan()
    const { client } = makeFakeClient(ALL_DEMO.map((v) => ({ ...v, is_demo: false })))
    const log = makeWriters()
    await expect(
      applyReseed({ supabase: client, plan, dataset, writers: log.writers, dryRun: true }),
    ).rejects.toThrow(/refusing to run/)
  })
})

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

describe('applyReseed — apply', () => {
  it('deletes every planned table, scoped to the demo venues', async () => {
    const { dataset, plan } = smallPlan()
    const { client, calls } = makeFakeClient(ALL_DEMO)
    const log = makeWriters()
    await applyReseed({
      supabase: client,
      plan,
      dataset,
      writers: log.writers,
      dryRun: false,
    })

    const deletes = calls.filter((c) => c.op === 'delete')
    expect(deletes.length).toBeGreaterThanOrEqual(plan.deletes.length)
    for (const d of deletes) {
      const venueFilter = d.filters.find((f) => f[0] === 'in' && f[1] === 'venue_id')
      expect(venueFilter).toBeDefined()
      expect(venueFilter![2]).toEqual([...DEMO_VENUE_IDS])
    }
  })

  it('spares the hero wedding on the weddings delete', async () => {
    const { client, calls } = makeFakeClient(ALL_DEMO)
    await runDelete(client, {
      table: 'weddings',
      venueIds: [...DEMO_VENUE_IDS],
      keepIds: [HERO_WEDDING_ID],
      why: 'test',
    })
    const del = calls.find((c) => c.table === 'weddings' && c.op === 'delete')!
    const notFilter = del.filters.find((f) => f[0] === 'not')
    expect(notFilter).toEqual(['not', 'id', 'in', `(${HERO_WEDDING_ID})`])
  })

  it('deletes unattached people too, not just the ones on a wedding', async () => {
    const { client, calls } = makeFakeClient(ALL_DEMO)
    await runDelete(client, {
      table: 'people',
      venueIds: [...DEMO_VENUE_IDS],
      keepWeddingIds: [HERO_WEDDING_ID],
      why: 'test',
    })
    const deletes = calls.filter((c) => c.table === 'people' && c.op === 'delete')
    expect(deletes).toHaveLength(2)
    expect(deletes[0].filters.some((f) => f[0] === 'is' && f[1] === 'wedding_id')).toBe(true)
    expect(deletes[1].filters.some((f) => f[0] === 'not')).toBe(true)
  })

  it('routes every creation through the injected cascade writers', async () => {
    const { dataset, plan } = smallPlan()
    const { client } = makeFakeClient(ALL_DEMO)
    const log = makeWriters()
    const result = await applyReseed({
      supabase: client,
      plan,
      dataset,
      writers: log.writers,
      dryRun: false,
    })

    expect(result.errors).toEqual([])
    expect(log.minted.length).toBe(dataset.stories.filter((s) => !s.hero).length)
    expect(log.mirrored.length).toBe(dataset.stories.length)
    expect(log.linked.length).toBe(plan.summary.signals)
  })

  it('substitutes the minted wedding id for the plan placeholder on every signal', async () => {
    const { dataset, plan } = smallPlan()
    const { client } = makeFakeClient(ALL_DEMO)
    const log = makeWriters()
    await applyReseed({
      supabase: client,
      plan,
      dataset,
      writers: log.writers,
      dryRun: false,
    })

    for (const call of log.linked) {
      expect(call.legacyWeddingId).toBeTruthy()
      expect(String(call.legacyWeddingId)).not.toMatch(/^<minted:/)
    }
  })

  it('keeps the hero on its pinned wedding id and never mints it a new one', async () => {
    const { dataset, plan } = smallPlan()
    const { client } = makeFakeClient(ALL_DEMO)
    const log = makeWriters()
    const result = await applyReseed({
      supabase: client,
      plan,
      dataset,
      writers: log.writers,
      dryRun: false,
    })

    expect(result.weddingIdByStory['hero-chloe-ryan']).toBe(HERO_WEDDING_ID)
    expect(log.mirrored.some((m) => m.weddingId === HERO_WEDDING_ID)).toBe(true)
    const heroSignals = log.linked.filter((l) => l.externalId.includes('hero-chloe-ryan'))
    expect(heroSignals.length).toBeGreaterThan(0)
    for (const s of heroSignals) expect(s.legacyWeddingId).toBe(HERO_WEDDING_ID)
  })

  it('mirrors the couple before the first signal for that couple', async () => {
    const { dataset, plan } = smallPlan()
    const { client } = makeFakeClient(ALL_DEMO)
    const log = makeWriters()
    const order: string[] = []
    const wrapped: ReseedWriters = {
      ...log.writers,
      mirrorCouple: async (input) => {
        order.push(`mirror:${input.weddingId}`)
        return log.writers.mirrorCouple(input)
      },
      linkSignal: async (args) => {
        order.push(`link:${String(args.signal.legacy_wedding_id)}`)
        return log.writers.linkSignal(args)
      },
    }
    await applyReseed({ supabase: client, plan, dataset, writers: wrapped, dryRun: false })

    const seenMirror = new Set<string>()
    for (const entry of order) {
      const [kind, weddingId] = entry.split(':')
      if (kind === 'mirror') seenMirror.add(weddingId)
      else expect(seenMirror.has(weddingId)).toBe(true)
    }
  })

  it('fires heat events with the signal occurred_at, not the wall clock', async () => {
    const { dataset, plan } = smallPlan()
    const { client } = makeFakeClient(ALL_DEMO)
    const log = makeWriters()
    await applyReseed({
      supabase: client,
      plan,
      dataset,
      writers: log.writers,
      dryRun: false,
    })

    const planned = plan.steps.filter((s) => s.kind === 'heat_events')
    expect(log.heat.length).toBe(planned.length)
    for (let i = 0; i < planned.length; i++) {
      expect(log.heat[i].occurredAt).toBe(planned[i].occurredAt)
      expect(log.heat[i].events).toEqual(planned[i].heatEvents)
    }
  })

  it('updates every wedding row and inserts the tour and lost-deal rows', async () => {
    const { dataset, plan } = smallPlan()
    const { client, calls } = makeFakeClient(ALL_DEMO)
    const log = makeWriters()
    await applyReseed({
      supabase: client,
      plan,
      dataset,
      writers: log.writers,
      dryRun: false,
    })

    const weddingUpdates = calls.filter((c) => c.table === 'weddings' && c.op === 'update')
    expect(weddingUpdates.length).toBe(dataset.stories.length)
    const tours = calls.filter((c) => c.table === 'tours' && c.op === 'insert')
    expect(tours.length).toBe(plan.steps.filter((s) => s.kind === 'tour_row').length)
    for (const t of tours) {
      expect((t.payload as Record<string, unknown>).wedding_id).toBeTruthy()
    }
    const lost = calls.filter((c) => c.table === 'lost_deals' && c.op === 'insert')
    expect(lost.length).toBe(plan.steps.filter((s) => s.kind === 'lost_deal_row').length)
  })

  it('is idempotent in shape: a second run over the same plan makes the same calls', async () => {
    const { dataset, plan } = smallPlan()
    const first = makeFakeClient(ALL_DEMO)
    const second = makeFakeClient(ALL_DEMO)
    const logA = makeWriters()
    const logB = makeWriters()
    await applyReseed({
      supabase: first.client,
      plan,
      dataset,
      writers: logA.writers,
      dryRun: false,
    })
    await applyReseed({
      supabase: second.client,
      plan,
      dataset,
      writers: logB.writers,
      dryRun: false,
    })
    expect(logB.linked.map((l) => l.externalId)).toEqual(logA.linked.map((l) => l.externalId))
    expect(first.calls.map((c) => `${c.table}:${c.op}`)).toEqual(
      second.calls.map((c) => `${c.table}:${c.op}`),
    )
  })
})

describe('withWeddingId', () => {
  it('replaces a placeholder', () => {
    const signal = {
      external_id: 'x',
      channel: 'gmail',
      action_type: 'reply',
      occurred_at: TODAY,
      signal_tier: 'high' as const,
      identity_hint: null,
      raw_payload: {},
      legacy_wedding_id: '<minted:some-key>',
    }
    expect(withWeddingId(signal, 'real-id').legacy_wedding_id).toBe('real-id')
  })

  it('leaves a real id alone', () => {
    const signal = {
      external_id: 'x',
      channel: 'gmail',
      action_type: 'reply',
      occurred_at: TODAY,
      signal_tier: 'high' as const,
      identity_hint: null,
      raw_payload: {},
      legacy_wedding_id: HERO_WEDDING_ID,
    }
    expect(withWeddingId(signal, 'other').legacy_wedding_id).toBe(HERO_WEDDING_ID)
  })
})
