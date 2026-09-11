/**
 * Wave 3 handle-as-identifier tests (HANDLE-IDENTITY-SPEC.md, W22).
 *
 * Covers the four places a handle now changes a decision:
 *   - cascade stage 1d: what makes a handle match, and what stops one
 *   - the matcher weight: a handle intersection is strong-identifier tier
 *   - couples.handles merging: union, never a silent overwrite
 *   - fragment promotion by handle, and the first_seen_at it drags back
 *   - the lifecycle-audit invariant first_seen_at <= point_zero_at
 *
 * The DB-touching tests run against the in-memory Supabase fake the golden
 * subset already uses, so there is no network and no test branch.
 */

import { describe, it, expect } from 'vitest'
import { cascadeMatch, type CascadeCandidate, type CascadeSignal } from '../identity-cascade'
import { scoreCandidate } from '../matcher'
import { mergeHandleMaps, mergeHandlesIntoCouple } from '../handle-merge'
import { computeLockKey } from '../mint-couple'
import { promoteFragmentsByHandle, sweepFragmentsByHandle } from '../fragment-sweep'
import { stampFirstSeenAt } from '../first-seen'
import { runLifecycleAudit } from '../lifecycle-audit'
import { createMockSupabase } from '@/lib/spine/__tests__/golden-mock-supabase'
import type { NormalizedSignal } from '../sources/types'

const VENUE = '00000000-0000-4000-9000-00000000abcd'

function candidate(over: Partial<CascadeCandidate> = {}): CascadeCandidate {
  return {
    coupleId: 'couple-1',
    weddingDate: null,
    people: [{ firstName: 'Rosie', lastName: 'Hoyle', email: null, phone: null }],
    ...over,
  }
}

// ---------------------------------------------------------------------------
// Cascade stage 1d
// ---------------------------------------------------------------------------

describe('cascade stage 1d, handle_exact', () => {
  it('matches one live couple on the same platform and handle', () => {
    const signal: CascadeSignal = { handles: { instagram: 'rosie.hoyle' } }
    const r = cascadeMatch(signal, [candidate({ handles: { instagram: 'rosie.hoyle' } })])
    expect(r.matched).toBe(true)
    if (r.matched) {
      expect(r.stage).toBe('handle_exact')
      expect(r.coupleId).toBe('couple-1')
      expect(r.evidence).toBe('handle_exact:instagram:rosie.hoyle')
    }
  })

  it('is platform-scoped, the same string on another platform is not a match', () => {
    const signal: CascadeSignal = { handles: { instagram: 'rosie.hoyle' } }
    const r = cascadeMatch(signal, [candidate({ handles: { tiktok: 'rosie.hoyle' } })])
    expect(r.matched).toBe(false)
  })

  it('declines when two live couples hold the same handle', () => {
    const signal: CascadeSignal = { handles: { instagram: 'rosie.hoyle' } }
    const r = cascadeMatch(signal, [
      candidate({ coupleId: 'a', handles: { instagram: 'rosie.hoyle' } }),
      candidate({ coupleId: 'b', handles: { instagram: 'rosie.hoyle' } }),
    ])
    expect(r.matched).toBe(false)
  })

  it('ignores a merged-away couple, so one live holder still matches', () => {
    const signal: CascadeSignal = { handles: { instagram: 'rosie.hoyle' } }
    const r = cascadeMatch(signal, [
      candidate({ coupleId: 'dead', handles: { instagram: 'rosie.hoyle' }, mergedIntoId: 'live' }),
      candidate({ coupleId: 'live', handles: { instagram: 'rosie.hoyle' } }),
    ])
    expect(r.matched).toBe(true)
    if (r.matched) expect(r.coupleId).toBe('live')
  })

  it('declines on a contradicting strong email, leaving the pair to review', () => {
    const signal: CascadeSignal = {
      handles: { instagram: 'rosie.hoyle' },
      primaryEmail: 'rosie@gmail.com',
      firstName: 'Rosie',
      lastName: 'Hoyle',
    }
    const r = cascadeMatch(signal, [
      candidate({
        handles: { instagram: 'rosie.hoyle' },
        people: [
          { firstName: 'Rosie', lastName: 'Hoyle', email: 'someone.else@gmail.com', phone: null },
        ],
      }),
    ])
    expect(r.matched).toBe(false)
  })

  it('runs after exact_email, an email match still wins the stage label', () => {
    const signal: CascadeSignal = {
      handles: { instagram: 'rosie.hoyle' },
      primaryEmail: 'rosie@gmail.com',
    }
    const r = cascadeMatch(signal, [
      candidate({
        handles: { instagram: 'rosie.hoyle' },
        people: [{ firstName: 'Rosie', lastName: 'Hoyle', email: 'rosie@gmail.com', phone: null }],
      }),
    ])
    expect(r.matched).toBe(true)
    if (r.matched) expect(r.stage).toBe('exact_email')
  })
})

