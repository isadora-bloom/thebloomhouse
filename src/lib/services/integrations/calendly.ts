/**
 * Calendly integration adapter.
 *
 * Honest about current state: we don't have a dedicated Calendly OAuth
 * connection yet. The webhook handler at /api/webhooks/calendly is
 * always live (env-var-guarded by CALENDLY_WEBHOOK_SECRET), and the
 * couples flow through tour_booking_links on venue_ai_config. Adapter
 * counts the venue as "connected" when at least one calendly.com link
 * is configured as a tour booking link — that's the proxy signal an
 * operator sees in /settings/sage-identity today.
 *
 * Long-term: a real Calendly OAuth connection table with sync state.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { IntegrationAdapter, IntegrationStatus } from './types'

async function getStatus(supabase: SupabaseClient, venueId: string): Promise<IntegrationStatus> {
  const { data, error } = await supabase
    .from('venue_ai_config')
    .select('tour_booking_links, updated_at')
    .eq('venue_id', venueId)
    .maybeSingle()

  if (error || !data) {
    return {
      connected: false,
      lastSyncAt: null,
      statusLine: 'Not connected',
      errorLine: error ? 'Failed to load tour booking links.' : null,
    }
  }

  const row = data as { tour_booking_links: unknown; updated_at: string | null }
  const links = Array.isArray(row.tour_booking_links) ? row.tour_booking_links : []
  const calendlyLinks = links.filter((l) => {
    if (!l || typeof l !== 'object') return false
    const url = (l as { url?: unknown }).url
    return typeof url === 'string' && url.toLowerCase().includes('calendly.com')
  })

  const connected = calendlyLinks.length > 0
  return {
    connected,
    lastSyncAt: row.updated_at,
    statusLine: connected
      ? `${calendlyLinks.length} booking link${calendlyLinks.length === 1 ? '' : 's'} configured`
      : 'No Calendly links configured',
    errorLine: null,
  }
}

export const calendlyAdapter: IntegrationAdapter = {
  name: 'calendly',
  label: 'Calendly',
  category: 'calendar',
  description: 'Couples book tours through your Calendly link; bookings land as tour touchpoints.',
  authShape: 'webhook_only',
  ready: true,
  deepConfigHref: '/settings/integrations/calendly',
  iconName: 'Calendar',
  getStatus,
}
