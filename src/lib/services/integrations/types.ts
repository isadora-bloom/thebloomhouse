/**
 * Integration-adapter contract (Stream 8 — Integrations Hub).
 *
 * Every external connector — email, phone, video, calendar, audio
 * capture, CRM, push-style SMS — conforms to a single shape so the
 * Settings → Integrations hub can list them, group them, and surface
 * per-venue status uniformly.
 *
 * The pattern mirrors src/lib/services/crm-import/index.ts: a narrow
 * interface, one file per provider, a single registry exporting the
 * full set. Adapters are read-only here — the deep-config flow lives
 * at deepConfigHref (settings page) or the underlying API routes.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type IntegrationCategory =
  | 'email'
  | 'phone'
  | 'video'
  | 'calendar'
  | 'crm'
  | 'audio_capture'
  | 'sms_webhook'

export type IntegrationAuthShape =
  | 'oauth'
  | 'api_key'
  | 'webhook_only'
  | 'paste_token'
  | 'native'

export interface IntegrationStatus {
  connected: boolean
  /** ISO timestamp of last successful sync / heartbeat. */
  lastSyncAt: string | null
  /** Short human-readable status — "Connected as ops@rixeymanor.com",
   *  "Last sync 2h ago", "Disconnected", etc. */
  statusLine: string | null
  /** Error message when connected=false but in an error state. */
  errorLine: string | null
}

export interface IntegrationAdapter {
  /** Stable id; matches the deep-config page slug where applicable. */
  name: string
  /** Display label in the hub card. */
  label: string
  /** Category bucket. */
  category: IntegrationCategory
  /** One-sentence what-it-does blurb. */
  description: string
  /** Auth model. Drives the UI of the connect flow. */
  authShape: IntegrationAuthShape
  /** When true, the adapter is implemented and connectable. When false,
   *  the hub renders a "Coming soon" pill. */
  ready: boolean
  /** Where the operator goes to deep-configure / connect this provider.
   *  Always relative path. Null for adapters whose connect flow lives
   *  in a modal on the hub itself. */
  deepConfigHref: string | null
  /** Per-venue status. Async because most adapters need to read a
   *  connection table. Return a default-disconnected status when the
   *  adapter is `ready: false`. The supabase client is passed in so
   *  the hub can fan out a single service-client across every adapter
   *  in parallel without each adapter spinning its own. */
  getStatus(supabase: SupabaseClient, venueId: string): Promise<IntegrationStatus>
  /** Optional icon name from lucide-react. The hub maps it to the actual
   *  icon component. */
  iconName?: string
  /** Optional badge — "Recommended", "Beta", etc. */
  badge?: 'recommended' | 'beta' | 'legacy' | null
}

/** Default-disconnected status — used by scaffolds and by any adapter
 *  whose underlying table doesn't exist yet for this venue. */
export const DISCONNECTED_STATUS: IntegrationStatus = {
  connected: false,
  lastSyncAt: null,
  statusLine: null,
  errorLine: null,
}