// ---------------------------------------------------------------------------
// Matcher weight
// ---------------------------------------------------------------------------

describe('matcher, handle intersection is strong-identifier tier', () => {
  it('scores a shared handle high enough to auto-attach on its own', () => {
    const v = scoreCandidate(
      { id: 'sig', handles: { instagram: 'rosie.hoyle' } },
      { id: 'couple', handles: { instagram: 'rosie.hoyle' } },
    )
    expect(v.tier).toBe('high')
    expect(v.signals.some((s) => s.name.includes('handle_exact'))).toBe(true)
  })

  it('does not fire across platforms', () => {
    const v = scoreCandidate(
      { id: 'sig', handles: { instagram: 'rosie.hoyle' } },
      { id: 'couple', handles: { pinterest: 'rosie.hoyle' } },
    )
    expect(v.signals.some((s) => s.name.includes('handle_exact'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Handle merging
// ---------------------------------------------------------------------------

describe('mergeHandleMaps', () => {
  it('adds a platform the couple has no handle for', () => {
    const r = mergeHandleMaps({ instagram: 'rosie.hoyle' }, { tiktok: 'rosiehoyle' })
    expect(r.merged).toEqual({ instagram: 'rosie.hoyle', tiktok: 'rosiehoyle' })
    expect(r.added).toEqual(['tiktok'])
    expect(r.conflicts).toEqual([])
    expect(r.changed).toBe(true)
  })

  it('is a no-op when the handle is already the stored one', () => {
    const r = mergeHandleMaps({ instagram: 'rosie.hoyle' }, { instagram: 'rosie.hoyle' })
    expect(r.changed).toBe(false)
    expect(r.conflicts).toEqual([])
  })

  it('never overwrites a different handle on the same platform', () => {
    const r = mergeHandleMaps({ instagram: 'rosie.hoyle' }, { instagram: 'rosie.hoyle.2' })
    expect(r.merged.instagram).toBe('rosie.hoyle')
    expect(r.changed).toBe(false)
    expect(r.conflicts).toEqual([
      { platform: 'instagram', existing: 'rosie.hoyle', incoming: 'rosie.hoyle.2' },
    ])
  })

  it('normalises both sides, so a URL and an @handle compare equal', () => {
    const r = mergeHandleMaps(
      { instagram: 'rosie.hoyle' },
      { instagram: 'https://instagram.com/@Rosie.Hoyle/' },
    )
    expect(r.conflicts).toEqual([])
    expect(r.changed).toBe(false)
  })
})

describe('mergeHandlesIntoCouple', () => {
  it('writes the union and reports a conflict without overwriting', async () => {
    const { client, db } = createMockSupabase()
    db.tables.couples.push({
      id: 'c1',
      venue_id: VENUE,
      handles: { instagram: 'rosie.hoyle' },
      merged_into_id: null,
    })

    const added = await mergeHandlesIntoCouple({
      supabase: client,
      venueId: VENUE,
      coupleId: 'c1',
      handles: { pinterest: 'rosiehoyle' },
    })
    expect(added.written).toBe(true)
    expect(db.tables.couples[0].handles).toEqual({
      instagram: 'rosie.hoyle',
      pinterest: 'rosiehoyle',
    })

    const clash = await mergeHandlesIntoCouple({
      supabase: client,
      venueId: VENUE,
      coupleId: 'c1',
      handles: { instagram: 'someone.else' },
    })
    expect(clash.written).toBe(false)
    expect(clash.conflicts).toHaveLength(1)
    expect((db.tables.couples[0].handles as Record<string, string>).instagram).toBe('rosie.hoyle')
  })
})

// ---------------------------------------------------------------------------
// Lock key
// ---------------------------------------------------------------------------

describe('computeLockKey', () => {
  const base: NormalizedSignal = {
    external_id: 'x1',
    channel: 'instagram',
    action_type: 'follow',
    occurred_at: '2026-03-02T18:00:00Z',
    signal_tier: 'low',
    identity_hint: 'Rosie',
    raw_payload: {},
  }

  it('prefers a normalised handle over the free-text hint', () => {
    expect(computeLockKey({ ...base, handles: { instagram: 'rosie.hoyle' } }))
      .toBe('handle:instagram:rosie.hoyle')
  })

  it('still puts email and phone above a handle', () => {
    expect(
      computeLockKey({ ...base, handles: { instagram: 'rosie.hoyle' }, primary_email: 'r@x.com' }),
    ).toBe('email:r@x.com')
  })

  it('falls back to the hint when there is no structured handle', () => {
    expect(computeLockKey(base)).toBe('hint:instagram:rosie')
  })
})

// ---------------------------------------------------------------------------
// Fragment promotion
// ---------------------------------------------------------------------------

function seedCoupleAndFragment(db: ReturnType<typeof createMockSupabase>['db']) {
  db.tables.couples.push({
    id: 'c1',
    venue_id: VENUE,
    primary_contact_name: 'Rosie Hoyle',
    handles: { instagram: 'rosie.hoyle' },
    first_seen_at: '2026-06-14T09:00:00Z',
    point_zero_at: '2026-06-14T09:00:00Z',
    lifecycle_state: 'channel_scoped',
    merged_into_id: null,
  })
  db.tables.fragments.push({
    id: 'f1',
    venue_id: VENUE,
    channel: 'instagram',
    external_id: 'social:instagram:follow:rosie.hoyle:2026-03-02',
    occurred_at: '2026-03-02T18:00:00Z',
    identity_hint: 'Rosie',
    handles: { instagram: 'rosie.hoyle' },
    promoted_to_couple_id: null,
  })
}

describe('promoteFragmentsByHandle', () => {
  it('promotes the fragment, audits it, and drags first_seen_at back', async () => {
    const { client, db } = createMockSupabase()
    seedCoupleAndFragment(db)

    const r = await promoteFragmentsByHandle({
      supabase: client,
      venueId: VENUE,
      coupleId: 'c1',
      handles: { instagram: 'rosie.hoyle' },
    })

    expect(r.promoted).toHaveLength(1)
    expect(r.promoted[0]).toMatchObject({ fragmentId: 'f1', platform: 'instagram' })
    expect(db.tables.fragments[0].promoted_to_couple_id).toBe('c1')
    expect(db.tables.couples[0].first_seen_at).toBe('2026-03-02T18:00:00Z')
    expect(
      db.tables.couple_merge_events.some((e) => e.event_type === 'fragment_promoted'),
    ).toBe(true)
  })

  it('re-anchors an orphan touchpoint that shares the fragment key', async () => {
    const { client, db } = createMockSupabase()
    seedCoupleAndFragment(db)
    db.tables.touchpoints.push({
      id: 't1',
      venue_id: VENUE,
      couple_id: null,
      channel: 'instagram',
      external_id: 'social:instagram:follow:rosie.hoyle:2026-03-02',
      action_type: 'follow',
      signal_tier: 'low',
      occurred_at: '2026-03-02T18:00:00Z',
    })

    const r = await promoteFragmentsByHandle({
      supabase: client,
      venueId: VENUE,
      coupleId: 'c1',
      handles: { instagram: 'rosie.hoyle' },
    })
    expect(r.promoted[0]?.touchpointsReanchored).toBe(1)
    expect(db.tables.touchpoints[0].couple_id).toBe('c1')
  })

  it('is idempotent, a second pass promotes nothing', async () => {
    const { client, db } = createMockSupabase()
    seedCoupleAndFragment(db)
    const args = {
      supabase: client,
      venueId: VENUE,
      coupleId: 'c1',
      handles: { instagram: 'rosie.hoyle' as string },
    }
    await promoteFragmentsByHandle(args)
    const again = await promoteFragmentsByHandle(args)
    expect(again.promoted).toHaveLength(0)
  })

  it('leaves a fragment whose handle is on another platform alone', async () => {
    const { client, db } = createMockSupabase()
    seedCoupleAndFragment(db)
    db.tables.fragments[0].handles = { tiktok: 'rosie.hoyle' }

    const r = await promoteFragmentsByHandle({
      supabase: client,
      venueId: VENUE,
      coupleId: 'c1',
      handles: { instagram: 'rosie.hoyle' },
    })
    expect(r.promoted).toHaveLength(0)
    expect(db.tables.fragments[0].promoted_to_couple_id).toBe(null)
  })
})

describe('sweepFragmentsByHandle (the nightly batch form)', () => {
  it('promotes across the venue from the couples index', async () => {
    const { client, db } = createMockSupabase()
    seedCoupleAndFragment(db)

    const r = await sweepFragmentsByHandle({ supabase: client, venueId: VENUE })
    expect(r.promoted).toHaveLength(1)
    expect(r.couplesTouched).toBe(1)
    expect(r.ambiguous).toBe(0)
    expect(db.tables.fragments[0].promoted_to_couple_id).toBe('c1')
  })

  it('refuses to guess when two live couples hold the handle', async () => {
    const { client, db } = createMockSupabase()
    seedCoupleAndFragment(db)
    db.tables.couples.push({
      id: 'c2',
      venue_id: VENUE,
      handles: { instagram: 'rosie.hoyle' },
      merged_into_id: null,
    })

    const r = await sweepFragmentsByHandle({ supabase: client, venueId: VENUE })
    expect(r.promoted).toHaveLength(0)
    expect(r.ambiguous).toBe(1)
    expect(db.tables.fragments[0].promoted_to_couple_id).toBe(null)
  })

  it('ignores a merged-away couple when building the index', async () => {
    const { client, db } = createMockSupabase()
    seedCoupleAndFragment(db)
    db.tables.couples.push({
      id: 'c2',
      venue_id: VENUE,
      handles: { instagram: 'rosie.hoyle' },
      merged_into_id: 'c1',
    })

    const r = await sweepFragmentsByHandle({ supabase: client, venueId: VENUE })
    expect(r.promoted).toHaveLength(1)
    expect(r.promoted[0]?.coupleId).toBe('c1')
  })
})

// ---------------------------------------------------------------------------
// first_seen_at
// ---------------------------------------------------------------------------

describe('stampFirstSeenAt', () => {
  it('claims a null column', async () => {
    const { client, db } = createMockSupabase()
    db.tables.couples.push({ id: 'c1', venue_id: VENUE, first_seen_at: null })
    const r = await stampFirstSeenAt({
      supabase: client,
      venueId: VENUE,
      coupleId: 'c1',
      occurredAt: '2026-06-14T09:00:00Z',
    })
    expect(r.updated).toBe(true)
    expect(db.tables.couples[0].first_seen_at).toBe('2026-06-14T09:00:00Z')
  })

  it('moves earlier but never later', async () => {
    const { client, db } = createMockSupabase()
    db.tables.couples.push({ id: 'c1', venue_id: VENUE, first_seen_at: '2026-06-14T09:00:00Z' })

    const later = await stampFirstSeenAt({
      supabase: client,
      venueId: VENUE,
      coupleId: 'c1',
      occurredAt: '2026-08-01T09:00:00Z',
    })
    expect(later.updated).toBe(false)
    expect(db.tables.couples[0].first_seen_at).toBe('2026-06-14T09:00:00Z')

    const earlier = await stampFirstSeenAt({
      supabase: client,
      venueId: VENUE,
      coupleId: 'c1',
      occurredAt: '2026-03-02T18:00:00Z',
    })
    expect(earlier.updated).toBe(true)
    expect(db.tables.couples[0].first_seen_at).toBe('2026-03-02T18:00:00Z')
  })
})

// ---------------------------------------------------------------------------
// Audit invariant
// ---------------------------------------------------------------------------

describe('lifecycle audit, first_seen_at <= point_zero_at', () => {
  it('reports a couple whose first_seen_at is after its point_zero_at', async () => {
    const { client, db } = createMockSupabase()
    db.tables.couples.push({
      id: 'c-bad',
      venue_id: VENUE,
      primary_contact_name: 'Rosie Hoyle',
      primary_contact_email: 'rosie@x.com',
      partner_contact_name: null,
      lifecycle_state: 'resolved',
      wedding_date: null,
      source_wedding_id: null,
      created_at: '2026-06-14T09:00:00Z',
      last_progression_at: null,
      first_seen_at: '2026-07-01T00:00:00Z',
      point_zero_at: '2026-06-14T09:00:00Z',
      merged_into_id: null,
    })

    const report = await runLifecycleAudit(client, VENUE)
    expect(report.meta.invariantViolationCount).toBe(1)
    expect(report.invariantViolations[0]).toMatchObject({
      coupleId: 'c-bad',
      invariant: 'first_seen_before_point_zero',
    })
  })

  it('says nothing when the order is right, or when either side is null', async () => {
    const { client, db } = createMockSupabase()
    const shared = {
      venue_id: VENUE,
      primary_contact_name: 'Rosie Hoyle',
      primary_contact_email: 'rosie@x.com',
      partner_contact_name: null,
      lifecycle_state: 'resolved',
      wedding_date: null,
      source_wedding_id: null,
      created_at: '2026-06-14T09:00:00Z',
      last_progression_at: null,
      merged_into_id: null,
    }
    db.tables.couples.push(
      { ...shared, id: 'c-ok', first_seen_at: '2026-03-02T18:00:00Z', point_zero_at: '2026-06-14T09:00:00Z' },
      { ...shared, id: 'c-null', first_seen_at: '2026-07-01T00:00:00Z', point_zero_at: null },
    )

    const report = await runLifecycleAudit(client, VENUE)
    expect(report.meta.invariantViolationCount).toBe(0)
  })
})
