'use client'

/**
 * Settings → Zoom integration
 *
 * Lets a venue connect a Zoom account so meeting recordings auto-import as
 * interactions on the matched wedding's timeline. Mirrors the structure of
 * the Omi pairing page so coordinators get a familiar UI.
 *
 * Connected state shows:
 *   - Account email + last sync time
 *   - "Sync now" button (calls /api/zoom/sync)
 *   - "Disconnect" button
 *   - Last 5 processed meetings (topic, date, has-transcript pill)
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useScope } from '@/lib/hooks/use-scope'
import { createClient } from '@/lib/supabase/client'
import {
  ArrowLeft,
  Video,
  RefreshCw,
  Unplug,
  CheckCircle2,
  AlertTriangle,
  FileText,
  Calendar,
} from 'lucide-react'

interface ZoomConnectionRow {
  id: string
  account_email: string | null
  expires_at: string
  is_active: boolean
  updated_at: string
}

interface ProcessedMeetingRow {
  id: string
  zoom_meeting_id: string
  meeting_topic: string | null
  meeting_start_time: string | null
  duration_minutes: number | null
  transcript_text: string | null
  processed_at: string
}

interface SyncResponse {
  ok: boolean
  reason?: string
  message?: string
  fetched?: number
  newlyProcessed?: number
  matched?: number
  skippedNoTranscript?: number
  errors?: number
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export default function ZoomSettingsPage() {
  const { venueId, loading: scopeLoading } = useScope()
  const searchParams = useSearchParams()

  const [connection, setConnection] = useState<ZoomConnectionRow | null>(null)
  const [meetings, setMeetings] = useState<ProcessedMeetingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [message, setMessage] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null)

  // Read OAuth flow result from query params
  useEffect(() => {
    const status = searchParams.get('zoom')
    const reason = searchParams.get('reason')
    const email = searchParams.get('email')
    if (status === 'connected') {
      setMessage({
        kind: 'success',
        text: email ? `Zoom connected: ${email}` : 'Zoom connected.',
      })
    } else if (status === 'error') {
      setMessage({
        kind: 'error',
        text: `Failed to connect Zoom${reason ? ` (${reason})` : ''}.`,
      })
    }
  }, [searchParams])

  const loadConnection = useCallback(async () => {
    if (!venueId) return
    const supabase = createClient()
    const [{ data: connRow }, { data: meetingRows }] = await Promise.all([
      supabase
        .from('zoom_connections')
        .select('id, account_email, expires_at, is_active, updated_at')
        .eq('venue_id', venueId)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('processed_zoom_meetings')
        .select(
          'id, zoom_meeting_id, meeting_topic, meeting_start_time, duration_minutes, transcript_text, processed_at'
        )
        .eq('venue_id', venueId)
        .order('processed_at', { ascending: false })
        .limit(5),
    ])
    setConnection((connRow as ZoomConnectionRow | null) ?? null)
    setMeetings((meetingRows as ProcessedMeetingRow[] | null) ?? [])
    setLoading(false)
  }, [venueId])

  useEffect(() => {
    if (scopeLoading) return
    setLoading(true)
    loadConnection()
  }, [scopeLoading, loadConnection])

  const handleConnect = useCallback(() => {
    window.location.href = '/api/auth/zoom?returnTo=/settings/zoom'
  }, [])

  const handleSync = useCallback(async () => {
    setSyncing(true)
    setMessage(null)
    try {
      const res = await fetch('/api/zoom/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sinceDays: 30 }),
      })
      const data = (await res.json()) as SyncResponse
      if (!res.ok || !data.ok) {
        if (data.reason === 'reconnect_needed') {
          setMessage({
            kind: 'error',
            text: 'Zoom token is no longer valid. Please reconnect.',
          })
          setConnection(null)
        } else {
          setMessage({
            kind: 'error',
            text: data.message ?? 'Sync failed. Check the server logs.',
          })
        }
        return
      }
      const parts: string[] = [`fetched ${data.fetched ?? 0}`]
      if ((data.newlyProcessed ?? 0) > 0) parts.push(`${data.newlyProcessed} new`)
      if ((data.matched ?? 0) > 0) parts.push(`${data.matched} matched`)
      if ((data.skippedNoTranscript ?? 0) > 0)
        parts.push(`${data.skippedNoTranscript} without transcript`)
      if ((data.errors ?? 0) > 0) parts.push(`${data.errors} errors`)
      setMessage({ kind: 'success', text: `Sync complete: ${parts.join(', ')}.` })
      await loadConnection()
    } catch (err) {
      setMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Sync failed.',
      })
    } finally {
      setSyncing(false)
    }
  }, [loadConnection])

  const handleDisconnect = useCallback(async () => {
    if (!connection) return
    if (!window.confirm('Disconnect Zoom? You can reconnect any time.')) return
    setDisconnecting(true)
    setMessage(null)
    try {
      const res = await fetch('/api/auth/zoom/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: connection.id }),
      })
      const data = (await res.json()) as { ok: boolean; reason?: string }
      if (!res.ok || !data.ok) {
        setMessage({
          kind: 'error',
          text: `Failed to disconnect${data.reason ? ` (${data.reason})` : ''}.`,
        })
        return
      }
      setConnection(null)
      setMessage({ kind: 'success', text: 'Zoom disconnected.' })
      await loadConnection()
    } catch (err) {
      setMessage({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Disconnect failed.',
      })
    } finally {
      setDisconnecting(false)
    }
  }, [connection, loadConnection])

  const lastSyncLabel = useMemo(() => {
    if (!connection) return null
    return formatDate(connection.updated_at)
  }, [connection])

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div>
        <Link
          href="/settings"
          className="inline-flex items-center gap-1.5 text-sm text-sage-600 hover:text-sage-800 mb-3"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Settings
        </Link>
        <h1 className="font-heading text-2xl font-bold text-sage-900 flex items-center gap-2">
          <Video className="w-6 h-6 text-sage-500" />
          Zoom Integration
        </h1>
        <p className="text-sage-600 text-sm mt-1">
          Connect a Zoom account so meeting recordings auto-import as interactions
          on the matched wedding&apos;s timeline. Transcripts are searchable and
          feed the AI&apos;s knowledge of each couple.
        </p>
      </div>

      {message && (
        <div
          className={`flex items-start gap-2 px-4 py-3 rounded-lg text-sm ${
            message.kind === 'success'
              ? 'bg-green-50 text-green-800 border border-green-200'
              : message.kind === 'error'
                ? 'bg-red-50 text-red-800 border border-red-200'
                : 'bg-sage-50 text-sage-800 border border-sage-200'
          }`}
        >
          {message.kind === 'success' ? (
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
          ) : message.kind === 'error' ? (
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          ) : null}
          <span>{message.text}</span>
        </div>
      )}

      {loading || scopeLoading ? (
        <div className="bg-surface border border-border rounded-xl p-6 text-sage-500 text-sm">
          Loading Zoom settings...
        </div>
      ) : !connection || !connection.is_active ? (
        <div className="bg-surface border border-border rounded-xl p-6 space-y-4">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-sage-50">
              <Video className="w-5 h-5 text-sage-500" />
            </div>
            <div>
              <h2 className="font-heading text-lg font-semibold text-sage-900">
                Connect Zoom
              </h2>
              <p className="text-sm text-sage-600 mt-1">
                You&apos;ll be redirected to Zoom to authorize access to your
                recordings, meetings, and user profile. Required scopes:
                <span className="font-mono text-xs ml-1">recording:read</span>,
                <span className="font-mono text-xs ml-1">meeting:read</span>,
                <span className="font-mono text-xs ml-1">user:read</span>.
              </p>
            </div>
          </div>
          <button
            onClick={handleConnect}
            className="inline-flex items-center gap-2 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
          >
            <Video className="w-4 h-4" />
            Connect Zoom
          </button>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-xl p-6 space-y-5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-start gap-3 min-w-0">
              <div className="p-2 rounded-lg bg-green-50">
                <CheckCircle2 className="w-5 h-5 text-green-600" />
              </div>
              <div className="min-w-0">
                <h2 className="font-heading text-lg font-semibold text-sage-900 truncate">
                  {connection.account_email ?? 'Zoom account connected'}
                </h2>
                <p className="text-sm text-sage-600 mt-0.5">
                  Last sync: {lastSyncLabel ?? '—'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={handleSync}
                disabled={syncing || disconnecting}
                className="inline-flex items-center gap-1.5 bg-sage-500 hover:bg-sage-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg px-3 py-2 transition-colors"
              >
                <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
                {syncing ? 'Syncing...' : 'Sync now'}
              </button>
              <button
                onClick={handleDisconnect}
                disabled={syncing || disconnecting}
                className="inline-flex items-center gap-1.5 bg-white hover:bg-red-50 text-red-600 text-sm font-medium rounded-lg px-3 py-2 border border-red-200 transition-colors disabled:opacity-50"
              >
                <Unplug className="w-4 h-4" />
                {disconnecting ? 'Disconnecting...' : 'Disconnect'}
              </button>
            </div>
          </div>
        </div>
      )}

      {connection && connection.is_active && (
        <div className="bg-surface border border-border rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-sage-500" />
            <h3 className="font-heading text-base font-semibold text-sage-900">
              Recent meetings
            </h3>
            <span className="text-xs text-sage-500">
              ({meetings.length} of last 5)
            </span>
          </div>

          {meetings.length === 0 ? (
            <p className="text-sm text-sage-500 italic">
              No Zoom meetings imported yet. Click &ldquo;Sync now&rdquo; once
              you&apos;ve recorded a Zoom meeting with cloud recording + audio
              transcript enabled.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {meetings.map((m) => {
                const hasTranscript = !!(m.transcript_text && m.transcript_text.length > 0)
                return (
                  <li key={m.id} className="py-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-sage-900 truncate">
                        {m.meeting_topic || 'Untitled meeting'}
                      </p>
                      <p className="text-xs text-sage-500 mt-0.5">
                        {formatDate(m.meeting_start_time)}
                        {m.duration_minutes ? ` · ${m.duration_minutes} min` : ''}
                      </p>
                    </div>
                    <span
                      className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-full shrink-0 ${
                        hasTranscript
                          ? 'bg-sage-50 text-sage-700 border border-sage-200'
                          : 'bg-amber-50 text-amber-700 border border-amber-200'
                      }`}
                    >
                      <FileText className="w-3 h-3" />
                      {hasTranscript ? 'Transcript' : 'No transcript'}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
