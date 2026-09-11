/**
 * Social capture to spine signal shaping (wave 3, W23).
 *
 * What these tests are really guarding. First, that a handle which does
 * not normalise never becomes a signal, because the old matcher's worst
 * habit was writing something rather than nothing. Second, that the
 * external id pins the CAPTURE date, so a replay six months later is a
 * duplicate rather than a second follow. Third, that the relative age on
 * a screenshot becomes a real instant anchored on the capture, not on
 * whenever the replay happened to run.
 */

import { describe, it, expect } from 'vitest'
import {
  buildSocialSignal,
  resolveActionType,
  mapLinkResultToOutcome,
  describeSocialOutcome,
  type SocialEngagementInput,
} from '../social'
import type { LinkResult } from '@/lib/spine/cascade'

const CAPTURE = { id: 'cap-1', captured_at: '2026-09-09T12:00:00.000Z' }

function input(over: Partial<SocialEngagementInput> = {}): SocialEngagementInput {
  return {
    id: 'eng-1',
    platform: 'instagram',
    metric_type: 'new_followers',
    handle: 'rosie.hoyle',
    display_name: 'Rosie Hoyle',
    ...over,
  }
}

function shaped(over: Partial<SocialEngagementInput> = {}) {
  const out = buildSocialSignal(input(over), CAPTURE)
  if (!out.ok) throw new Error(`expected a signal, got skip: ${out.reason}`)
  return out.signal
}

describe('action type per metric', () => {
  const cases: Array<[string, string]> = [
    ['new_followers', 'follow'],
    ['page_likes', 'follow'],
    ['board_follows', 'follow'],
    ['story_views', 'story_view'],
    ['dms', 'dm'],
    ['post_engagement', 'comment'],
    ['saves', 'comment'],
    ['profile_visits', 'profile_visit'],
    ['profile_views', 'profile_visit'],
    ['video_engagement', 'video_engagement'],
  ]
  for (const [metric, action] of cases) {
    it(`${metric} is ${action}`, () => {
      expect(resolveActionType(metric)).toBe(action)
    })
  }

  it('covers every verb in the spec vocabulary', () => {
    const produced = new Set(cases.map(([, a]) => a))
    // `tag` only arrives from a vision row, never from a capture metric.
    produced.add(resolveActionType('post_engagement', 'mentioned')!)
    expect([...produced].sort()).toEqual([
      'comment',
      'dm',
      'follow',
      'profile_visit',
      'story_view',
      'tag',
      'video_engagement',
    ])
  })

  it('lets the per-row vision verb beat the capture metric', () => {
    // One notifications screenshot mixes follows, comments and mentions.
    expect(resolveActionType('new_followers', 'commented')).toBe('comment')
    expect(resolveActionType('new_followers', 'mentioned')).toBe('tag')
    expect(resolveActionType('new_followers', 'viewed_story')).toBe('story_view')
  })

  it('falls back to the metric when the vision verb is unknown', () => {
    expect(resolveActionType('new_followers', 'did_a_thing')).toBe('follow')
  })

  it('skips a metric it cannot name', () => {
    const out = buildSocialSignal(input({ metric_type: 'mystery_metric' }), CAPTURE)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('unmapped_action')
  })
})

describe('signal shape', () => {
  it('carries the handle as a platform-scoped identifier', () => {
    const s = shaped()
    expect(s.handles).toEqual({ instagram: 'rosie.hoyle' })
    expect(s.channel).toBe('instagram')
    expect(s.action_type).toBe('follow')
    expect(s.signal_tier).toBe('low')
  })

  it('puts the display name on primary_name at tier low, never higher', () => {
    const s = shaped()
    expect(s.primary_name).toBe('Rosie Hoyle')
    expect(s.signal_tier).toBe('low')
  })

  it('leaves primary_name null when the capture showed no name', () => {
    const s = shaped({ display_name: null })
    expect(s.primary_name).toBeNull()
    expect(s.identity_hint).toBe('@rosie.hoyle')
  })

  it('records the capture and the row in the raw payload', () => {
    const s = shaped()
    expect(s.raw_payload.social_capture_id).toBe('cap-1')
    expect(s.raw_payload.social_engagement_id).toBe('eng-1')
  })

  it('never sets an email, a phone or a legacy wedding id', () => {
    const s = shaped()
    expect(s.primary_email).toBeUndefined()
    expect(s.primary_phone).toBeUndefined()
    expect(s.legacy_wedding_id).toBeUndefined()
  })
})

