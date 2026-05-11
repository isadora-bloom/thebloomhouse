'use client'

/**
 * Settings → Integrations → Twilio  (Stream 8)
 *
 * Twilio-specific config page split out of the old /settings/multi-channel
 * surface. Backed by multi_channel_inbox_settings (mig 295). Captures:
 *   - sms_enabled                    on/off
 *   - twilio_phone_numbers[]         E.164 numbers we listen on
 *   - voice_capture_enabled          shared kill-switch for the
 *                                    voice_capture inbox surface (left
 *                                    here because Twilio inbound lands
 *                                    in that inbox; toggling it off
 *                                    silences the UI but keeps the rows)
 *
 * Webhook URL is rendered at the bottom for copy/paste into the Twilio
 * Console. Handler at /api/webhooks/twilio refuses traffic with 503
 * until TWILIO_AUTH_TOKEN is set, so this page is safe to fill in
 * ahead of credential provisioning.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { useScope } from '@/lib/hooks/use-scope'
import { createClient } from '@/lib/supabase/client'
import {
  MessageSquareText,
  Plus,
  Trash2,
  Copy,
  Check,
  AlertTriangle,
  ArrowLeft,
  ToggleRight,
  ToggleLeft,
} from 'lucide-react'

interface TwilioSettings {
  sms_enabled: boolean
  twilio_phone_numbers: string[]
  voice_capture_enabled: boolean
}

const DEFAULT_SETTINGS: TwilioSettings = {
  sms_enabled: false,
  twilio_phone_numbers: [],
  voice_capture_enabled: true,
}

export default function TwilioSettingsPage() {
  const { venueId } = useScope()
  const [settings, setSettings] = useState<TwilioSettings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newPhone, setNewPhone] = useState('')
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    if (!venueId) return
    setLoading(true)
    setError(null)
    try {
      const supabase = createClient()
      const { data, error: err } = await supabase
        .from('multi_channel_inbox_settings')
        .select('sms_enabled, twilio_phone_numbers, voice_capture_enabled')
        .eq('venue_id', venueId)
        .maybeSingle()
      if (err) throw err
      if (data) {
        setSettings({
          sms_enabled: Boolean(data.sms_enabled),
          twilio_phone_numbers: (data.twilio_phone_numbers as string[] | null) ?? [],
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
    void load()
  }, [load])

  const save = useCallback(
    async (next: TwilioSettings) => {
      if (!venueId) return
      setSaving(true)
      setError(null)
      try {
        const supabase = createClient()
        // Upsert preserves Zoom-side fields on multi_channel_inbox_settings —
        // we only touch the columns we own from this page.
        const { error: err } = await supabase
          .from('multi_channel_inbox_settings')
          .upsert(
            {
              venue_id: venueId,
              sms_enabled: next.sms_enabled,
              twilio_phone_numbers: next.twilio_phone_numbers,
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

  function toggleSms() {
    void save({ ...settings, sms_enabled: !settings.sms_enabled })
  }

  function toggleVoiceCapture() {
    void save({ ...settings, voice_capture_enabled: !settings.voice_capture_enabled })
  }

  function addPhone() {
    const value = newPhone.trim()
    if (!value) return
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
    setNewPhone('')
    void save({
      ...settings,
      twilio_phone_numbers: [...settings.twilio_phone_numbers, normalised],
    })
  }

  function removePhone(phone: string) {
    void save({
      ...settings,
      twilio_phone_numbers: settings.twilio_phone_numbers.filter((p) => p !== phone),
    })
  }

  const webhookUrl = useMemo(() => {
    if (typeof window === 'undefined') return ''
    return `${window.location.origin}/api/webhooks/twilio`
  }, [])

  async function copyWebhook() {
    try {
      await navigator.clipboard.writeText(webhookUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setError('Clipboard unavailable. Select and copy manually.')
    }
  }

  if (loading) {
    return <div className="text-sm text-sage-500 p-6">Loading Twilio settings...</div>
  }

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <Link
          href="/settings/integrations"
          className="inline-flex items-center gap-1 text-xs text-sage-600 hover:text-sage-900"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to Integrations
        </Link>
      </div>

      <header className="flex items-start gap-3">
        <MessageSquareText className="w-6 h-6 text-sage-600 mt-1" />
        <div>
          <h1 className="text-2xl font-serif text-sage-900">Twilio</h1>
          <p className="text-sm text-sage-600 mt-1">
            Forward inbound SMS at your Twilio numbers to the webhook below.
            Each message is matched to its venue and lands on the lead
            timeline alongside email.
          </p>
        </div>
      </header>

      {error && (
        <div className="border border-red-200 bg-red-50 text-red-700 text-sm rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      <section className="border border-border rounded-lg bg-warm-white p-4 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium text-sage-800">SMS ingest</h2>
            <p className="text-xs text-sage-500 mt-0.5">
              Master switch for Twilio inbound SMS on this venue.
            </p>
          </div>
          <button
            type="button"
            onClick={toggleSms}
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
                    onClick={() => removePhone(phone)}
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
                    addPhone()
                  }
                }}
                placeholder="+15551234567"
                disabled={saving}
                className="flex-1 border border-border rounded-lg px-3 py-2 bg-warm-white text-sage-900 text-sm focus:outline-none focus:ring-2 focus:ring-sage-300"
              />
              <button
                type="button"
                onClick={addPhone}
                disabled={saving || !newPhone.trim()}
                className="inline-flex items-center gap-1.5 px-3 py-2 bg-sage-600 text-white rounded-lg text-sm font-medium hover:bg-sage-700 disabled:opacity-50 transition-colors"
              >
                <Plus className="w-4 h-4" />
                Add
              </button>
            </div>
          </div>
        </div>

        {webhookUrl && (
          <div className="border border-sage-200 rounded-lg bg-sage-50/40 p-3 space-y-1.5">
            <label className="block text-xs font-medium text-sage-700">Twilio webhook URL</label>
            <div className="flex gap-2">
              <code className="flex-1 min-w-0 text-xs font-mono bg-warm-white border border-sage-200 rounded px-3 py-1.5 truncate text-sage-900">
                {webhookUrl}
              </code>
              <button
                type="button"
                onClick={copyWebhook}
                className="inline-flex items-center gap-1 px-2 py-1.5 text-xs border border-sage-300 text-sage-700 rounded hover:bg-sage-50 transition-colors"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="text-[11px] text-sage-600">
              In Twilio, set the &quot;A MESSAGE COMES IN&quot; webhook on each phone
              number to this URL. Requires TWILIO_AUTH_TOKEN on the server.
            </p>
          </div>
        )}
      </section>

      <section className="border border-border rounded-lg bg-warm-white p-4 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium text-sage-800">Voice capture inbox</h2>
            <p className="text-xs text-sage-500 mt-0.5">
              Surface Twilio messages alongside other audio touchpoints in
              the Voice Capture inbox. Off keeps the data flowing into the
              forensic record but hides the inbox UI.
            </p>
          </div>
          <button
            type="button"
            onClick={toggleVoiceCapture}
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

      <section className="border border-amber-200 rounded-lg bg-amber-50 p-3 text-xs text-amber-800 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
        <div>
          The webhook returns <code className="bg-amber-100 px-1 rounded">503</code> until
          TWILIO_AUTH_TOKEN is configured on the server. Configure your numbers
          and toggles here in advance; the channel goes live the moment the
          env var lands.
        </div>
      </section>
    </div>
  )
}
