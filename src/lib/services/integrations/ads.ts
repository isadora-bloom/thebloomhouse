/**
 * Ad platforms on the integrations hub (wave 8 follow-up to W54).
 *
 * W54 shipped real Google Ads, Meta Ads and TikTok Ads connectors with
 * their own settings pages under /settings/integrations/<provider>, but
 * the hub had no "ads" category, so the pages were reachable only by
 * typing the URL. The repo's rule is that a page ships with a way in.
 *
 * Connected-or-not comes from each connector's own connectorStatus(), so
 * the hub, the settings page and the reallocation copy all answer from
 * the same read. The account label is read here for the status line only.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { IntegrationAdapter, IntegrationStatus } from './types'
import { connectorStatus as googleAdsStatus } from '@/lib/services/marketing-spend/connectors/google-ads'
import { connectorStatus as metaAdsStatus } from '@/lib/services/marketing-spend/connectors/meta-ads'
import { connectorStatus as tiktokAdsStatus } from '@/lib/services/marketing-spend/connectors/tiktok-ads'

interface AdProvider {
  name: 'google-ads' | 'meta-ads' | 'tiktok-ads'
  label: string
  description: string
  table: string
  accountNameColumn: string
  accountIdColumn: string
  status: (venueId: string, supabase?: SupabaseClient) => Promise<'connected' | 'manual'>
}

const PROVIDERS: AdProvider[] = [
  {
    name: 'google-ads',
    label: 'Google Ads',
    description: 'Daily spend, impressions, clicks and conversions per campaign arrive on their own, so the return column stops depending on what was typed in.',
    table: 'google_ads_connections',
    accountNameColumn: 'customer_name',
    accountIdColumn: 'customer_id',
    status: googleAdsStatus,
  },
  {
    name: 'meta-ads',
    label: 'Meta Ads',
    description: 'Facebook and Instagram ad spend and lead-shaped conversions per campaign, read daily from the ad account you choose.',
    table: 'meta_ads_connections',
    accountNameColumn: 'ad_account_name',
    accountIdColumn: 'ad_account_id',
    status: metaAdsStatus,
  },
  {
    name: 'tiktok-ads',
    label: 'TikTok Ads',
    description: 'Campaign spend and results from the TikTok advertiser account, read daily in the account currency.',
    table: 'tiktok_ads_connections',
    accountNameColumn: 'advertiser_name',
    accountIdColumn: 'advertiser_id',
    status: tiktokAdsStatus,
  },
]

function makeGetStatus(p: AdProvider) {
  return async function getStatus(
    supabase: SupabaseClient,
    venueId: string,
  ): Promise<IntegrationStatus> {
    let connected = false
    try {
      connected = (await p.status(venueId, supabase)) === 'connected'
    } catch {
      connected = false
    }
    if (!connected) {
      return {
        connected: false,
        lastSyncAt: null,
        statusLine: 'Numbers are typed in until this is connected',
        errorLine: null,
      }
    }
    const { data } = await supabase
      .from(p.table)
      .select(`${p.accountNameColumn}, ${p.accountIdColumn}, last_synced_at`)
      .eq('venue_id', venueId)
      .maybeSingle()
    const row = (data ?? {}) as Record<string, string | null>
    const account = row[p.accountNameColumn] ?? row[p.accountIdColumn] ?? 'account linked'
    const lastSyncAt = row.last_synced_at ?? null
    return {
      connected: true,
      lastSyncAt,
      statusLine: lastSyncAt ? `Connected as ${account}` : `Connected as ${account}, first sync pending`,
      errorLine: null,
    }
  }
}

function makeAdapter(p: AdProvider): IntegrationAdapter {
  return {
    name: p.name,
    label: p.label,
    category: 'ads',
    description: p.description,
    authShape: 'oauth',
    ready: true,
    deepConfigHref: `/settings/integrations/${p.name}`,
    iconName: 'Megaphone',
    getStatus: makeGetStatus(p),
  }
}

export const googleAdsIntegrationAdapter = makeAdapter(PROVIDERS[0]!)
export const metaAdsIntegrationAdapter = makeAdapter(PROVIDERS[1]!)
export const tiktokAdsIntegrationAdapter = makeAdapter(PROVIDERS[2]!)
