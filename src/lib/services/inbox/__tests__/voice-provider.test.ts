/**
 * Wave 4 W30 — audio-inbox provider classification.
 *
 * Pins the Instagram-first ordering: an Instagram DM row carries
 * type='sms' (same as a phone SMS — interactions has no 'dm' value), so
 * `extracted_identity.channel` has to be checked before the type==='sms'
 * fallback or every Instagram thread misfiles as SMS on the audio-inbox
 * page.
 */

import { describe, expect, it } from 'vitest'
import { providerForInteraction } from '../voice-provider'

describe('providerForInteraction', () => {
  it('labels a row with extracted_identity.channel=instagram as instagram, even though type is sms', () => {
    const provider = providerForInteraction({
      type: 'sms',
      subject: 'Instagram DM from @rosie.hoyle',
      extracted_identity: { channel: 'instagram', instagram_handle: '@rosie.hoyle' },
    })
    expect(provider).toBe('instagram')
  })

  it('still labels a plain phone SMS row as sms', () => {
    const provider = providerForInteraction({
      type: 'sms',
      subject: 'SMS from 5551234567',
      extracted_identity: null,
    })
    expect(provider).toBe('sms')
  })

  it('labels a zoom-tagged meeting row as zoom', () => {
    const provider = providerForInteraction({
      type: 'meeting',
      subject: 'Tour walkthrough',
      extracted_identity: { provider: 'zoom' },
    })
    expect(provider).toBe('zoom')
  })

  it('falls back to omi for an untagged meeting/voicemail row', () => {
    expect(
      providerForInteraction({ type: 'meeting', subject: null, extracted_identity: null }),
    ).toBe('omi')
    expect(
      providerForInteraction({ type: 'voicemail', subject: null, extracted_identity: null }),
    ).toBe('omi')
  })

  it('falls back to other for anything else', () => {
    expect(
      providerForInteraction({ type: 'email', subject: null, extracted_identity: null }),
    ).toBe('other')
  })
})
