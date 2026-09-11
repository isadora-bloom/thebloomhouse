/**
 * Instagram DM integration adapter.
 *
 * Wave 3, W28. Reads instagram_connections (migration 401): one row per
 * venue holding the Instagram business account id, the Page, the token
 * reference, status and last_event_at. The connect flow lives at
 * /settings/integrations/instagram; this adapter is read-only for the hub.
 *
 * Webhook-style like Twilio rather than polling like OpenPhone, so "last
 * sync" means "last event we accepted", which is exactly what
 * last_event_at records.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { IntegrationAdapter, IntegrationStatus } from './types'

async function getStatus(
  supabase: SupabaseClient,
  venueId: string,
): Promise<IntegrationStatus> {
  const { data, error } = await supabase
    .from('instagram_connections')
    .select('ig_username, status, status_reason, last_event_at, last_error_message')
    .eq('venue_id', venueId)
    .maybeSingle()

  if (error || !data) {
    return {
      connected: false,
      lastSyncAt: null,
      statusLine: 'Not connected',
      errorLine: error ? 'Failed to load the Instagram connection.' : null,
    }
  }

  const row = data as {
    ig_username: string | null
    status: string | null
    status_reason: string | null
    last_event_at: string | null
    last_error_message: string | null
  }
  const connected = row.status === 'connected'
  const account = row.ig_username ? `@${row.ig_username}` : 'account linked'

  return {
    connected,
    lastSyncAt: row.last_event_at,
    statusLine: connected
      ? row.last_event_at
        ? `Listening as ${account}`
        : `Connected as ${account}, no DMs yet`
      : row.status === 'revoked'
        ? 'Disconnected'
        : row.status === 'error'
          ? 'Needs reconnecting'
          : 'Setup not finished',
    errorLine:
      row.status === 'error'
        ? (row.status_reason ?? row.last_error_message ?? 'Last Meta call failed.')
        : null,
  }
}

export const instagramAdapter: IntegrationAdapter = {
  name: 'instagram',
  label: 'Instagram DMs',
  category: 'social_dm',
  description:
    'Direct messages arrive as signals with the sender’s handle attached, so the first DM joins the same record as the tour and the contract.',
  authShape: 'oauth',
  ready: true,
  deepConfigHref: '/settings/integrations/instagram',
  iconName: 'MessageSquareText',
  badge: 'beta',
  getStatus,
}
