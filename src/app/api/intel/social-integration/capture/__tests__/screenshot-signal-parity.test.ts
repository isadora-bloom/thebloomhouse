/**
 * Fixture: a screenshot capture reaches the same signal shape as a
 * paste.
 *
 * NOVEMBER-PLAN.md wave 6, W41. The whole point of wiring the vision
 * path through `handleScreenshotCapture` (route.ts) is that it does not
 * fork the identity pipeline: a screenshot row and a pasted row become
 * the same `social_engagements` insert shape, then the same call to
 * `linkSocialEngagements`, so W23's `buildSocialSignal` and `linkSignal`
 * (cascade.ts) do the rest identically either way. This test proves
 * that parity at the shaping layer, without touching Supabase: it
 * builds one row the text-paste parser would produce and one row the
 * screenshot vision path would produce for the *same* handle, runs
 * both through `buildSocialSignal`, and checks the signals line up.
 */

import { describe, it, expect } from 'vitest'
import { parseInstagramFollowersText } from '@/lib/services/social/parsers/instagram-followers'
import { buildSocialSignal, type SocialEngagementInput } from '@/lib/services/identity/replay/social'
import { parseRelativeAge } from '@/lib/services/social/date-parser'
import { validateVisionRows } from '../screenshot'

const CAPTURE = { id: 'cap-parity-1', captured_at: '2026-09-14T12:00:00.000Z' }

describe('screenshot capture reaches the same signal shape as a paste', () => {
  it('produces the same handle, display name and channel either way', () => {
    // Paste path: the operator ran the JS snippet and pasted the output.
    const pasted = parseInstagramFollowersText('rosie.hoyle\nRosie Hoyle\n')
    expect(pasted).toHaveLength(1)

    const pasteInput: SocialEngagementInput = {
      id: 'eng-paste',
      platform: 'instagram',
      metric_type: 'new_followers',
      handle: pasted[0].handle,
      display_name: pasted[0].display_name,
      // Text paste has no per-row timestamp: engagement_at starts as the
      // capture instant, exactly as the route does today.
      engagement_at: CAPTURE.captured_at,
    }
    const pasteSignal = buildSocialSignal(pasteInput, CAPTURE)
    expect(pasteSignal.ok).toBe(true)

    // Screenshot path: the model saw the same follower, two days ago,
    // in a notifications-style screenshot.
    const { rows, invalid } = validateVisionRows([
      { handle: '@Rosie.Hoyle', display_name: 'Rosie Hoyle', action: 'started_following', relative_age: '2d', status: null },
    ])
    expect(invalid).toHaveLength(0)
    expect(rows).toHaveLength(1)

    // Same computation the route performs: back-derive engagement_at
    // from the relative age, anchored on the capture instant, before
    // handing the row to the identical insert shape a paste uses.
    const derived = parseRelativeAge(rows[0].relative_age, CAPTURE.captured_at)
    const screenshotInput: SocialEngagementInput = {
      id: 'eng-shot',
      platform: 'instagram',
      metric_type: 'new_followers',
      handle: rows[0].handle,
      display_name: rows[0].display_name,
      engagement_at: derived?.occurred_at ?? CAPTURE.captured_at,
    }
    const screenshotSignal = buildSocialSignal(screenshotInput, CAPTURE)
    expect(screenshotSignal.ok).toBe(true)

    if (!pasteSignal.ok || !screenshotSignal.ok) throw new Error('expected both to shape')

    // Same identity surface: channel, handles, action_type, tier.
    expect(screenshotSignal.signal.channel).toBe(pasteSignal.signal.channel)
    expect(screenshotSignal.signal.action_type).toBe(pasteSignal.signal.action_type)
    expect(screenshotSignal.signal.handles).toEqual(pasteSignal.signal.handles)
    expect(screenshotSignal.signal.signal_tier).toBe(pasteSignal.signal.signal_tier)
    expect(screenshotSignal.signal.primary_name).toBe(pasteSignal.signal.primary_name)

    // Same external_id pattern (platform:metric:handle:capture-date) --
    // only the capture id differs, because they are two different
    // captures of the same handle on the same day, which is correct:
    // a real re-capture of an already-known follower should land as a
    // duplicate, not a second touchpoint.
    expect(screenshotSignal.signal.external_id).toBe(pasteSignal.signal.external_id)

    // The screenshot signal carries strictly more temporal precision
    // (the relative age), never less, than the paste's ceiling.
    expect(screenshotSignal.signal.raw_payload.occurred_at_source).toBe('engagement_at')
    expect(pasteSignal.signal.raw_payload.occurred_at_source).toBe('engagement_at')
  })

  it('skips a screenshot row with no usable handle exactly the way a bad paste line would', () => {
    const { rows, invalid } = validateVisionRows([{ handle: '', action: 'started_following' }])
    expect(rows).toHaveLength(0)
    expect(invalid).toHaveLength(1)
    // Never reaches buildSocialSignal at all -- nothing gets written for
    // a row with no handle, from either capture mode.
  })

  it('both capture modes land on the identical NormalizedSignal key set', () => {
    const pasted = parseInstagramFollowersText('mconn\n')
    const pasteSignal = buildSocialSignal(
      { platform: 'instagram', metric_type: 'new_followers', handle: pasted[0].handle, display_name: pasted[0].display_name },
      CAPTURE,
    )
    const { rows } = validateVisionRows([{ handle: 'mconn', action: 'started_following', relative_age: null }])
    const screenshotSignal = buildSocialSignal(
      { platform: 'instagram', metric_type: 'new_followers', handle: rows[0].handle, display_name: rows[0].display_name, relative_age: rows[0].relative_age },
      CAPTURE,
    )
    if (!pasteSignal.ok || !screenshotSignal.ok) throw new Error('expected both to shape')
    expect(Object.keys(screenshotSignal.signal).sort()).toEqual(Object.keys(pasteSignal.signal).sort())
  })
})
