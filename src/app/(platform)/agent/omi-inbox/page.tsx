/**
 * Legacy redirect — /agent/omi-inbox → /agent/audio-inbox.
 *
 * T2-E Phase 2 (2026-05-01) renamed the surface to be provider-
 * agnostic (audio-capture abstraction per ARCH-5.4). Old bookmarks /
 * email links / external integrations may still hit /omi-inbox; this
 * route preserves them with a permanent redirect.
 */

import { redirect } from 'next/navigation'

export default function OmiInboxLegacyRedirect() {
  redirect('/agent/audio-inbox')
}
