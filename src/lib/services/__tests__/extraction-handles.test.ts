/**
 * W25 (NOVEMBER-PLAN.md wave 3) — handle extraction in extraction.ts.
 * HANDLE-IDENTITY-SPEC.md §4: a signature line ("IG @rosie.hoyle") is
 * read by the model, not a regex; a profile URL is parsed
 * deterministically since it's a URL, not prose. Both are normalised
 * through normalizeHandle() before either is trusted.
 *
 * The model call is stubbed — nothing here touches the Anthropic API.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/ai/client', () => ({
  callAIJson: vi.fn(async () => stubbedModelResponse),
}))

// Mutable per-test fixture the mocked callAIJson reads.
let stubbedModelResponse: Record<string, unknown> = {}

function baseModelResponse(overrides: Record<string, unknown> = {}) {
  return {
    clientName: null,
    partnerName: null,
    eventDate: null,
    guestCount: null,
    eventType: null,
    budgetRange: null,
    questions: [],
    sentiment: 'neutral',
    stressSignals: [],
    excitementSignals: [],
    mentionedVendors: [],
    specialRequests: [],
    painPoints: [],
    objectionSignals: [],
    communicationStyle: null,
    keyPriorities: [],
    followUpNeeded: false,
    guestCountMin: null,
    guestCountMax: null,
    searchStage: null,
    venuesTouring: [],
    decisionTimeline: null,
    contactRelationship: null,
    handles: null,
    ...overrides,
  }
}

import {
  extractSignals,
  sanitiseHandlePlatformKeys,
  extractHandlesFromUrls,
  mergeAndNormaliseHandles,
} from '../extraction'

describe('sanitiseHandlePlatformKeys', () => {
  it('keeps only known platform keys with non-empty string values', () => {
    expect(
      sanitiseHandlePlatformKeys({
        instagram: '@rosie.hoyle',
        snapchat: 'rosie', // not a closed-list platform — dropped
        tiktok: '',        // empty — dropped
        facebook: null,
      }),
    ).toEqual({ instagram: '@rosie.hoyle' })
  })

  it('null/undefined input returns null', () => {
    expect(sanitiseHandlePlatformKeys(null)).toBeNull()
    expect(sanitiseHandlePlatformKeys(undefined)).toBeNull()
  })
})

describe('extractHandlesFromUrls — deterministic profile-URL parse', () => {
  it('recognises an instagram.com profile URL in body text', () => {
    expect(extractHandlesFromUrls('Find us at https://instagram.com/rosie.hoyle/ !')).toEqual({
      instagram: 'rosie.hoyle',
    })
  })

  it('recognises tiktok, facebook, pinterest, twitter/x profile URLs', () => {
    expect(extractHandlesFromUrls('https://tiktok.com/@the.hoyles')).toEqual({ tiktok: 'the.hoyles' })
    expect(extractHandlesFromUrls('https://facebook.com/rosie.hoyle')).toEqual({ facebook: 'rosie.hoyle' })
    expect(extractHandlesFromUrls('https://pinterest.com/rosiehoyle')).toEqual({ pinterest: 'rosiehoyle' })
    expect(extractHandlesFromUrls('https://x.com/rosiehoyle')).toEqual({ twitter: 'rosiehoyle' })
  })

  it('a non-profile URL yields null', () => {
    expect(extractHandlesFromUrls('See our venue at https://rixeymanor.com/gallery')).toBeNull()
  })

  it('no URL at all yields null', () => {
    expect(extractHandlesFromUrls('Thanks so much, talk soon!')).toBeNull()
  })

  it('a malformed handle segment in an otherwise-valid host is dropped, not returned', () => {
    // '$' isn't in the Instagram SHAPE charset — normalizeHandle returns null.
    expect(extractHandlesFromUrls('https://instagram.com/not$valid')).toBeNull()
  })
})

describe('mergeAndNormaliseHandles', () => {
  it('merges model output with the URL parse; URL wins per-platform when both fire', () => {
    const { handles, dropped } = mergeAndNormaliseHandles({
      modelHandles: { instagram: '@wrong.guess' },
      emailBody: 'IG: https://instagram.com/rosie.hoyle',
    })
    expect(handles).toEqual({ instagram: 'rosie.hoyle' })
    expect(dropped).toBe(0)
  })

  it('counts a dropped model candidate without ever returning it', () => {
    const { handles, dropped } = mergeAndNormaliseHandles({
      modelHandles: { instagram: 'not a handle at all!!' },
      emailBody: 'no url here',
    })
    expect(handles).toBeNull()
    expect(dropped).toBe(1)
  })

  it('no signal anywhere: handles null, dropped 0', () => {
    const { handles, dropped } = mergeAndNormaliseHandles({
      modelHandles: null,
      emailBody: 'Thanks, talk soon!',
    })
    expect(handles).toBeNull()
    expect(dropped).toBe(0)
  })
})

describe('extractSignals — end to end with a stubbed model', () => {
  it('a signature-line handle read by the (stubbed) model reaches ExtractedSignals.handles', async () => {
    stubbedModelResponse = baseModelResponse({ handles: { instagram: '@rosie.hoyle' } })
    const result = await extractSignals('venue-1', 'Hi! Looking forward to it.\n\nCheers,\nRosie\nIG @rosie.hoyle')
    expect(result.handles).toEqual({ instagram: 'rosie.hoyle' })
  })

  it('a profile URL in the body is picked up even when the model finds nothing', async () => {
    stubbedModelResponse = baseModelResponse({ handles: null })
    const result = await extractSignals(
      'venue-1',
      'Hi! You can find us at https://instagram.com/rosie.hoyle',
    )
    expect(result.handles).toEqual({ instagram: 'rosie.hoyle' })
  })

  it('neither source has a handle: ExtractedSignals.handles is null', async () => {
    stubbedModelResponse = baseModelResponse({ handles: null })
    const result = await extractSignals('venue-1', 'Hi! Just a plain question about pricing.')
    expect(result.handles).toBeNull()
  })
})
