/**
 * Gmail integration adapter.
 *
 * Reads gmail_connections (mig 050). Counts the row as connected when
 * sync_enabled is true and status='active'. Surfaces the primary inbox
 * address in the status line so the operator sees which Google account
 * is feeding Sage's inbox.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { IntegrationAdapter, IntegrationStatus } from './types'

async function getStatus(supabase: SupabaseClient, venueId: string): Promise<IntegrationStatus> {
  const { data, error } = await supabase
    .from('gmail_connections')
    .select('email_address, is_primary, sync_enabled, status, last_sync_at, error_message')
    .eq('venue_id', venueId)
    .order('is_primary', { ascending: false })
    .order('created_at', { ascending: true })

  if (error || !data || data.length === 0) {
    return {
      connected: false,
      lastSyncAt: null,
      statusLine: 'Not connected',
      errorLine: error ? 'Failed to load Gmail connections.' : null,
    }
  }

  const primary = data[0] as {
    email_address: string | null
    is_primary: boolean | null
    sync_enabled: boolean | null
    status: string | null
    last_sync_at: string | null
    error_message: string | null
  }
  const activeCount = data.filter(
    (r) => (r as { status?: string | null }).status === 'active'
      && (r as { sync_enabled?: boolean | null }).sync_enabled !== false,
  ).length

  const connected = activeCount > 0
  const errorRow = data.find((r) => (r as { status?: string | null }).status === 'error') as
    | { error_message: string | null }
    | undefined

  return {
    connected,
    lastSyncAt: primary.last_sync_at,
    statusLine: connected
      ? activeCount === 1
        ? `Connected as ${primary.email_address ?? 'a Google account'}`
        : `${activeCount} mailboxes connected`
      : 'Disconnected',
    errorLine: errorRow?.error_message ?? null,
  }
}

export const gmailAdapter: IntegrationAdapter = {
  name: 'gmail',
  label: 'Gmail',
  category: 'email',
  description: 'Send and receive on behalf of your venue from a connected Google inbox.',
  authShape: 'oauth',
  ready: true,
  deepConfigHref: '/settings/gmail',
  iconName: 'Mail',
  badge: 'recommended',
  getStatus,
}
