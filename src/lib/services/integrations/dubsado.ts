/**
 * Dubsado CRM presence adapter (hub-only).
 *
 * The crm-import adapter for Dubsado is a scaffold today
 * (src/lib/services/crm-import/dubsado.ts) — it falls through to the
 * Generic CSV importer until a real Dubsado export lands. We still
 * surface the adapter card on the hub so the operator knows where to
 * go, but ready stays false until a real parser ships.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { IntegrationAdapter, IntegrationStatus } from './types'
import { DISCONNECTED_STATUS } from './types'

async function getStatus(supabase: SupabaseClient, venueId: string): Promise<IntegrationStatus> {
  const { count, error } = await supabase
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .eq('crm_source', 'dubsado')

  if (error) return { ...DISCONNECTED_STATUS, statusLine: 'Coming soon' }
  const total = count ?? 0
  return {
    connected: total > 0,
    lastSyncAt: null,
    statusLine: total > 0 ? `${total} couple${total === 1 ? '' : 's'} imported` : 'Coming soon',
    errorLine: null,
  }
}

export const dubsadoAdapter: IntegrationAdapter = {
  name: 'dubsado',
  label: 'Dubsado',
  category: 'crm',
  description: 'Import projects, communications, and contracts from Dubsado. (Scaffold — use Generic CSV today.)',
  authShape: 'paste_token',
  ready: false,
  deepConfigHref: '/onboarding/crm-import?provider=dubsado',
  iconName: 'Database',
  getStatus,
}
