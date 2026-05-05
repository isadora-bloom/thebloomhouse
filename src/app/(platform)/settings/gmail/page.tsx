/**
 * Settings → Gmail (PROJECT-AUDIT-V2 GAP-13)
 *
 * Coordinator-facing page that lists every connected Gmail inbox for
 * the active venue and lets the coordinator add another or disconnect.
 *
 * Server component fetches the initial connection list via the service
 * client (RLS-bypass for trusted server context — auth gate above).
 * Interactive bits (toast handling, disconnect, re-connect) live in
 * the client island below.
 */

import { redirect } from 'next/navigation'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { GmailSettingsClient, type GmailConnectionView } from './client'

export const dynamic = 'force-dynamic'

export default async function GmailSettingsPage() {
  const auth = await getPlatformAuth()
  if (!auth) {
    redirect('/login?redirect=/settings/gmail')
  }

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('gmail_connections')
    .select(
      'id, email_address, is_primary, sync_enabled, label, status, error_message, last_sync_at, created_at, user_id',
    )
    .eq('venue_id', auth.venueId)
    .order('is_primary', { ascending: false })
    .order('created_at', { ascending: true })

  const connections: GmailConnectionView[] = error
    ? []
    : (data ?? []).map((row) => ({
        id: row.id as string,
        emailAddress: (row.email_address as string) ?? null,
        isPrimary: Boolean(row.is_primary),
        syncEnabled: Boolean(row.sync_enabled),
        label: (row.label as string | null) ?? null,
        status: (row.status as string | null) ?? 'active',
        errorMessage: (row.error_message as string | null) ?? null,
        lastSyncAt: (row.last_sync_at as string | null) ?? null,
        createdAt: (row.created_at as string | null) ?? null,
      }))

  const loadError = error ? 'Failed to load connections from the database.' : null

  return (
    <GmailSettingsClient
      connections={connections}
      loadError={loadError}
      venueId={auth.venueId}
    />
  )
}
