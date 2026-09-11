/**
 * Provider classification for the "voice_capture" audio-inbox surface
 * (interactions.surface='voice_capture' — migration 294).
 *
 * Pulled out of the audio-inbox page component in Wave 4 (2026-09-11,
 * W30) so the classification logic is unit-testable without importing a
 * 'use client' page file. The page
 * (src/app/(platform)/agent/audio-inbox/page.tsx) imports this and uses
 * the result to pick a tab, an icon and a thread-card label.
 *
 * Wave 29 (2026-05-11) gave this surface SMS (Twilio/OpenPhone) and Zoom
 * meeting transcripts. Wave 4 W30 adds Instagram DMs, which reuse the
 * SMS interactions chokepoint and so carry type='sms' too (interactions
 * has no 'dm' value in its CHECK — see instagram-dm.ts). Without the
 * channel check below, every Instagram thread would silently misfile as
 * SMS on this page.
 */

export interface VoiceProviderRow {
  type: string
  subject?: string | null
  extracted_identity?: Record<string, unknown> | null
}

export type VoiceProvider = 'sms' | 'zoom' | 'omi' | 'instagram' | 'other'

/**
 * Order matters: Instagram is checked FIRST via
 * `extracted_identity.channel === 'instagram'` (stamped by
 * buildInstagramInteractionRow in instagram-dm.ts) — that check has to
 * win before the type==='sms' check, or an Instagram row is
 * indistinguishable from a phone SMS. Then: SMS = type='sms'; Zoom =
 * type='meeting' + meeting-shaped extracted_identity.provider; Omi =
 * type='meeting' or 'voicemail' that came from the Omi adapter (falls
 * through to default).
 */
export function providerForInteraction(row: VoiceProviderRow): VoiceProvider {
  const channel = row.extracted_identity?.channel
  if (channel === 'instagram') return 'instagram'
  if (row.type === 'sms') return 'sms'
  const provider = row.extracted_identity?.provider
  if (provider === 'zoom') return 'zoom'
  if (provider === 'omi') return 'omi'
  if (row.type === 'meeting' && /zoom/i.test(row.subject ?? '')) return 'zoom'
  // Default: if it's a meeting/voicemail without a tagged provider, treat as Omi
  if (row.type === 'meeting' || row.type === 'voicemail') return 'omi'
  return 'other'
}
