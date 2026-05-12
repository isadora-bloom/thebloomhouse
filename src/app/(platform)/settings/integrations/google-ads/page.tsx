'use client'

/**
 * /settings/integrations/google-ads
 *
 * Wave 6E follow-up. Surfaces the Google Ads OAuth flow + setup
 * instructions. The page is the only on-product face of the
 * connector; the actual tokens never come near the client.
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

interface GoogleAdsConnection {
  id: string
  status: 'pending' | 'connected' | 'error' | 'revoked'
  statusReason: string | null
  customerId: string | null
  customerName: string | null
  connectedAt: string | null
  lastUsedAt: string | null
  lastErrorAt: string | null
  lastErrorMessage: string | null
}

interface ConfigState {
  configured: boolean
  missing: string[]
  connection: GoogleAdsConnection | null
}

export default function GoogleAdsIntegrationPage() {
  const sp = useSearchParams()
  const [state, setState] = useState<ConfigState | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await fetch('/api/integrations/google-ads/status')
      if (!resp.ok) {
        setState({ configured: false, missing: [], connection: null })
        return
      }
      const j = (await resp.json()) as ConfigState
      setState(j)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const connect = () => {
    window.location.href = '/api/integrations/google-ads/oauth/start'
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

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="font-serif text-2xl text-[var(--bh-ink)]">
          Google Ads integration
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--bh-muted)]">
          Connect your Google Ads account so Bloom can lift the real
          keyword and match-type behind every gclid captured by the site
          pixel. This is what makes the TBH Report&apos;s &quot;brand search vs
          non-brand&quot; split definitive instead of approximate.
        </p>
      </header>

      {okFromCallback ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 flex items-start gap-2">
          <CheckCircle2 className="h-4 w-4 mt-0.5" />
          OAuth completed. Token exchange succeeded.
        </div>
      ) : null}
      {errFromCallback ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5" />
          OAuth error: <code>{errFromCallback}</code>
        </div>
      ) : null}

      {!state.configured ? (
        <section className="rounded-2xl border border-amber-200 bg-amber-50/50 p-5 shadow-sm">
          <h2 className="font-serif text-lg flex items-center gap-2">
            <Settings className="h-4 w-4 text-amber-700" /> Setup not complete
          </h2>
          <p className="mt-2 text-sm text-amber-900">
            Google Ads OAuth needs four environment variables set in
            Vercel before connections are possible.
          </p>
          {state.missing.length > 0 ? (
            <div className="mt-3">
              <div className="text-xs uppercase tracking-wide text-amber-800">
                Missing
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
                Create or open a Google Cloud project. Enable the Google
                Ads API (APIs & Services → Library → search &quot;Google
                Ads API&quot;).
              </li>
              <li>
                APIs & Services → Credentials → Create credentials → OAuth
                client ID → Web application. Authorized redirect URI:{' '}
                <code>
                  {typeof window !== 'undefined' ? window.location.origin : 'https://YOUR_BLOOM_DOMAIN'}
                  /api/integrations/google-ads/oauth/callback
                </code>
              </li>
              <li>
                Apply for a Google Ads developer token (Google Ads UI →
                Tools & Settings → API Center). Basic tier is enough for
                read-only access; approval usually within a few hours.
              </li>
              <li>
                In Vercel project settings → Environment Variables, add:
                <ul className="mt-1 list-disc pl-5">
                  <li>
                    <code>GOOGLE_ADS_CLIENT_ID</code> — from step 2
                  </li>
                  <li>
                    <code>GOOGLE_ADS_CLIENT_SECRET</code> — from step 2
                  </li>
                  <li>
                    <code>GOOGLE_ADS_DEVELOPER_TOKEN</code> — from step 3
                  </li>
                  <li>
                    <code>GOOGLE_ADS_OAUTH_REDIRECT_URI</code> — full https
                    URL ending in <code>/api/integrations/google-ads/oauth/callback</code>
                  </li>
                </ul>
              </li>
              <li>
                Redeploy. This page will then show a &quot;Connect&quot; button.
              </li>
            </ol>
          </details>
          <p className="mt-3 text-xs text-amber-900">
            <ExternalLink className="inline h-3 w-3" />{' '}
            <a
              href="https://developers.google.com/google-ads/api/docs/oauth/overview"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              Google&apos;s OAuth docs
            </a>
            {' · '}
            <a
              href="https://developers.google.com/google-ads/api/docs/get-started/dev-token"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              Developer token application
            </a>
          </p>
        </section>
      ) : (
        <section className="rounded-2xl border border-[var(--bh-line)] bg-white p-5 shadow-sm">
          <h2 className="font-serif text-lg flex items-center gap-2">
            <PlugZap className="h-4 w-4" /> Connection status
          </h2>
          {state.connection?.status === 'connected' ? (
            <div className="mt-3 space-y-2">
              <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs text-emerald-800">
                <CheckCircle2 className="h-3 w-3" /> Connected
              </div>
              {state.connection.customerId ? (
                <p className="text-sm">
                  Customer:{' '}
                  <span className="font-mono">
                    {state.connection.customerId}
                  </span>
                  {state.connection.customerName
                    ? ` (${state.connection.customerName})`
                    : null}
                </p>
              ) : (
                <p className="text-xs text-[var(--bh-muted)]">
                  Customer not yet selected — pick the Google Ads account
                  this venue wants Bloom to read from. (Picker coming
                  next.)
                </p>
              )}
              {state.connection.connectedAt ? (
                <p className="text-xs text-[var(--bh-muted)]">
                  Connected{' '}
                  {new Date(state.connection.connectedAt).toLocaleString()}
                </p>
              ) : null}
              <button
                type="button"
                onClick={connect}
                className="mt-2 inline-flex items-center gap-1 rounded-md border border-[var(--bh-line)] bg-white px-3 py-1.5 text-xs hover:bg-[var(--bh-sage-50)]"
              >
                Re-authorize
              </button>
            </div>
          ) : state.connection?.status === 'error' ? (
            <div className="mt-3 space-y-2">
              <div className="inline-flex items-center gap-2 rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-xs text-rose-800">
                <AlertTriangle className="h-3 w-3" /> Error
              </div>
              {state.connection.lastErrorMessage ? (
                <p className="text-xs text-rose-700">
                  {state.connection.lastErrorMessage}
                </p>
              ) : null}
              <button
                type="button"
                onClick={connect}
                className="inline-flex items-center gap-1 rounded-md bg-[var(--bh-sage-700)] px-3 py-1.5 text-xs text-white hover:opacity-90"
              >
                Re-authorize
              </button>
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              <p className="text-sm text-[var(--bh-muted)]">
                Not connected yet. Click below to begin the OAuth flow.
                You&apos;ll be sent to Google to grant Bloom read-only access
                to your Google Ads account.
              </p>
              <button
                type="button"
                onClick={connect}
                className="inline-flex items-center gap-2 rounded-md bg-[var(--bh-sage-700)] px-4 py-2 text-sm text-white hover:opacity-90"
              >
                <PlugZap className="h-4 w-4" /> Connect Google Ads
              </button>
            </div>
          )}
        </section>
      )}

      {/* What we'll pull once connected */}
      <section className="rounded-2xl border border-[var(--bh-line)] bg-white p-5 shadow-sm">
        <h2 className="font-serif text-lg">What this unlocks</h2>
        <ul className="mt-3 space-y-2 text-sm">
          <li>
            <strong>Real keyword + match-type per gclid.</strong> Every
            ad-click captured by the site pixel becomes a precise
            attribution — "this lead came from the keyword
            &lsquo;rixey manor wedding venue&rsquo; on a broad-match
            campaign", not just "Google Ads".
          </li>
          <li>
            <strong>Brand-search vs non-brand split.</strong> Without
            this, Bloom can&apos;t tell apart someone who searched your
            venue by name (not really acquisition) from someone the
            agency&apos;s broad-match campaign reached (real acquisition).
            The TBH Report flips the moment this lands.
          </li>
          <li>
            <strong>Daily campaign + ad-group spend</strong> directly
            from the source instead of waiting for the agency&apos;s
            month-end PDF.
          </li>
        </ul>
      </section>
    </div>
  )
}
