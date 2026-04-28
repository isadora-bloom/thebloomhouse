'use client'

/**
 * Settings → OpenPhone (Quo)
 *
 * Per-venue OpenPhone connection: paste an API key, discover the phone
 * numbers on the workspace, opt-out personal cells, and trigger a sync.
 *
 * The api_key is stored on openphone_connections and never rendered
 * back to the client — the GET response only flags whether one exists.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  Phone,
  KeyRound,
  RefreshCcw,
  CheckCircle2,
  AlertTriangle,
  Save,
  Power,
} from 'lucide-react'

interface PhoneNumber {
  id: string
  phoneNumber: string
  name?: string | null
  enabled?: boolean
}

interface ConnectionState {
  hasApiKey: boolean
  workspaceLabel: string | null
  isActive: boolean
  lastSyncedAt: string | null
  phoneNumbers: PhoneNumber[]
}

interface SyncResultBody {
  success: boolean
  inserted?: number
  skipped?: number
  errors?: string[]
  byChannel?: { sms: number; voicemail: number; call_summary: number }
  error?: string
}

const inputClasses =
  'w-full border border-border rounded-lg px-3 py-2 text-sage-900 bg-warm-white focus:ring-2 focus:ring-sage-300 focus:border-sage-500 outline-none transition-colors'

function fmtTime(iso: string | null): string {
  if (!iso) return 'Never'
  try {
    const d = new Date(iso)
    return d.toLocaleString()
  } catch {
    return iso
  }
}

export default function OpenPhoneSettingsPage() {
  const [conn, setConn] = useState<ConnectionState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const [apiKeyInput, setApiKeyInput] = useState('')
  const [workspaceLabel, setWorkspaceLabel] = useState('')
  const [saving, setSaving] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [syncing, setSyncing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/openphone/connection', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as { connection: ConnectionState }
      setConn(json.connection)
      setWorkspaceLabel(json.connection.workspaceLabel ?? '')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Persist key + workspace label.
  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    setInfo(null)
    try {
      const res = await fetch('/api/openphone/connection', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: apiKeyInput || undefined,
          workspaceLabel: workspaceLabel || null,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        throw new Error(json.error || `HTTP ${res.status}`)
      }
      setConn(json.connection as ConnectionState)
      setApiKeyInput('') // never round-trip the secret
      setInfo('Saved.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [apiKeyInput, workspaceLabel])

  // Test connection — pulls /phone-numbers and persists them.
  const handleDiscover = useCallback(async () => {
    setDiscovering(true)
    setError(null)
    setInfo(null)
    try {
      const res = await fetch('/api/openphone/discover', { method: 'POST' })
      const json = await res.json()
      if (!res.ok || !json.success) {
        throw new Error(json.error || `HTTP ${res.status}`)
      }
      setConn((prev) =>
        prev
          ? { ...prev, phoneNumbers: json.phoneNumbers as PhoneNumber[] }
          : prev
      )
      setInfo(
        `Connected. Found ${(json.phoneNumbers as PhoneNumber[]).length} phone number(s).`
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Discover failed')
    } finally {
      setDiscovering(false)
    }
  }, [])

  // Toggle a single phone number's enabled flag and persist.
  const togglePhone = useCallback(
    async (id: string) => {
      if (!conn) return
      const next = conn.phoneNumbers.map((p) =>
        p.id === id ? { ...p, enabled: !(p.enabled ?? true) } : p
      )
      setConn({ ...conn, phoneNumbers: next })
      try {
        await fetch('/api/openphone/connection', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phoneNumbers: next }),
        })
      } catch {
        // Local state is already updated — a refresh will reconcile.
      }
    },
    [conn]
  )

  // Trigger an on-demand sync.
  const handleSync = useCallback(async () => {
    setSyncing(true)
    setError(null)
    setInfo(null)
    try {
      const res = await fetch('/api/openphone/sync', { method: 'POST' })
      const json = (await res.json()) as SyncResultBody
      if (!res.ok || !json.success) {
        throw new Error(json.error || `HTTP ${res.status}`)
      }
      const parts: string[] = []
      if (json.byChannel) {
        if (json.byChannel.sms) parts.push(`${json.byChannel.sms} SMS`)
        if (json.byChannel.voicemail) parts.push(`${json.byChannel.voicemail} voicemail`)
        if (json.byChannel.call_summary) parts.push(`${json.byChannel.call_summary} call`)
      }
      const summary =
        parts.length > 0
          ? `Synced ${json.inserted ?? 0} new (${parts.join(', ')}).`
          : `Synced ${json.inserted ?? 0} new.`
      setInfo(
        json.errors && json.errors.length > 0
          ? `${summary} Warnings: ${json.errors.slice(0, 3).join('; ')}`
          : summary
      )
      // Refresh last_synced_at.
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed')
    } finally {
      setSyncing(false)
    }
  }, [load])

  // Disable the connection (keeps history, stops cron polling).
  const handleDisconnect = useCallback(async () => {
    if (!confirm('Disconnect OpenPhone? Existing messages stay; new ones stop syncing.')) {
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/openphone/connection', { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setInfo('Disconnected.')
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Disconnect failed')
    } finally {
      setSaving(false)
    }
  }, [load])

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1 flex items-center gap-3">
          <Phone className="w-8 h-8 text-sage-500" />
          OpenPhone (Quo)
        </h1>
        <p className="text-sage-600">
          Pull SMS, voicemails, and call summaries into the Agent inbox so coordinator-side
          phone activity sits alongside email. Paste your OpenPhone API key, discover the
          phone numbers on your workspace, and choose which ones to include.
        </p>
      </div>

      {error && (
        <div className="px-4 py-2 rounded-lg bg-red-50 text-red-700 border border-red-200 text-sm flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {info && (
        <div className="px-4 py-2 rounded-lg bg-green-50 text-green-700 border border-green-200 text-sm flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{info}</span>
        </div>
      )}

      {loading ? (
        <div className="text-sage-500 text-sm animate-pulse">Loading OpenPhone settings…</div>
      ) : (
        <>
          {/* API key + label */}
          <section className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-6">
            <div className="flex items-center gap-2 mb-2">
              <KeyRound className="w-5 h-5 text-sage-500" />
              <h2 className="font-heading text-xl font-semibold text-sage-900">API Key</h2>
            </div>

            <div>
              <label className="block text-sm font-medium text-sage-700 mb-1">
                OpenPhone API Key
              </label>
              <input
                type="password"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder={
                  conn?.hasApiKey
                    ? '••••••••  (key on file — paste a new one to rotate)'
                    : 'Paste your OpenPhone API key'
                }
                className={inputClasses}
                autoComplete="off"
              />
              <p className="text-xs text-sage-500 mt-1">
                Generate a key in OpenPhone → Settings → API. Stored encrypted-at-rest in
                Supabase and only used server-side. Bloom never returns it to the browser.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-sage-700 mb-1">
                Workspace Label (optional)
              </label>
              <input
                type="text"
                value={workspaceLabel}
                onChange={(e) => setWorkspaceLabel(e.target.value)}
                placeholder="e.g. Rixey Manor"
                className={inputClasses}
              />
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={handleSave}
                disabled={saving || (!apiKeyInput && !conn?.hasApiKey)}
                className="flex items-center gap-2 bg-sage-500 hover:bg-sage-600 disabled:opacity-50 text-white font-medium rounded-lg px-5 py-2 transition-colors text-sm"
              >
                <Save className="w-4 h-4" />
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={handleDiscover}
                disabled={discovering || !conn?.hasApiKey}
                className="flex items-center gap-2 border border-sage-300 text-sage-700 hover:bg-sage-50 disabled:opacity-50 rounded-lg px-5 py-2 transition-colors text-sm"
                title="Calls /phone-numbers and stores the result"
              >
                <RefreshCcw className={`w-4 h-4 ${discovering ? 'animate-spin' : ''}`} />
                {discovering ? 'Testing…' : 'Test connection'}
              </button>
              {conn?.hasApiKey && (
                <button
                  onClick={handleDisconnect}
                  disabled={saving}
                  className="ml-auto flex items-center gap-2 text-red-600 hover:text-red-700 hover:bg-red-50 disabled:opacity-50 rounded-lg px-3 py-2 transition-colors text-sm"
                >
                  <Power className="w-4 h-4" />
                  Disconnect
                </button>
              )}
            </div>
          </section>

          {/* Phone numbers */}
          <section className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-heading text-xl font-semibold text-sage-900">
                Phone Numbers
              </h2>
              <button
                onClick={handleSync}
                disabled={syncing || !conn?.hasApiKey || (conn?.phoneNumbers?.length ?? 0) === 0}
                className="flex items-center gap-2 bg-sage-500 hover:bg-sage-600 disabled:opacity-50 text-white font-medium rounded-lg px-4 py-2 transition-colors text-sm"
              >
                <RefreshCcw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
                {syncing ? 'Syncing…' : 'Sync now'}
              </button>
            </div>

            <div className="text-xs text-sage-500">
              Last synced: <span className="font-medium text-sage-700">{fmtTime(conn?.lastSyncedAt ?? null)}</span>
            </div>

            {(conn?.phoneNumbers?.length ?? 0) === 0 ? (
              <div className="p-6 text-center text-sm text-sage-500 border border-dashed border-sage-300 rounded-xl">
                No phone numbers discovered yet. Click <span className="font-medium">Test connection</span> after saving your API key.
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {(conn?.phoneNumbers ?? []).map((p) => {
                  const enabled = p.enabled ?? true
                  return (
                    <button
                      key={p.id}
                      onClick={() => togglePhone(p.id)}
                      className={
                        'flex items-center gap-2 px-3 py-1.5 rounded-full border text-sm transition-colors ' +
                        (enabled
                          ? 'bg-sage-100 border-sage-300 text-sage-800 hover:bg-sage-200'
                          : 'bg-white border-sage-200 text-sage-400 hover:bg-sage-50 line-through')
                      }
                      title={enabled ? 'Click to exclude this number' : 'Click to include this number'}
                    >
                      <Phone className="w-3.5 h-3.5" />
                      {p.name ? `${p.name} — ` : ''}
                      {p.phoneNumber}
                    </button>
                  )
                })}
              </div>
            )}

            <p className="text-xs text-sage-500">
              Toggle a chip off to skip that number on the next sync — useful for coordinator
              cells you don&apos;t want logged.
            </p>
          </section>
        </>
      )}
    </div>
  )
}
