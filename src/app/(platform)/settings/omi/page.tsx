/**
 * Legacy redirect — /settings/omi → /settings/audio-capture.
 *
 * T2-E Phase 2 (2026-05-01) renamed the surface so the future iPhone
 * upload / Otter / Deepgram / AssemblyAI providers share one settings
 * page. Old bookmarks redirect here.
 */

import { redirect } from 'next/navigation'

export default function OmiSettingsLegacyRedirect() {
  redirect('/settings/audio-capture')
}
