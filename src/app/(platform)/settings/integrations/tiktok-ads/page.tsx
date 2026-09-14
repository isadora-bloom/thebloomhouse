'use client'

/**
 * /settings/integrations/tiktok-ads
 *
 * The only on-product face of the TikTok Ads connector. Same shape as
 * the Meta page: credentials, connection, which advertiser account the
 * daily read points at, and when it last ran. Tokens never come near
 * this page; everything is served by /api/integrations/tiktok-ads/status,
 * which names its columns and omits the token ones.
 */

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  PlugZap,
  Settings,
} from 'lucide-react'

interface Connection {
  id: string
  advertiser_id: string | null
  advertiser_name: string | null
  currency: string | null
  status: 'pending' | 'connected' | 'error' | 'revoked'
  status_reason: string | null
  connected_at: string | null
  last_synced_at: string | null
  last_error_at: string | null
  last_error_message: string | null
}

interface StatusPayload {
  configured: boolean
  missing: string[]
  connectorStatus: 'connected' | 'manual'
  connection: Connection | null
}

export default function TikTokAdsIntegrationPage() {
  const sp = useSearchParams()
  const [state, setState] = useState<StatusPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [advertiserInput, setAdvertiserInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await fetch('/api/integrations/tiktok-ads/status')
      if (!resp.ok) {
        setState({
          configured: false,
          missing: [],
          connectorStatus: 'manual',
          connection: null,
        })
        return
      }
      const j = (await resp.json()) as StatusPayload
      setState(j)
      setAdvertiserInput(j.connection?.advertiser_id ?? '')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const connect = () => {
    window.location.href = '/api/integrations/tiktok-ads/oauth/start'
  }

  const saveAdvertiser = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const resp = await fetch('/api/integrations/tiktok-ads/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ advertiserId: advertiserInput }),
      })
      if (!resp.ok) {
        const j = (await resp.json().catch(() => null)) as { error?: string } | null
        setSaveError(j?.error ?? 'That advertiser account could not be saved.')
        return
      }
      await load()
    } finally {
      setSaving(false)
    }
  }

  if (loading || !state) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-[var(--bh-muted)]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
      </div>
    )
  }

  const okFromCallback = sp.get('ok') === '1'
  const errFromCallback = sp.get('error')
  const connection = state.connection

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="font-serif text-2xl text-[var(--bh-ink)]">
          TikTok Ads
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--bh-muted)]">
          Connect your TikTok advertiser account and Bloom reads the daily
          spend, impressions, clicks and conversions for each campaign
          straight from TikTok. Until you do, those numbers are whatever
          somebody typed in, and the reallocation page says so.
        </p>
      </header>

      {okFromCallback ? (
        <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          <CheckCircle2 className="mt-0.5 h-4 w-4" />
          Connected. Spend will start arriving on the next daily run.
        </div>
      ) : null}
      {errFromCallback ? (
        <div className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          TikTok sent us back with: <code>{errFromCallback}</code>
        </div>
      ) : null}

      {!state.configured ? (
        <section className="rounded-2xl border border-amber-200 bg-amber-50/50 p-5 shadow-sm">
          <h2 className="flex items-center gap-2 font-serif text-lg">
            <Settings className="h-4 w-4 text-amber-700" /> Setup not complete
          </h2>
          <p className="mt-2 text-sm text-amber-900">
            TikTok Ads needs three settings in place before any venue can
            connect. This is a one-time job on our side, not yours.
          </p>
          {state.missing.length > 0 ? (
            <div className="mt-3">
              <div className="text-xs uppercase tracking-wide text-amber-800">
                Still missing
              </div>
              <ul className="mt-1 list-disc pl-5 text-xs text-amber-900">
                {state.missing.map((m) => (
                  <li key={m}>
                    <code>{m}</code>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <details className="mt-4 text-sm text-amber-900">
            <summary className="cursor-pointer font-medium">
              Setup steps (one-time)
            </summary>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-xs">
              <li>
                Create an app in the TikTok for Business developer portal
                and enable the Reporting scope on it.
              </li>
              <li>
                Add this address as the redirect:{' '}
                <code>
                  {typeof window !== 'undefined'
                    ? window.location.origin
                    : 'https://YOUR_BLOOM_DOMAIN'}
                  /api/integrations/tiktok-ads/oauth/callback
                </code>
              </li>
              <li>
                Set <code>TIKTOK_ADS_APP_ID</code>,{' '}
                <code>TIKTOK_ADS_APP_SECRET</code> and{' '}
                <code>TIKTOK_ADS_OAUTH_REDIRECT_URI</code> in the hosting
                settings, then redeploy.
              </li>
            </ol>
          </details>
          <p className="mt-3 text-xs text-amber-900">
            <ExternalLink className="inline h-3 w-3" />{' '}
            <a
              href="https://business-api.tiktok.com/portal/docs"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              TikTok&apos;s reporting docs
            </a>
          </p>
        </section>
      ) : (
        <section className="rounded-2xl border border-[var(--bh-line)] bg-white p-5 shadow-sm">
          <h2 className="flex items-center gap-2 font-serif text-lg">
            <PlugZap className="h-4 w-4" /> Connection
          </h2>

          {state.connectorStatus === 'connected' ? (
            <div className="mt-3 space-y-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs text-emerald-800">
                <CheckCircle2 className="h-3 w-3" /> Connected
              </div>
              {connection?.advertiser_id ? (
                <p className="text-sm">
                  Reading advertiser{' '}
                  <span className="font-mono">{connection.advertiser_id}</span>
                  {connection.advertiser_name
                    ? ` (${connection.advertiser_name})`
                    : null}
                  {connection.currency ? ` · ${connection.currency}` : null}
                </p>
              ) : (
                <p className="text-sm text-amber-800">
                  Connected, but no advertiser account has been chosen yet,
                  so nothing is being read. Enter the id below.
                </p>
              )}
              {connection?.last_synced_at ? (
                <p className="text-xs text-[var(--bh-muted)]">
                  Last sync{' '}
                  {new Date(connection.last_synced_at).toLocaleString()}
                </p>
              ) : (
                <p className="text-xs text-[var(--bh-muted)]">
                  No sync has run yet. The first one happens on the next
                  daily pass.
                </p>
              )}

              <div className="flex flex-wrap items-end gap-2 pt-2">
                <label className="text-xs text-[var(--bh-muted)]">
                  Advertiser id
                  <input
                    value={advertiserInput}
                    onChange={(e) => setAdvertiserInput(e.target.value)}
                    placeholder="7012345678901234567"
                    className="mt-1 block w-64 rounded-md border border-[var(--bh-line)] px-2 py-1.5 font-mono text-sm"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => void saveAdvertiser()}
                  disabled={saving}
                  className="rounded-md bg-[var(--bh-sage-700)] px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save account'}
                </button>
                <button
                  type="button"
                  onClick={connect}
                  className="rounded-md border border-[var(--bh-line)] bg-white px-3 py-1.5 text-xs hover:bg-[var(--bh-sage-50)]"
                >
                  Reconnect
                </button>
              </div>
              {saveError ? (
                <p className="text-xs text-rose-700">{saveError}</p>
              ) : null}
            </div>
          ) : connection?.status === 'error' ? (
            <div className="mt-3 space-y-2">
              <div className="inline-flex items-center gap-2 rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-xs text-rose-800">
                <AlertTriangle className="h-3 w-3" /> Needs reconnecting
              </div>
              {connection.last_error_message ? (
                <p className="text-xs text-rose-700">
                  {connection.last_error_message}
                </p>
              ) : null}
              <button
                type="button"
                onClick={connect}
                className="rounded-md bg-[var(--bh-sage-700)] px-3 py-1.5 text-xs text-white hover:opacity-90"
              >
                Reconnect
              </button>
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              <p className="text-sm text-[var(--bh-muted)]">
                Not connected. TikTok will ask you to grant read access to
                your advertiser account. Bloom cannot change a campaign,
                set a budget or spend anything; it only reads what already
                happened.
              </p>
              <button
                type="button"
                onClick={connect}
                className="inline-flex items-center gap-2 rounded-md bg-[var(--bh-sage-700)] px-4 py-2 text-sm text-white hover:opacity-90"
              >
                <PlugZap className="h-4 w-4" /> Connect TikTok Ads
              </button>
            </div>
          )}
        </section>
      )}

      <section className="rounded-2xl border border-[var(--bh-line)] bg-white p-5 shadow-sm">
        <h2 className="font-serif text-lg">What arrives once it is on</h2>
        <ul className="mt-3 space-y-2 text-sm">
          <li>
            <strong>Spend per campaign per day.</strong> The figure TikTok
            has, on the day it happened.
          </li>
          <li>
            <strong>Impressions, clicks and conversions</strong> alongside
            it, so cost per enquiry is computed from the platform&apos;s own
            numbers.
          </li>
          <li>
            <strong>The right currency.</strong> TikTok reports spend as a
            bare number with no currency on it, so we take that from your
            advertiser account rather than assuming dollars.
          </li>
        </ul>
      </section>
    </div>
  )
}
