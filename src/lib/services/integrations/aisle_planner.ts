/**
 * Aisle Planner CRM presence adapter (hub-only).
 *
 * Same shape as the Dubsado adapter — read-only presence check against
 * weddings.crm_source = 'aisle_planner'. The crm-import scaffold lives
 * at src/lib/services/crm-import/aisleplanner.ts and falls through to
 * Generic CSV until a real export lands.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { IntegrationAdapter, IntegrationStatus } from './types'
import { DISCONNECTED_STATUS } from './types'

async function getStatus(supabase: SupabaseClient, venueId: string): Promise<IntegrationStatus> {
  const { count, error } = await supabase
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .eq('crm_source', 'aisle_planner')

  if (error) return { ...DISCONNECTED_STATUS, statusLine: 'Coming soon' }
  const total = count ?? 0
  return {
    connected: total > 0,
    lastSyncAt: null,
    statusLine: total > 0 ? `${total} couple${total === 1 ? '' : 's'} imported` : 'Coming soon',
    errorLine: null,
  }
}

export const aislePlannerAdapter: IntegrationAdapter = {
  name: 'aisle_planner',
  label: 'Aisle Planner',
  category: 'crm',
  description: 'Import leads, tasks, and messages from Aisle Planner. (Scaffold — use Generic CSV today.)',
  authShape: 'paste_token',
  ready: false,
  deepConfigHref: '/onboarding/crm-import?provider=aisle_planner',
  iconName: 'Database',
  getStatus,
}
