/**
 * HoneyBook CRM presence adapter (hub-only).
 *
 * The real import flow lives at /onboarding/crm-import and uses the
 * adapters under src/lib/services/crm-import/. This adapter is read-
 * only — it tells the hub whether the venue has ever imported HoneyBook
 * data. "Connected" here means "we have HoneyBook-sourced weddings on
 * file" (proxy signal: weddings.crm_source = 'honeybook').
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { IntegrationAdapter, IntegrationStatus } from './types'

async function getStatus(supabase: SupabaseClient, venueId: string): Promise<IntegrationStatus> {
  const { count, error } = await supabase
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .eq('crm_source', 'honeybook')

  if (error) {
    return {
      connected: false,
      lastSyncAt: null,
      statusLine: 'Not imported',
      errorLine: 'Failed to load CRM import status.',
    }
  }

  const total = count ?? 0
  return {
    connected: total > 0,
    lastSyncAt: null,
    statusLine: total > 0 ? `${total} couple${total === 1 ? '' : 's'} imported` : 'Not imported',
    errorLine: null,
  }
}

export const honeybookAdapter: IntegrationAdapter = {
  name: 'honeybook',
  label: 'HoneyBook',
  category: 'crm',
  description: 'Import lead history, communications, and bookings from HoneyBook.',
  authShape: 'paste_token',
  ready: true,
  deepConfigHref: '/onboarding/crm-import?provider=honeybook',
  iconName: 'Database',
  getStatus,
}