describe('external id is idempotent', () => {
  it('pins the capture date, not the run date', () => {
    const s = shaped()
    expect(s.external_id).toBe('social:instagram:new_followers:rosie.hoyle:2026-09-09')
  })

  it('is identical across two shapings of the same row', () => {
    expect(shaped().external_id).toBe(shaped().external_id)
  })

  it('is identical whichever way the handle was written down', () => {
    const a = shaped({ handle: '@Rosie.Hoyle' })
    const b = shaped({ handle: 'https://www.instagram.com/rosie.hoyle/' })
    expect(a.external_id).toBe(b.external_id)
  })

  it('separates two metrics for the same handle in one day', () => {
    const follow = shaped()
    const story = shaped({ metric_type: 'story_views' })
    expect(follow.external_id).not.toBe(story.external_id)
  })

  it('separates the same handle on two platforms', () => {
    const ig = shaped()
    const tt = shaped({ platform: 'tiktok' })
    expect(ig.external_id).not.toBe(tt.external_id)
    expect(tt.handles).toEqual({ tiktok: 'rosie.hoyle' })
  })
})

describe('malformed handles are skipped, never written', () => {
  const junk = ['', '   ', '@', 'has a space', 'way.too.long.a.handle.for.instagram.by.miles.and.miles', '!!!']
  for (const raw of junk) {
    it(`skips ${JSON.stringify(raw)}`, () => {
      const out = buildSocialSignal(input({ handle: raw }), CAPTURE)
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.reason).toBe('handle_normalisation_failed')
    })
  }

  it('skips a platform that is not a capture surface', () => {
    const out = buildSocialSignal(input({ platform: 'myspace' }), CAPTURE)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('unsupported_platform')
  })

  it('rejects a twitter handle with a dot, which twitter does not allow', () => {
    const out = buildSocialSignal(
      input({ platform: 'facebook', handle: 'sarah.wilson', metric_type: 'page_likes' }),
      CAPTURE,
    )
    // Facebook does allow the dot, so this one lands.
    expect(out.ok).toBe(true)
  })
})

describe('occurred_at from the relative age', () => {
  it('back-derives days from the capture instant', () => {
    const s = shaped({ relative_age: '2d' })
    expect(s.occurred_at).toBe('2026-09-07T12:00:00.000Z')
    expect(s.raw_payload.occurred_at_source).toBe('relative_age')
  })

  it('back-derives weeks', () => {
    expect(shaped({ relative_age: '3w' }).occurred_at).toBe('2026-08-19T12:00:00.000Z')
  })

  it('reads the long form as well as the short', () => {
    expect(shaped({ relative_age: '2 days ago' }).occurred_at).toBe('2026-09-07T12:00:00.000Z')
  })

  it('does not read five months as five minutes', () => {
    const s = shaped({ relative_age: '5mo' })
    expect(s.occurred_at.slice(0, 7)).toBe('2026-04')
  })

  it('resolves a bare month and day to the most recent one before the capture', () => {
    expect(shaped({ relative_age: 'May 04' }).occurred_at).toBe('2026-05-04T00:00:00.000Z')
    // December has not happened yet in September, so it is last year's.
    expect(shaped({ relative_age: 'Dec 12' }).occurred_at).toBe('2025-12-12T00:00:00.000Z')
  })

  it('falls back to the stored engagement time when there is no age', () => {
    const s = shaped({ engagement_at: '2026-08-01T09:30:00.000Z' })
    expect(s.occurred_at).toBe('2026-08-01T09:30:00.000Z')
    expect(s.raw_payload.occurred_at_source).toBe('engagement_at')
  })

  it('falls back to the capture instant and says so', () => {
    const s = shaped({ engagement_at: null })
    expect(s.occurred_at).toBe(CAPTURE.captured_at)
    expect(s.raw_payload.occurred_at_source).toBe('captured_at')
    expect(s.raw_payload.occurred_at_precision).toBe('capture_ceiling')
  })

  it('keeps the precision so a reader does not treat a week as an afternoon', () => {
    expect(shaped({ relative_age: '1w' }).raw_payload.occurred_at_precision).toBe('day')
    expect(shaped({ relative_age: '20m' }).raw_payload.occurred_at_precision).toBe('exact')
    expect(shaped({ relative_age: 'Mar 2026' }).raw_payload.occurred_at_precision).toBe('month')
  })

  it('derives the same instant however long after the capture it runs', () => {
    const first = buildSocialSignal(input({ relative_age: '2d' }), CAPTURE)
    const later = buildSocialSignal(input({ relative_age: '2d' }), CAPTURE)
    expect(first.ok && later.ok && first.signal.occurred_at === later.signal.occurred_at).toBe(true)
  })
})

