'use client'

/**
 * Settings → Omi pairing
 *
 * Phase 7 Task 61. Lets a venue pair an Omi Dev Kit 2 wearable to this
 * venue's webhook so tour conversations auto-transcribe onto the matched
 * tour row.
 *
 * What this page can do:
 *   - Show / generate / rotate the venue's webhook token
 *   - Copy the full webhook URL to the clipboard
 *   - Toggle auto-match on/off
 *   - Set the match window (3 to 24 hours)
 *
 * White-label: every string uses the venue's business name + the AI's
 * configured name (venue_ai_config.ai_name). No hardcoded 'Sage' or 'Rixey'.
 */

import { useState, useEffect, useMemo } from 'react'
import { useScope } from '@/lib/hooks/use-scope'
import { createClient } from '@/lib/supabase/client'
import {
  Cpu,
  Copy,
  RefreshCw,
  Check,
  AlertTriangle,
  Clock,
  ToggleRight,
  ToggleLeft,
} from 'lucide-react'

interface Settings {
  token: string | null
  autoMatchEnabled: boolean
  matchWindowHours: number
}

export default function OmiSettingsPage() {
  const { venueId } = useScope()
  const [settings, setSettings] = useState<Settings>({
    token: null,
    autoMatchEnabled: true,
    matchWindowHours: 6,
  })
  const [aiName, setAiName] = useState<string>('your assistant')
  const [venueName, setVenueName] = useState<string>('your venue')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load token + venue/AI names
  useEffect(() => {
    if (!venueId) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        const supabase = createClient()
        const [tokenRes, aiRes, cfgRes, venueRes] = await Promise.all([
          fetch('/api/omi/token'),
          supabase
            .from('venue_ai_config')
            .select('ai_name')
            .eq('venue_id', venueId)
            .maybeSingle(),
          supabase
            .from('venue_config')
            .select('business_name')
            .eq('venue_id', venueId)
            .maybeSingle(),
          supabase.from('venues').select('name').eq('id', venueId).maybeSingle(),
        ])
        if (cancelled) return
        if (!tokenRes.ok) throw new Error(`HTTP ${tokenRes.status}`)
        const tokenJson = (await tokenRes.json()) as Settings
        setSettings({
          token: tokenJson.token ?? null,
          autoMatchEnabled: tokenJson.autoMatchEnabled !== false,
          matchWindowHours: Number(tokenJson.matchWindowHours) || 6,
        })
        setAiName(
          (aiRes.data?.ai_name as string | undefined) ||
            'your assistant'
        )
        setVenueName(
          (cfgRes.data?.business_name as string | undefined) ||
            (venueRes.data?.name as string | undefined) ||
            'your venue'
        )
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [venueId])

  const webhookUrl = useMemo(() => {
    if (!settings.token) return null
    if (typeof window === 'undefined') return null
    return `${window.location.origin}/api/omi/webhook?token=${settings.token}`
  }, [settings.token])

  async function handleRotate() {
    const msg = settings.token
      ? 'Rotate the webhook token? The current URL will stop working the moment you rotate. You will need to paste the new URL into the Omi app.'
      : 'Generate a new webhook token for this venue?'
    if (!confirm(msg)) return
    setRotating(true)
    setError(null)
    try {
      const res = await fetch('/api/omi/token', { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Failed' }))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      const json = (await res.json()) as { token: string }
      setSettings((s) => ({ ...s, token: json.token }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to rotate token')
    } finally {
      setRotating(false)
    }
  }

  async function handleCopy() {
    if (!webhookUrl) return
    try {
      await navigator.clipboard.writeText(webhookUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setError('Clipboard unavailable. Select the URL and copy manually.')
    }
  }

  async function handleToggleAutoMatch() {
    const next = !settings.autoMatchEnabled
    setSettings((s) => ({ ...s, autoMatchEnabled: next }))
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/omi/token', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoMatchEnabled: next }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (e) {
      setSettings((s) => ({ ...s, autoMatchEnabled: !next }))
      setError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function handleWindowChange(hours: number) {
    const clamped = Math.max(3, Math.min(24, Math.round(hours)))
    setSettings((s) => ({ ...s, matchWindowHours: clamped }))
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/omi/token', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchWindowHours: clamped }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="text-sm text-sage-500 p-6">Loading Omi settings...</div>
  }

  return (
    <div className="max-w-3xl space-y-8">
      <header className="flex items-center gap-3">
        <Cpu className="w-6 h-6 text-sage-600" />
        <div>
          <h1 className="text-2xl font-serif text-sage-900">Omi Pairing</h1>
          <p className="text-sm text-sage-600 mt-1">
            Wear an Omi Dev Kit 2 during tours and {aiName} will learn from
            what was said. Transcripts attach to the matching tour
            automatically so you never have to write up a recap.
          </p>
        </div>
      </header>

      {/* Webhook URL card */}
      <section className="border border-border rounded-lg bg-warm-white p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-sage-800">Webhook URL</h2>
          {settings.token && (
            <span className="text-xs text-sage-500">Token is active for {venueName}</span>
          )}
        </div>

        {webhookUrl ? (
          <div className="flex flex-col sm:flex-row gap-2">
            <code className="flex-1 min-w-0 text-xs font-mono bg-sage-50 border border-sage-200 rounded px-3 py-2 truncate text-sage-900">
              {webhookUrl}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-sage-600 text-white rounded-lg text-sm font-medium hover:bg-sage-700 transition-colors"
            >
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copied ? 'Copied' : 'Copy URL'}
            </button>
          </div>
        ) : (
          <div className="text-sm text-sage-600 border border-dashed border-border rounded-lg px-4 py-3">
            No webhook token yet. Generate one to start receiving Omi
            transcripts for {venueName}.
          </div>
        )}

        <div>
          <button
            type="button"
            onClick={handleRotate}
            disabled={rotating}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-sage-200 text-sage-700 rounded-lg text-sm hover:bg-sage-50 disabled:opacity-50 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${rotating ? 'animate-spin' : ''}`} />
            {settings.token ? 'Rotate token' : 'Generate token'}
          </button>
          {settings.token && (
            <p className="text-xs text-sage-500 mt-1.5 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              Rotating breaks the current URL immediately. Paste the new one
              into Omi afterwards.
            </p>
          )}
        </div>
      </section>

      {/* Matching behaviour */}
      <section className="border border-border rounded-lg bg-warm-white p-4 space-y-4">
        <h2 className="text-sm font-medium text-sage-800">Matching behaviour</h2>

        <div className="flex items-start justify-between gap-4">
          <div>
            <label className="block text-sm text-sage-900">Auto-match to scheduled tours</label>
            <p className="text-xs text-sage-500 mt-0.5">
              When on, Omi segments automatically attach to the nearest
              scheduled tour within the match window. When off, every session
              lands in your Omi Inbox for manual attach.
            </p>
          </div>
          <button
            type="button"
            onClick={handleToggleAutoMatch}
            disabled={saving}
            className="shrink-0 text-sage-700 hover:text-sage-900 transition-colors"
            aria-pressed={settings.autoMatchEnabled}
          >
            {settings.autoMatchEnabled ? (
              <ToggleRight className="w-9 h-9" />
            ) : (
              <ToggleLeft className="w-9 h-9 text-sage-400" />
            )}
          </button>
        </div>

        <div>
          <label className="block text-sm text-sage-900 flex items-center gap-1.5">
            <Clock className="w-4 h-4 text-sage-600" />
            Match window (hours)
          </label>
          <p className="text-xs text-sage-500 mt-0.5 mb-2">
            How wide a window around a scheduled tour counts as a match. 3 to 24 hours.
          </p>
          <input
            type="number"
            min={3}
            max={24}
            value={settings.matchWindowHours}
            onChange={(e) => handleWindowChange(Number(e.target.value))}
            disabled={saving || !settings.autoMatchEnabled}
            className="w-28 border border-border rounded-lg px-3 py-2 bg-warm-white text-sage-900 text-sm focus:outline-none focus:ring-2 focus:ring-sage-300 disabled:opacity-50"
          />
        </div>
      </section>

      {/* Help / pairing instructions */}
      <section className="border border-sage-200 rounded-lg bg-sage-50 p-4 space-y-2 text-sm text-sage-800">
        <h2 className="font-medium">How to pair with Omi</h2>
        <ol className="list-decimal list-inside space-y-1 text-sage-700">
          <li>Open the Omi app on your phone.</li>
          <li>Go to <span className="font-medium">Developer Mode</span> and turn it on.</li>
          <li>Open <span className="font-medium">Developer Settings</span>.</li>
          <li>Paste the webhook URL above into the real-time transcript hook and save.</li>
          <li>Wear the Omi Dev Kit 2 during tours. Transcripts appear on the tour row automatically within {settings.matchWindowHours} hours of the scheduled time.</li>
        </ol>
        <p className="text-xs text-sage-600 mt-2">
          Paste this so {aiName} can learn from your tours at {venueName}. If
          a session can't find a tour (for example, a walk-in), it will appear
          in the Omi Inbox so you can attach it manually.
        </p>
      </section>

      {error && (
        <div className="border border-red-200 bg-red-50 text-red-700 text-sm rounded-lg px-3 py-2">
          {error}
        </div>
      )}
    </div>
  )
}
