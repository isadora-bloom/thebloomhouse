/**
 * W24 (wave 3) — the tangential pool collapses into the spine.
 *
 * Two things are worth testing without a database:
 *
 *   1. the shaping of a vision-extracted identity candidate into a
 *      NormalizedSignal, because that is the whole contract between the
 *      screenshot reader and `linkSignal`, and
 *   2. the queue migration, because a proposal that used to land in
 *      `client_match_queue` now has to land in `candidate_matches` and
 *      nowhere else.
 *
 * The fake client below is deliberately small: tables are arrays, the
 * only filters are `eq` and `is`, and every write is recorded so a test
 * can assert what was NOT written as easily as what was.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  candidateToSignal,
  importIdentityCandidates,
} from '@/lib/services/ingestion/tangential-signals'
import { proposeHandleConvergenceMatches } from '@/lib/services/identity/handle-convergence'
import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// A fake client with eq / is filters and a write log.
// ---------------------------------------------------------------------------

interface Row { [k: string]: unknown }

class FakeDb {
  tables: Record<string, Row[]> = {}
  writes: Array<{ table: string; op: string; payload: unknown }> = []

  seed(table: string, rows: Row[]): void {
    this.tables[table] = rows
  }

  rows(table: string): Row[] {
    this.tables[table] ??= []
    return this.tables[table]!
  }

  wroteTo(table: string): boolean {
    return this.writes.some((w) => w.table === table)
  }

  client(): SupabaseClient {
    return { from: (name: string) => new FakeQuery(this, name) } as unknown as SupabaseClient
  }
}

class FakeQuery implements PromiseLike<{ data: unknown; error: null }> {
  private op: 'select' | 'insert' | 'update' = 'select'
  private payload: Row | null = null
  private eqs: Array<[string, unknown]> = []
  private iss: Array<[string, unknown]> = []
  private one: boolean = false

  constructor(private db: FakeDb, private name: string) {}

  select(): this { return this }
  insert(payload: Row): this {
    this.op = 'insert'
    this.payload = payload
    return this
  }
  update(payload: Row): this {
    this.op = 'update'
    this.payload = payload
    return this
  }
  eq(col: string, val: unknown): this { this.eqs.push([col, val]); return this }
  is(col: string, val: unknown): this { this.iss.push([col, val]); return this }
  not(): this { return this }
  in(): this { return this }
  order(): this { return this }
  limit(): this { return this }
  maybeSingle(): this { this.one = true; return this }
  single(): this { this.one = true; return this }

  private matching(): Row[] {
    return this.db.rows(this.name).filter((r) => {
      for (const [c, v] of this.eqs) if (r[c] !== v) return false
      for (const [c] of this.iss) if (r[c] !== null && r[c] !== undefined) return false
      return true
    })
  }

  then<A, B = never>(
    onOk?: ((v: { data: unknown; error: null }) => A | PromiseLike<A>) | null,
    onErr?: ((r: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    let data: unknown = null
    if (this.op === 'insert') {
      const row = { id: `${this.name}-${this.db.rows(this.name).length + 1}`, ...(this.payload ?? {}) }
      this.db.rows(this.name).push(row)
      this.db.writes.push({ table: this.name, op: 'insert', payload: this.payload })
      data = this.one ? row : [row]
    } else if (this.op === 'update') {
      const hits = this.matching()
      for (const h of hits) Object.assign(h, this.payload ?? {})
      this.db.writes.push({ table: this.name, op: 'update', payload: this.payload })
      data = this.one ? hits[0] ?? null : hits
    } else {
      const hits = this.matching()
      data = this.one ? hits[0] ?? null : hits
    }
    return Promise.resolve({ data, error: null }).then(onOk, onErr)
  }
}

// ---------------------------------------------------------------------------
// 1. Candidate → NormalizedSignal
// ---------------------------------------------------------------------------

const CTX = {
  sourceEntryId: 'entry-1',
  sourceContext: 'IG comment thread screenshot',
  occurredAt: '2026-09-01T10:00:00.000Z',
  captureDay: '2026-09-01',
}

describe('candidateToSignal', () => {
  it('shapes an Instagram comment into a low-tier handle signal', () => {
    const s = candidateToSignal(
      {
        name: 'Rosie Hoyle',
        username: '@Rosie.Hoyle',
        platform: 'instagram',
        signal_type: 'instagram_engagement',
      },
      CTX,
    )
    expect(s).not.toBeNull()
    expect(s!.channel).toBe('instagram')
    expect(s!.action_type).toBe('comment')
    expect(s!.signal_tier).toBe('low')
    expect(s!.handles).toEqual({ instagram: 'rosie.hoyle' })
    expect(s!.primary_name).toBe('Rosie Hoyle')
    expect(s!.identity_hint).toBe('@rosie.hoyle')
    expect(s!.occurred_at).toBe(CTX.occurredAt)
  })

  it('reduces a profile URL to its path segment', () => {
    const s = candidateToSignal(
      { name: 'Rosie', handle: 'https://instagram.com/rosie.hoyle/', platform: 'Instagram' },
      CTX,
    )
    expect(s!.handles).toEqual({ instagram: 'rosie.hoyle' })
  })

  it('keeps external_id stable across two reads of the same capture', () => {
    const a = candidateToSignal({ username: 'sarah_p', platform: 'instagram', signal_type: 'tag' }, CTX)
    const b = candidateToSignal({ handle: '@Sarah_P', platform: 'instagram', signal_type: 'tag' }, CTX)
    expect(a!.external_id).toBe(b!.external_id)
    expect(a!.external_id).toBe('social:instagram:tag:sarah_p:entry-1')
  })

  it('falls back to the capture day when there is no source entry', () => {
    const s = candidateToSignal(
      { username: 'sarah_p', platform: 'instagram', signal_type: 'tag' },
      { ...CTX, sourceEntryId: null },
    )
    expect(s!.external_id).toBe('social:instagram:tag:sarah_p:2026-09-01')
  })

  it('maps the extraction vocabulary onto touchpoint verbs', () => {
    const verb = (t: string) =>
      candidateToSignal({ username: 'someone_here', platform: 'instagram', signal_type: t }, CTX)!.action_type
    expect(verb('comment')).toBe('comment')
    expect(verb('tag')).toBe('tag')
    expect(verb('mention')).toBe('mention')
    expect(verb('instagram_follow')).toBe('follow')
    expect(verb('review')).toBe('review_left')
    // Anything the extraction did not name is the weakest honest reading.
    expect(verb('something_new')).toBe('mention')
  })

  it('carries no handle when the platform has no handle namespace', () => {
    const s = candidateToSignal(
      { name: 'Dana Ruiz', username: 'danaruiz', platform: 'google', signal_type: 'review' },
      CTX,
    )
    expect(s!.handles).toBeNull()
    expect(s!.channel).toBe('review')
    expect(s!.primary_name).toBe('Dana Ruiz')
    expect(s!.external_id).toBe('social:review:review_left:dana-ruiz:entry-1')
  })

  it('drops a malformed handle but keeps the name', () => {
    const s = candidateToSignal(
      { name: 'Mia Chen', username: 'not a handle!!', platform: 'instagram' },
      CTX,
    )
    expect(s!.handles).toBeNull()
    expect(s!.primary_name).toBe('Mia Chen')
    expect(s!.identity_hint).toBe('Mia Chen')
  })

  it('returns null when there is neither a usable handle nor a name', () => {
    expect(candidateToSignal({ platform: 'instagram', signal_type: 'comment' }, CTX)).toBeNull()
    expect(candidateToSignal({ username: '   ', platform: 'instagram' }, CTX)).toBeNull()
  })

  it('splits a full name when first and last are not given separately', () => {
    const s = candidateToSignal({ name: 'Ashley Van Dyke', platform: 'instagram' }, CTX)
    expect(s!.raw_payload.first_name).toBe('Ashley')
    expect(s!.raw_payload.last_name).toBe('Van Dyke')
  })
})

// ---------------------------------------------------------------------------
// 2. importIdentityCandidates routes through linkSignal and nothing else
// ---------------------------------------------------------------------------

const linkSignalMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/services/identity/forwards-linker', () => ({
  linkSignal: linkSignalMock,
}))

function linkResult(action: string) {
  return {
    action,
    matched_couple_id: action === 'attached' ? 'couple-1' : null,
    tier: null,
    matcher_score: null,
    judge_invoked: false,
    judge_outcome: null,
    touchpoint_id: null,
    candidate_match_queued: action.startsWith('candidate'),
    reason: '',
    duplicate: action === 'duplicate',
  }
}

describe('importIdentityCandidates', () => {
  beforeEach(() => {
    linkSignalMock.mockReset()
  })

  it('sends every usable candidate to linkSignal and writes no legacy rows', async () => {
    const db = new FakeDb()
    linkSignalMock
      .mockResolvedValueOnce(linkResult('attached'))
      .mockResolvedValueOnce(linkResult('fragment'))
      .mockResolvedValueOnce(linkResult('candidate_low'))

    const res = await importIdentityCandidates({
      supabase: db.client(),
      venueId: 'venue-1',
      candidates: [
        { name: 'Rosie Hoyle', username: 'rosie.hoyle', platform: 'instagram', signal_type: 'comment' },
        { name: 'Sarah P', username: 'sarah_p', platform: 'instagram', signal_type: 'tag' },
        { name: 'Mia Chen', platform: 'instagram', signal_type: 'mention' },
        // No identity at all — never reaches the linker.
        { platform: 'instagram', signal_type: 'comment' },
      ],
      sourceEntryId: 'entry-9',
    })

    expect(linkSignalMock).toHaveBeenCalledTimes(3)
    expect(res.written).toBe(3)
    expect(res.matched).toBe(1)
    expect(res.unmatched).toBe(2)
    expect(res.fragments).toBe(1)
    expect(res.candidates).toBe(1)
    expect(res.skipped).toBe(1)

    // The whole point: the old pool gets nothing.
    expect(db.wroteTo('tangential_signals')).toBe(false)
    expect(db.wroteTo('client_match_queue')).toBe(false)
    expect(db.wroteTo('candidate_identities')).toBe(false)
  })

  it('counts a re-import of the same capture as a duplicate, not a new signal', async () => {
    const db = new FakeDb()
    linkSignalMock.mockResolvedValue(linkResult('duplicate'))

    const res = await importIdentityCandidates({
      supabase: db.client(),
      venueId: 'venue-1',
      candidates: [{ username: 'rosie.hoyle', platform: 'instagram', signal_type: 'comment' }],
      sourceEntryId: 'entry-9',
    })

    expect(res.duplicates).toBe(1)
    expect(res.written).toBe(0)
  })

  it('keeps going when the linker throws on one candidate', async () => {
    const db = new FakeDb()
    linkSignalMock
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(linkResult('fragment'))

    const res = await importIdentityCandidates({
      supabase: db.client(),
      venueId: 'venue-1',
      candidates: [
        { username: 'first_one', platform: 'instagram' },
        { username: 'second_one', platform: 'instagram' },
      ],
      sourceEntryId: 'entry-9',
    })

    expect(res.skipped).toBe(1)
    expect(res.written).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 3. The queue migration: proposals land in candidate_matches
// ---------------------------------------------------------------------------

describe('proposeHandleConvergenceMatches', () => {
  it('queues a cross-platform pair into candidate_matches, not client_match_queue', async () => {
    const db = new FakeDb()
    db.seed('couples', [
      {
        id: 'couple-1',
        venue_id: 'venue-1',
        merged_into_id: null,
        primary_contact_name: 'Rosalie Hoyle',
        partner_contact_name: null,
        primary_contact_email: 'rosalie@example.com',
        handles: { instagram: 'rosaliehoyle' },
      },
    ])
    db.seed('fragments', [
      {
        id: 'frag-1',
        venue_id: 'venue-1',
        promoted_to_couple_id: null,
        identity_hint: 'Rosalie',
        handles: { pinterest: 'rosaliehoyle' },
      },
    ])

    const res = await proposeHandleConvergenceMatches(db.client(), 'venue-1')

    expect(res.proposals).toBe(1)
    expect(res.pairsQueued).toBe(1)
    expect(db.wroteTo('candidate_matches')).toBe(true)
    expect(db.wroteTo('client_match_queue')).toBe(false)

    const row = db.rows('candidate_matches')[0] as Record<string, unknown>
    expect(row.primary_record_id).toBe('couple-1')
    expect(row.primary_record_type).toBe('couple')
    expect(row.secondary_record_id).toBe('frag-1')
    expect(row.secondary_record_type).toBe('fragment')
    expect(row.confidence_tier).toBe('low')
    expect(String(row.matcher_reason)).toContain('rosaliehoyle')
  })

  it('leaves a same-platform pair alone: the cascade already binds that', async () => {
    const db = new FakeDb()
    db.seed('couples', [
      {
        id: 'couple-1',
        venue_id: 'venue-1',
        merged_into_id: null,
        primary_contact_name: 'Rosalie Hoyle',
        partner_contact_name: null,
        primary_contact_email: null,
        handles: { instagram: 'rosaliehoyle' },
      },
    ])
    db.seed('fragments', [
      {
        id: 'frag-1',
        venue_id: 'venue-1',
        promoted_to_couple_id: null,
        identity_hint: '@rosaliehoyle',
        handles: { instagram: 'rosaliehoyle' },
      },
    ])

    const res = await proposeHandleConvergenceMatches(db.client(), 'venue-1')

    expect(res.proposals).toBe(0)
    expect(db.wroteTo('candidate_matches')).toBe(false)
  })

  it('refuses to queue a pair whose names contradict', async () => {
    const db = new FakeDb()
    db.seed('couples', [
      {
        id: 'couple-1',
        venue_id: 'venue-1',
        merged_into_id: null,
        primary_contact_name: 'Sarah Ross',
        partner_contact_name: null,
        primary_contact_email: null,
        handles: { instagram: 'thebigday2027' },
      },
    ])
    db.seed('fragments', [
      {
        id: 'frag-1',
        venue_id: 'venue-1',
        promoted_to_couple_id: null,
        identity_hint: 'Mark Delaney',
        handles: { tiktok: 'thebigday2027' },
      },
    ])

    const res = await proposeHandleConvergenceMatches(db.client(), 'venue-1')
    expect(res.proposals).toBe(0)
    expect(db.wroteTo('candidate_matches')).toBe(false)
  })

  it('drops generic and proxy handles before clustering', async () => {
    const db = new FakeDb()
    db.seed('couples', [
      {
        id: 'couple-1',
        venue_id: 'venue-1',
        merged_into_id: null,
        primary_contact_name: 'A Person',
        partner_contact_name: null,
        primary_contact_email: null,
        handles: { instagram: 'wedding' },
      },
    ])
    db.seed('fragments', [
      {
        id: 'frag-1',
        venue_id: 'venue-1',
        promoted_to_couple_id: null,
        identity_hint: null,
        handles: { pinterest: 'wedding' },
      },
      {
        id: 'frag-2',
        venue_id: 'venue-1',
        promoted_to_couple_id: null,
        identity_hint: null,
        handles: { knot: 'user123456' },
      },
    ])

    const res = await proposeHandleConvergenceMatches(db.client(), 'venue-1')
    expect(res.proposals).toBe(0)
    expect(db.wroteTo('candidate_matches')).toBe(false)
  })
})