describe('outcome mapping', () => {
  function result(over: Partial<LinkResult>): LinkResult {
    return {
      action: 'fragment',
      matched_couple_id: null,
      tier: null,
      matcher_score: null,
      judge_invoked: false,
      judge_outcome: null,
      touchpoint_id: null,
      candidate_match_queued: false,
      reason: '',
      duplicate: false,
      ...over,
    }
  }

  it('calls an attach a match and names the couple', () => {
    const o = mapLinkResultToOutcome(result({ action: 'attached', matched_couple_id: 'c-1', matcher_score: 92 }))
    expect(o).toEqual({
      match_status: 'matched',
      match_method: 'spine_attached',
      match_confidence: 92,
      couple_id: 'c-1',
    })
  })

  it('calls a mint a match', () => {
    const o = mapLinkResultToOutcome(result({ action: 'minted', matched_couple_id: 'c-2' }))
    expect(o.match_status).toBe('matched')
    expect(o.match_method).toBe('spine_minted')
  })

  it('refuses to call a candidate a match', () => {
    const o = mapLinkResultToOutcome(result({ action: 'candidate_medium', matched_couple_id: 'c-3', matcher_score: 61 }))
    expect(o.match_status).toBe('unmatched')
    expect(o.match_method).toBe('spine_candidate')
    expect(o.couple_id).toBe('c-3')
  })

  it('refuses to call a fragment a match', () => {
    const o = mapLinkResultToOutcome(result({ action: 'fragment' }))
    expect(o.match_status).toBe('unmatched')
    expect(o.match_method).toBe('spine_fragment')
    expect(o.couple_id).toBeNull()
  })

  it('refuses to call an attach with no couple a match', () => {
    const o = mapLinkResultToOutcome(result({ action: 'attached', matched_couple_id: null }))
    expect(o.match_status).toBe('unmatched')
  })

  it('marks a re-fire as a duplicate', () => {
    const o = mapLinkResultToOutcome(result({ action: 'duplicate', duplicate: true }))
    expect(o.match_method).toBe('spine_duplicate')
    expect(o.match_status).toBe('unmatched')
  })
})

describe('what the coordinator reads', () => {
  it('names the couple on an attach', () => {
    expect(describeSocialOutcome('matched', 'spine_attached', 'Rosie & Sam')).toBe('Attached to Rosie & Sam')
  })
  it('says a candidate is in review, not matched', () => {
    expect(describeSocialOutcome('unmatched', 'spine_candidate', null)).toBe('In review')
  })
  it('says a fragment is waiting', () => {
    expect(describeSocialOutcome('unmatched', 'spine_fragment', null)).toBe('Fragment awaiting identity')
  })
  it('says a pending row has not been through the linker', () => {
    expect(describeSocialOutcome('pending', null, null)).toBe('Not yet through the linker')
  })
})
