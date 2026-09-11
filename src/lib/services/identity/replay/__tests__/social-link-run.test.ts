/**
 * The run that the capture route and the replay share (wave 3, W23).
 *
 * The fake client here records writes as well as answering reads,
 * because the thing worth guarding is what ends up ON the
 * social_engagements row: a couple id, never a person id, and a status
 * that does not call a fragment a match. The linker is stubbed, since
 * this is about the wiring either side of it, not about the cascade.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { LinkAction, LinkResult } from '@/lib/spine/cascade'

const linkSignalBatch = vi.fn()

vi.mock('@/lib/spine/cascade', async () => {
  const actual = await vi.importActual<typeof import('@/lib/spine/cascade')>('@/lib/spine/cascade')
  return { ...actual, linkSignalBatch: (args: unknown) => linkSignalBatch(args) }
})

const { linkSocialEngagements } = await import('../social')

const VENUE = 'venue-1'
const CAPTURE_AT = '2026-09-09T12:00:00.000Z'

type Row = Record<string, unknown>
interface Recorded {
  table: string
  patch: Row
  match: Row
}

function makeClient(tables: Record<string, Row[]>, writes: Recorded[]): SupabaseClient {
  function builder(table: string) {
    const preds: Array<(r: Row) => boolean> = []
    const match: Row = {}
    const chain = {
      select() {
        return chain
      },
      eq(k: string, v: unknown) {
        match[k] = v
        preds.push((r) => r[k] === v)
        return chain
      },
      in(k: string, vals: unknown[]) {
        preds.push((r) => vals.includes(r[k]))
        return chain
      },
      order() {
        return chain
      },
      limit() {
        return chain
      },
      update(patch: Row) {
        // Resolve lazily: `.eq` comes after `.update` in the call chain.
        return {
          eq(k: string, v: unknown) {
            match[k] = v
            writes.push({ table, patch, match: { ...match } })
            const target = (tables[table] ?? []).find((r) => r[k] === v)
            if (target) Object.assign(target, patch)
            return Promise.resolve({ data: null, error: null })
          },
        }
      },
      then(onFulfilled: (v: unknown) => unknown) {
        const data = (tables[table] ?? []).filter((r) => preds.every((p) => p(r)))
        return Promise.resolve({ data, error: null }).then(onFulfilled)
      },
    }
    return chain
  }
  return { from: (t: string) => builder(t) } as unknown as SupabaseClient
}

function engagement(over: Row = {}): Row {
  return {
    id: 'eng-1',
    venue_id: VENUE,
    social_capture_id: 'cap-1',
    platform: 'instagram',
    metric_type: 'new_followers',
    handle: 'rosie.hoyle',
    display_name: 'Rosie Hoyle',
    engagement_at: CAPTURE_AT,
    post_id: null,
    match_status: 'pending',
    ...over,
  }
}

function linkResult(action: LinkAction, coupleId: string | null, score: number | null = null): LinkResult {
  return {
    action,
    matched_couple_id: coupleId,
    tier: null,
    matcher_score: score,
    judge_invoked: false,
    judge_outcome: null,
    touchpoint_id: null,
    candidate_match_queued: false,
    reason: '',
    duplicate: action === 'duplicate',
  }
}

beforeEach(() => {
  linkSignalBatch.mockReset()
})

describe('linkSocialEngagements', () => {
  it('shapes one signal per row and hands them all to the linker at once', async () => {
    const writes: Recorded[] = []
    const tables = {
      social_engagements: [engagement(), engagement({ id: 'eng-2', handle: 'jen_bee', display_name: null })],
      social_captures: [{ id: 'cap-1', captured_at: CAPTURE_AT }],
      couples: [{ id: 'c-1', primary_contact_name: 'Rosie Hoyle', partner_contact_name: 'Sam Hoyle' }],
    }
    linkSignalBatch.mockResolvedValue({
      results: [linkResult('attached', 'c-1', 88), linkResult('fragment', null)],
      summary: {},
    })

    const out = await linkSocialEngagements({
      supabase: makeClient(tables, writes),
      venueId: VENUE,
      captureId: 'cap-1',
    })

    expect(linkSignalBatch).toHaveBeenCalledTimes(1)
    const call = linkSignalBatch.mock.calls[0][0] as { signals: Array<{ handles: unknown }> }
    expect(call.signals).toHaveLength(2)
    expect(call.signals[0].handles).toEqual({ instagram: 'rosie.hoyle' })

    expect(out.processed).toBe(2)
    expect(out.matched).toBe(1)
    expect(out.unmatched).toBe(1)
    expect(out.outcomes.attached).toBe(1)
    expect(out.outcomes.fragment).toBe(1)
  })

  it('writes the couple id and never a person id', async () => {
    const writes: Recorded[] = []
    const tables = {
      social_engagements: [engagement()],
      social_captures: [{ id: 'cap-1', captured_at: CAPTURE_AT }],
      couples: [{ id: 'c-1', primary_contact_name: 'Rosie Hoyle', partner_contact_name: null }],
    }
    linkSignalBatch.mockResolvedValue({ results: [linkResult('attached', 'c-1', 90)], summary: {} })

    await linkSocialEngagements({ supabase: makeClient(tables, writes), venueId: VENUE, captureId: 'cap-1' })

    const rowWrite = writes.find((w) => w.table === 'social_engagements')!
    expect(rowWrite.patch.couple_id).toBe('c-1')
    expect(rowWrite.patch.match_status).toBe('matched')
    expect(rowWrite.patch.match_method).toBe('spine_attached')
    expect(rowWrite.patch).not.toHaveProperty('matched_person_id')
  })

  it('names the couple from the spine, not from people', async () => {
    const writes: Recorded[] = []
    const tables = {
      social_engagements: [engagement()],
      social_captures: [{ id: 'cap-1', captured_at: CAPTURE_AT }],
      couples: [{ id: 'c-1', primary_contact_name: 'Rosie', partner_contact_name: 'Sam' }],
      people: [{ id: 'p-1', first_name: 'Wrong', last_name: 'Person' }],
    }
    linkSignalBatch.mockResolvedValue({ results: [linkResult('attached', 'c-1')], summary: {} })

    const out = await linkSocialEngagements({ supabase: makeClient(tables, writes), venueId: VENUE, captureId: 'cap-1' })
    expect(out.samples[0].couple_name).toBe('Rosie & Sam')
  })

  it('does not blank an established couple id when a re-run returns duplicate', async () => {
    const writes: Recorded[] = []
    const tables = {
      social_engagements: [engagement({ couple_id: 'c-1', match_status: 'matched' })],
      social_captures: [{ id: 'cap-1', captured_at: CAPTURE_AT }],
      couples: [],
    }
    linkSignalBatch.mockResolvedValue({ results: [linkResult('duplicate', null)], summary: {} })

    await linkSocialEngagements({ supabase: makeClient(tables, writes), venueId: VENUE, captureId: 'cap-1' })

    const rowWrite = writes.find((w) => w.table === 'social_engagements')!
    expect(rowWrite.patch).not.toHaveProperty('couple_id')
    expect(tables.social_engagements[0].couple_id).toBe('c-1')
  })

  it('counts a skipped handle by reason and never sends it to the linker', async () => {
    const writes: Recorded[] = []
    const tables = {
      social_engagements: [engagement({ id: 'eng-bad', handle: 'not a handle' }), engagement()],
      social_captures: [{ id: 'cap-1', captured_at: CAPTURE_AT }],
      couples: [],
    }
    linkSignalBatch.mockResolvedValue({ results: [linkResult('fragment', null)], summary: {} })

    const out = await linkSocialEngagements({ supabase: makeClient(tables, writes), venueId: VENUE, captureId: 'cap-1' })

    expect(out.skipped).toBe(1)
    expect(out.skipped_reasons.handle_normalisation_failed).toBe(1)
    const call = linkSignalBatch.mock.calls[0][0] as { signals: unknown[] }
    expect(call.signals).toHaveLength(1)
    expect(writes.some((w) => w.match.id === 'eng-bad')).toBe(false)
  })

  it('skips a row whose capture is missing rather than guessing a date', async () => {
    const writes: Recorded[] = []
    const tables = {
      social_engagements: [engagement({ social_capture_id: 'cap-gone' })],
      social_captures: [],
      couples: [],
    }
    const out = await linkSocialEngagements({ supabase: makeClient(tables, writes), venueId: VENUE })
    expect(out.skipped_reasons.missing_capture).toBe(1)
    expect(linkSignalBatch).not.toHaveBeenCalled()
  })

  it('shapeOnly never calls the linker and never writes', async () => {
    const writes: Recorded[] = []
    const tables = {
      social_engagements: [engagement()],
      social_captures: [{ id: 'cap-1', captured_at: CAPTURE_AT }],
      couples: [],
    }
    const out = await linkSocialEngagements({
      supabase: makeClient(tables, writes),
      venueId: VENUE,
      shapeOnly: true,
    })
    expect(linkSignalBatch).not.toHaveBeenCalled()
    expect(writes).toHaveLength(0)
    expect(out.processed).toBe(1)
  })

  it('refuses to attribute outcomes when the linker returns a different count', async () => {
    const writes: Recorded[] = []
    const tables = {
      social_engagements: [engagement(), engagement({ id: 'eng-2', handle: 'jen_bee' })],
      social_captures: [{ id: 'cap-1', captured_at: CAPTURE_AT }],
      couples: [],
    }
    linkSignalBatch.mockResolvedValue({ results: [linkResult('attached', 'c-1')], summary: {} })

    const out = await linkSocialEngagements({ supabase: makeClient(tables, writes), venueId: VENUE, captureId: 'cap-1' })
    expect(writes).toHaveLength(0)
    expect(out.errors[0]).toContain('outcomes not written')
  })

  it('stamps the capture counters from the spine outcome', async () => {
    const writes: Recorded[] = []
    const tables = {
      social_engagements: [engagement(), engagement({ id: 'eng-2', handle: 'jen_bee' })],
      social_captures: [{ id: 'cap-1', captured_at: CAPTURE_AT }],
      couples: [{ id: 'c-1', primary_contact_name: 'Rosie', partner_contact_name: null }],
    }
    linkSignalBatch.mockResolvedValue({
      results: [linkResult('attached', 'c-1'), linkResult('fragment', null)],
      summary: {},
    })

    await linkSocialEngagements({ supabase: makeClient(tables, writes), venueId: VENUE, captureId: 'cap-1' })

    const capWrite = writes.find((w) => w.table === 'social_captures')!
    expect(capWrite.patch).toEqual({ matched_count: 1, unmatched_count: 1 })
  })
})
