/**
 * Twilio (push-style SMS) adapter.
 *
 * Different model from OpenPhone: Twilio pushes inbound SMS to our
 * webhook rather than us polling an API. Per-venue config lives on
 * multi_channel_inbox_settings (mig 295) — sms_enabled + the list of
 * twilio_phone_numbers we listen for. Webhook handler at
 * /api/webhooks/twilio is env-var-guarded by TWILIO_AUTH_TOKEN.
 *
 * "Last sync" doesn't apply to webhook adapters in the same way as
 * polling integrations, so we surface the count of inbound numbers
 * registered.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { IntegrationAdapter, IntegrationStatus } from './types'

async function getStatus(supabase: SupabaseClient, venueId: string): Promise<IntegrationStatus> {
  const { data, error } = await supabase
    .from('multi_channel_inbox_settings')
    .select('sms_enabled, twilio_phone_numbers, updated_at')
    .eq('venue_id', venueId)
    .maybeSingle()

  if (error || !data) {
    return {
      connected: false,
      lastSyncAt: null,
      statusLine: 'Not connected',
      errorLine: error ? 'Failed to load Twilio settings.' : null,
    }
  }

  const row = data as {
    sms_enabled: boolean | null
    twilio_phone_numbers: string[] | null
    updated_at: string | null
  }
  const numbers = row.twilio_phone_numbers ?? []
  const connected = Boolean(row.sms_enabled) && numbers.length > 0

  return {
    connected,
    lastSyncAt: row.updated_at,
    statusLine: connected
      ? `Listening on ${numbers.length} number${numbers.length === 1 ? '' : 's'}`
      : row.sms_enabled
        ? 'Enabled, no numbers registered yet'
        : 'Disabled',
    errorLine: null,
  }
}

export const twilioAdapter: IntegrationAdapter = {
  name: 'twilio',
  label: 'Twilio',
  category: 'phone',
  description: 'Accept inbound SMS via Twilio webhooks. Best for venues already on Twilio for voice.',
  authShape: 'webhook_only',
  ready: true,
  deepConfigHref: '/settings/integrations/twilio',
  iconName: 'MessageSquareText',
  getStatus,
}
