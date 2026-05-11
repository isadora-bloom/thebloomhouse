/**
 * Audio Capture adapter (Omi / Plaud and future providers).
 *
 * Connection state lives on venue_config.omi_webhook_token (mig 082).
 * Presence of a token = the venue has paired at least one audio-capture
 * device. The deep-config page at /settings/audio-capture is provider-
 * agnostic; additional providers (Plaud, Otter, AssemblyAI, Deepgram)
 * slot in there as adapters land.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { IntegrationAdapter, IntegrationStatus } from './types'

async function getStatus(supabase: SupabaseClient, venueId: string): Promise<IntegrationStatus> {
  const { data, error } = await supabase
    .from('venue_config')
    .select('omi_webhook_token, omi_auto_match_enabled, updated_at')
    .eq('venue_id', venueId)
    .maybeSingle()

  if (error || !data) {
    return {
      connected: false,
      lastSyncAt: null,
      statusLine: 'Not connected',
      errorLine: error ? 'Failed to load audio-capture settings.' : null,
    }
  }

  const row = data as {
    omi_webhook_token: string | null
    omi_auto_match_enabled: boolean | null
    updated_at: string | null
  }
  const connected = Boolean(row.omi_webhook_token)
  return {
    connected,
    lastSyncAt: row.updated_at,
    statusLine: connected
      ? row.omi_auto_match_enabled === false
        ? 'Webhook paired, auto-match off'
        : 'Webhook paired, auto-match on'
      : 'No webhook paired',
    errorLine: null,
  }
}

export const audioCaptureAdapter: IntegrationAdapter = {
  name: 'audio_capture',
  label: 'Omi / Plaud',
  category: 'audio_capture',
  description: 'Wearable transcripts auto-attach to the matching tour for post-tour briefs and voice learning.',
  authShape: 'paste_token',
  ready: true,
  deepConfigHref: '/settings/audio-capture',
  iconName: 'Cpu',
  getStatus,
}
