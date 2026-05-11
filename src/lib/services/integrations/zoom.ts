/**
 * Zoom integration adapter (OAuth + polling).
 *
 * Reads zoom_connections (mig 097). Surfaces the account_email and the
 * is_active flag. Last sync is read from the related sync log via
 * updated_at as a proxy — the deep-config page at /settings/zoom owns
 * the richer sync history surface.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { IntegrationAdapter, IntegrationStatus } from './types'

async function getStatus(supabase: SupabaseClient, venueId: string): Promise<IntegrationStatus> {
  const { data, error } = await supabase
    .from('zoom_connections')
    .select('account_email, is_active, expires_at, updated_at')
    .eq('venue_id', venueId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !data) {
    return {
      connected: false,
      lastSyncAt: null,
      statusLine: 'Not connected',
      errorLine: error ? 'Failed to load Zoom connection.' : null,
    }
  }

  const row = data as {
    account_email: string | null
    is_active: boolean | null
    expires_at: string | null
    updated_at: string | null
  }
  const expired = row.expires_at ? new Date(row.expires_at).getTime() < Date.now() : false
  const connected = row.is_active !== false

  return {
    connected,
    lastSyncAt: row.updated_at,
    statusLine: connected
      ? row.account_email
        ? `Connected as ${row.account_email}`
        : 'Connected'
      : 'Disconnected',
    errorLine: expired ? 'Token expired — reconnect required.' : null,
  }
}

export const zoomAdapter: IntegrationAdapter = {
  name: 'zoom',
  label: 'Zoom',
  category: 'video',
  description: 'Auto-import meeting transcripts as tour touchpoints on the matching wedding.',
  authShape: 'oauth',
  ready: true,
  deepConfigHref: '/settings/zoom',
  iconName: 'Video',
  badge: 'recommended',
  getStatus,
}
