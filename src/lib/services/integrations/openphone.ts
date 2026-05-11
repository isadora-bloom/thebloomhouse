/**
 * OpenPhone (Quo) integration adapter.
 *
 * Reads openphone_connections (mig 097). Single row per venue: an
 * api_key + workspace_label + phone_numbers jsonb + last_synced_at +
 * is_active toggle. The /settings/openphone page owns the connect
 * flow; this adapter is read-only for the hub.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { IntegrationAdapter, IntegrationStatus } from './types'

async function getStatus(supabase: SupabaseClient, venueId: string): Promise<IntegrationStatus> {
  const { data, error } = await supabase
    .from('openphone_connections')
    .select('workspace_label, phone_numbers, is_active, last_synced_at')
    .eq('venue_id', venueId)
    .maybeSingle()

  if (error || !data) {
    return {
      connected: false,
      lastSyncAt: null,
      statusLine: 'Not connected',
      errorLine: error ? 'Failed to load OpenPhone connection.' : null,
    }
  }

  const row = data as {
    workspace_label: string | null
    phone_numbers: unknown
    is_active: boolean | null
    last_synced_at: string | null
  }
  const numberCount = Array.isArray(row.phone_numbers) ? row.phone_numbers.length : 0
  const connected = row.is_active !== false

  return {
    connected,
    lastSyncAt: row.last_synced_at,
    statusLine: connected
      ? row.workspace_label
        ? `Connected to ${row.workspace_label}${numberCount > 0 ? ` (${numberCount} number${numberCount === 1 ? '' : 's'})` : ''}`
        : `Connected${numberCount > 0 ? ` (${numberCount} number${numberCount === 1 ? '' : 's'})` : ''}`
      : 'Paused',
    errorLine: null,
  }
}

export const openphoneAdapter: IntegrationAdapter = {
  name: 'openphone',
  label: 'OpenPhone (Quo)',
  category: 'phone',
  description: 'Pull SMS, voicemail, and call summaries into the lead timeline via the OpenPhone API.',
  authShape: 'api_key',
  ready: true,
  deepConfigHref: '/settings/openphone',
  iconName: 'Phone',
  badge: 'recommended',
  getStatus,
}
