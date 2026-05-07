'use client'

/**
 * Gmail connection status banner for /agent/inbox.
 *
 * Surfaces three states inline at the top of the page:
 *   - Connected + healthy → tiny green pill, dismissable
 *   - Error / token refresh failed → amber banner with "Reconnect"
 *   - Never connected → amber banner with "Connect Gmail"
 *
 * Bit Rixey 2026-04-30: Gmail token expired 3 days before user
 * realised. The settings page had the reconnect button but inbox
 * gave no indication anything was wrong. Now the inbox itself
 * surfaces it.
 */

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { CheckCircle2, AlertTriangle, RefreshCw, Mail } from 'lucide-react'

interface ConnectionState {
  email_address: string | null
  status: 'active' | 'error' | 'disconnected' | null
  error_message: string | null
  last_sync_at: string | null
  sync_enabled: boolean
}

interface Props {
  venueId: string | null
}

function fmtRelative(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function GmailConnectionStatus({ venueId }: Props) {
  const [state, setState] = useState<ConnectionState | 'loading' | 'none'>('loading')

  useEffect(() => {
    if (!venueId) return
    let cancelled = false
    const sb = createClient()
    ;(async () => {
      const { data } = await sb
        .from('gmail_connections')
        .select('email_address, status, error_message, last_sync_at, sync_enabled')
        .eq('venue_id', venueId)
        .eq('is_primary', true)
        .maybeSingle()
      if (cancelled) return
      if (!data) {
        setState('none')
      } else {
        setState(data as ConnectionState)
      }
    })()
    return () => { cancelled = true }
  }, [venueId])

  if (state === 'loading') return null

  function reconnect() {
    const returnTo = '/agent/inbox'
    window.location.href = `/api/gmail/oauth/start?returnTo=${encodeURIComponent(returnTo)}`
  }

  if (state === 'none') {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Mail className="w-5 h-5 text-amber-600 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-amber-900">No Gmail connected</p>
            <p className="text-xs text-amber-700">Connect your venue Gmail to start polling and drafting replies.</p>
          </div>
        </div>
        <button
          onClick={reconnect}
          className="text-xs font-medium px-3 py-1.5 bg-sage-600 text-white rounded-lg hover:bg-sage-700 inline-flex items-center gap-1 shrink-0"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Connect Gmail
        </button>
      </div>
    )
  }

  const conn = state as ConnectionState

  if (conn.status === 'error' || conn.status === 'disconnected' || !conn.sync_enabled) {
    return (
      <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-rose-900">
              Gmail sync failed for {conn.email_address ?? 'this connection'}
            </p>
            <p className="text-xs text-rose-700 truncate">
              {conn.error_message ?? 'Connection inactive.'} Last sync {fmtRelative(conn.last_sync_at)}.
            </p>
          </div>
        </div>
        <button
          onClick={reconnect}
          className="text-xs font-medium px-3 py-1.5 bg-rose-600 text-white rounded-lg hover:bg-rose-700 inline-flex items-center gap-1 shrink-0"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Reconnect Gmail
        </button>
      </div>
    )
  }

  // active + healthy. Compact one-liner so it doesn't take much
  // vertical space on a normal day.
  return (
    <div className="bg-emerald-50/60 border border-emerald-100 rounded-lg px-3 py-1.5 flex items-center gap-2 text-xs">
      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
      <span className="text-emerald-800">
        Gmail connected as <strong>{conn.email_address}</strong> · last sync {fmtRelative(conn.last_sync_at)}
      </span>
    </div>
  )
}
