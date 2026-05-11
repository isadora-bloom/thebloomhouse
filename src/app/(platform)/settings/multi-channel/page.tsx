'use client'

/**
 * Settings -> Multi-channel inbox  (Wave 29, 2026-05-11)
 *
 * Per-venue configuration for SMS (Twilio) and meeting transcripts (Zoom).
 *
 * Backed by multi_channel_inbox_settings (mig 295). The fields:
 *   - sms_enabled                  toggle SMS ingest on/off
 *   - twilio_phone_numbers[]       E.164 numbers we should accept inbound
 *                                  Twilio webhooks for
 *   - zoom_enabled                 toggle Zoom transcript ingest on/off
 *   - zoom_account_emails[]        host emails whose meetings count for
 *                                  this venue (a coordinator who uses
 *                                  isadora@rixeymanor.com for Zoom adds
 *                                  her email here)
 *   - voice_capture_enabled        master kill-switch for the entire
 *                                  voice_capture surface
 *
 * Webhook URLs to register externally (the page surfaces them at the
 * bottom for copy/paste):
 *   Twilio: https://<app>/api/webhooks/twilio
 *   Zoom:   https://<app>/api/webhooks/zoom
 *
 * The actual webhook handlers (route.ts files under
 * /api/webhooks/twilio and /api/webhooks/zoom) refuse traffic with 503
 * when TWILIO_AUTH_TOKEN / ZOOM_WEBHOOK_SECRET are missing, so this
 * settings page is decoupled from credential provisioning — Isadora
 * can preconfigure the venue here and flip the venue-wide enable when
 * the env vars are in place.
 *
 * White-label: no venue-name or AI-name hardcoding.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useScope } from '@/lib/hooks/use-scope'
import { createClient } from '@/lib/supabase/client'
import {
  MessageSquare,
  Video,
  ToggleRight,
  ToggleLeft,
  Plus,
  Trash2,
  Copy,
  Check,
  AlertTriangle,
} from 'lucide-react'

interface MultiChannelSettings {
  sms_enabled: boolean
  twilio_phone_numbers: string[]
  zoom_enabled: boolean
  zoom_account_emails: string[]
  voice_capture_enabled: boolean
}

const DEFAULT_SETTINGS: MultiChannelSettings = {
  sms_enabled: false,
  twilio_phone_numbers: [],
  zoom_enabled: false,
  zoom_account_emails: [],
  voice_capture_enabled: true,
}

export default function MultiChannelSettingsPage() {
  const { venueId } = useScope()
  const [settings, setSettings] = useState<MultiChannelSettings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newPhone, setNewPhone] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [copied, setCopied] = useState<'twilio' | 'zoom' | null>(null)

  const load = useCallback(async () => {
    if (!venueId) return
    setLoading(true)
    setError(null)
    try {
      const supabase = createClient()
      const { data, error: err } = await supabase
        .from('multi_channel_inbox_settings')
        .select('*')
        .eq('venue_id', venueId)
        .maybeSingle()
      if (err) throw err
      if (data) {
        setSettings({
          sms_enabled: Boolean(data.sms_enabled),
          twilio_phone_numbers: (data.twilio_phone_numbers as string[] | null) ?? [],
          zoom_enabled: Boolean(data.zoom_enabled),
          zoom_account_emails: (data.zoom_account_emails as string[] | null) ?? [],
          voice_capture_enabled: data.voice_capture_enabled !== false,
        })
      } else {
        setSettings(DEFAULT_SETTINGS)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [venueId])

  useEffect(() => {
    load()
  }, [load])

  /** Persist whatever `next` is. We do upsert so the first save creates the row. */
  const saveSettings = useCallback(
    async (next: MultiChannelSettings) => {
      if (!venueId) return
      setSaving(true)
      setError(null)
      try {
        const supabase = createClient()
        const { error: err } = await supabase
          .from('multi_channel_inbox_settings')
          .upsert(
            {
              venue_id: venueId,
              sms_enabled: next.sms_enabled,
              twilio_phone_numbers: next.twilio_phone_numbers,
              zoom_enabled: next.zoom_enabled,
              zoom_account_emails: next.zoom_account_emails,
              voice_capture_enabled: next.voice_capture_enabled,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'venue_id' },
          )
        if (err) throw err
        setSettings(next)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to save')
      } finally {
        setSaving(false)
      }
    },
    [venueId],
  )

  function handleToggle(field: keyof MultiChannelSettings) {
    if (typeof settings[field] !== 'boolean') return
    const next = { ...settings, [field]: !settings[field] }
    void saveSettings(next)
  }

  function handleAddPhone() {
    const value = newPhone.trim()
    if (!value) return
    // Soft E.164 validation: starts with + and has 10+ digits.
    const digits = value.replace(/\D+/g, '')
    if (digits.length < 10) {
      setError('Phone number must be at least 10 digits.')
      return
    }
    const normalised = value.startsWith('+') ? value : `+${digits}`
    if (settings.twilio_phone_numbers.includes(normalised)) {
      setError('That phone number is already in the list.')
      return
    }
    const next = {
      ...settings,
      twilio_phone_numbers: [...settings.twilio_phone_numbers, normalised],
    }
    setNewPhone('')
    void saveSettings(next)
  }

  function handleRemovePhone(phone: string) {
    const next = {
      ...settings,
      twilio_phone_numbers: settings.twilio_phone_numbers.filter((p) => p !== phone),
    }
    void saveSettings(next)
  }

  function handleAddEmail() {
    const value = newEmail.trim().toLowerCase()
    if (!value) return
    if (!value.includes('@')) {
      setError('That does not look like an email.')
      return
    }
    if (settings.zoom_account_emails.includes(value)) {
      setError('That email is already in the list.')
      return
    }
    const next = {
      ...settings,
      zoom_account_emails: [...settings.zoom_account_emails, value],
    }
    setNewEmail('')
    void saveSettings(next)
  }

  function handleRemoveEmail(email: string) {
    const next = {
      ...settings,
      zoom_account_emails: settings.zoom_account_emails.filter((e) => e !== email),
    }
    void saveSettings(next)
  }

  const twilioWebhookUrl = useMemo(() => {
    if (typeof window === 'undefined') return ''
    return `${window.location.origin}/api/webhooks/twilio`
  }, [])

  const zoomWebhookUrl = useMemo(() => {
    if (typeof window === 'undefined') return ''
    return `${window.location.origin}/api/webhooks/zoom`
  }, [])

  async function copyToClipboard(url: string, kind: 'twilio' | 'zoom') {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(kind)
      setTimeout(() => setCopied(null), 1800)
    } catch {
      setError('Clipboard unavailable. Select and copy manually.')
    }
  }

  if (loading) {
    return <div className="text-sm text-sage-500 p-6">Loading multi-channel settings...</div>
  }

  return (
    <div className="max-w-3xl space-y-8">
      <header className="flex items-center gap-3">
        <MessageSquare className="w-6 h-6 text-sage-600" />
        <div>
          <h1 className="text-2xl font-serif text-sage-900">Multi-channel inbox</h1>
          <p className="text-sm text-sage-600 mt-1">
            Receive SMS and Zoom meeting transcripts as touchpoints
            alongside email. Configure which phone numbers and Zoom
            accounts belong to your venue. Signals land in the Audio
            Inbox for triage.
          </p>
        </div>
      </header>

      {error && (
        <div className="border border-red-200 bg-red-50 text-red-700 text-sm rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {/* Master kill-switch */}
      <section className="border border-border rounded-lg bg-warm-white p-4 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium text-sage-800">Voice capture surface</h2>
            <p className="text-xs text-sage-500 mt-0.5">
              Master switch for the voice_capture inbox surface. When off,
              SMS and Zoom signals are still logged but won&apos;t appear
              in the Audio Inbox UI.
            </p>
          </div>
          <button
            type="button"
            onClick={() => handleToggle('voice_capture_enabled')}
            disabled={saving}
            className="shrink-0 text-sage-700 hover:text-sage-900"
            aria-pressed={settings.voice_capture_enabled}
          >
            {settings.voice_capture_enabled ? (
              <ToggleRight className="w-9 h-9" />
            ) : (
              <ToggleLeft className="w-9 h-9 text-sage-400" />
            )}
          </button>
        </div>
      </section>

      {/* SMS / Twilio */}
      <section className="border border-border rounded-lg bg-warm-white p-4 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <MessageSquare className="w-5 h-5 text-sage-600 mt-0.5" />
            <div>
              <h2 className="text-sm font-medium text-sage-800">SMS (Twilio)</h2>
              <p className="text-xs text-sage-500 mt-0.5">
                Forward inbound SMS at your Twilio numbers to the webhook
                below. We&apos;ll match the number to this venue and route
                the message into the Audio Inbox.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => handleToggle('sms_enabled')}
            disabled={saving}
            className="shrink-0 text-sage-700 hover:text-sage-900"
            aria-pressed={settings.sms_enabled}
          >
            {settings.sms_enabled ? (
              <ToggleRight className="w-9 h-9" />
            ) : (
              <ToggleLeft className="w-9 h-9 text-sage-400" />
            )}
          </button>
        </div>

        <div>
          <label className="block text-xs text-sage-600 mb-1">Venue phone numbers (E.164)</label>
          <div className="flex flex-col gap-2">
            {settings.twilio_phone_numbers.length === 0 ? (
              <p className="text-xs italic text-sage-500 border border-dashed border-border rounded-lg px-3 py-3">
                No phone numbers added. Add the E.164 format (e.g. +15551234567).
              </p>
            ) : (
              settings.twilio_phone_numbers.map((phone) => (
                <div
                  key={phone}
                  className="flex items-center justify-between gap-2 border border-sage-200 rounded-lg px-3 py-2 bg-sage-50/40"
                >
                  <code className="text-sm font-mono text-sage-900">{phone}</code>
                  <button
                    type="button"
                    onClick={() => handleRemovePhone(phone)}
                    disabled={saving}
                    className="text-sage-500 hover:text-red-600 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))
            )}
            <div className="flex gap-2">
              <input
                type="tel"
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleAddPhone()
                  }
                }}
                placeholder="+15551234567"
                disabled={saving}
                className="flex-1 border border-border rounded-lg px-3 py-2 bg-warm-white text-sage-900 text-sm focus:outline-none focus:ring-2 focus:ring-sage-300"
              />
              <button
                type="button"
                onClick={handleAddPhone}
                disabled={saving || !newPhone.trim()}
                className="inline-flex items-center gap-1.5 px-3 py-2 bg-sage-600 text-white rounded-lg text-sm font-medium hover:bg-sage-700 disabled:opacity-50 transition-colors"
              >
                <Plus className="w-4 h-4" />
                Add
              </button>
            </div>
          </div>
        </div>

        {twilioWebhookUrl && (
          <div className="border border-sage-200 rounded-lg bg-sage-50/40 p-3 space-y-1.5">
            <label className="block text-xs font-medium text-sage-700">Twilio webhook URL</label>
            <div className="flex gap-2">
              <code className="flex-1 min-w-0 text-xs font-mono bg-warm-white border border-sage-200 rounded px-3 py-1.5 truncate text-sage-900">
                {twilioWebhookUrl}
              </code>
              <button
                type="button"
                onClick={() => copyToClipboard(twilioWebhookUrl, 'twilio')}
                className="inline-flex items-center gap-1 px-2 py-1.5 text-xs border border-sage-300 text-sage-700 rounded hover:bg-sage-50 transition-colors"
              >
                {copied === 'twilio' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied === 'twilio' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="text-[11px] text-sage-600">
              In Twilio, set the &quot;A MESSAGE COMES IN&quot; webhook on each phone
              number to this URL. Requires TWILIO_AUTH_TOKEN env var on the server.
            </p>
          </div>
        )}
      </section>

      {/* Zoom */}
      <section className="border border-border rounded-lg bg-warm-white p-4 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <Video className="w-5 h-5 text-sage-600 mt-0.5" />
            <div>
              <h2 className="text-sm font-medium text-sage-800">Zoom meetings</h2>
              <p className="text-xs text-sage-500 mt-0.5">
                Ingest Zoom meeting transcripts as tour touchpoints. List
                the host email addresses whose meetings belong to this
                venue. We&apos;ll match the transcript to the nearest
                scheduled tour for that wedding.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => handleToggle('zoom_enabled')}
            disabled={saving}
            className="shrink-0 text-sage-700 hover:text-sage-900"
            aria-pressed={settings.zoom_enabled}
          >
            {settings.zoom_enabled ? (
              <ToggleRight className="w-9 h-9" />
            ) : (
              <ToggleLeft className="w-9 h-9 text-sage-400" />
            )}
          </button>
        </div>

        <div>
          <label className="block text-xs text-sage-600 mb-1">Zoom host emails</label>
          <div className="flex flex-col gap-2">
            {settings.zoom_account_emails.length === 0 ? (
              <p className="text-xs italic text-sage-500 border border-dashed border-border rounded-lg px-3 py-3">
                No host emails added. Add the email each coordinator uses on Zoom.
              </p>
            ) : (
              settings.zoom_account_emails.map((email) => (
                <div
                  key={email}
                  className="flex items-center justify-between gap-2 border border-sage-200 rounded-lg px-3 py-2 bg-sage-50/40"
                >
                  <code className="text-sm font-mono text-sage-900">{email}</code>
                  <button
                    type="button"
                    onClick={() => handleRemoveEmail(email)}
                    disabled={saving}
                    className="text-sage-500 hover:text-red-600 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))
            )}
            <div className="flex gap-2">
              <input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleAddEmail()
                  }
                }}
                placeholder="coordinator@yourvenue.com"
                disabled={saving}
                className="flex-1 border border-border rounded-lg px-3 py-2 bg-warm-white text-sage-900 text-sm focus:outline-none focus:ring-2 focus:ring-sage-300"
              />
              <button
                type="button"
                onClick={handleAddEmail}
                disabled={saving || !newEmail.trim()}
                className="inline-flex items-center gap-1.5 px-3 py-2 bg-sage-600 text-white rounded-lg text-sm font-medium hover:bg-sage-700 disabled:opacity-50 transition-colors"
              >
                <Plus className="w-4 h-4" />
                Add
              </button>
            </div>
          </div>
        </div>

        {zoomWebhookUrl && (
          <div className="border border-sage-200 rounded-lg bg-sage-50/40 p-3 space-y-1.5">
            <label className="block text-xs font-medium text-sage-700">Zoom webhook URL</label>
            <div className="flex gap-2">
              <code className="flex-1 min-w-0 text-xs font-mono bg-warm-white border border-sage-200 rounded px-3 py-1.5 truncate text-sage-900">
                {zoomWebhookUrl}
              </code>
              <button
                type="button"
                onClick={() => copyToClipboard(zoomWebhookUrl, 'zoom')}
                className="inline-flex items-center gap-1 px-2 py-1.5 text-xs border border-sage-300 text-sage-700 rounded hover:bg-sage-50 transition-colors"
              >
                {copied === 'zoom' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied === 'zoom' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="text-[11px] text-sage-600">
              In your Zoom App Marketplace app, add the Event Subscriptions
              `meeting.ended` and `recording.transcript_completed` and point
              them at this URL. Requires ZOOM_WEBHOOK_SECRET env var on the server.
            </p>
          </div>
        )}
      </section>

      <section className="border border-amber-200 rounded-lg bg-amber-50 p-3 text-xs text-amber-800 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
        <div>
          Webhooks return <code className="bg-amber-100 px-1 rounded">503</code> until
          the matching environment variables are configured on the server.
          The settings above can be filled in ahead of credential provisioning;
          the channels go live the moment the env vars land.
        </div>
      </section>
    </div>
  )
}
