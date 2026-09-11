'use client'

/**
 * Settings → Integrations → Instagram DMs
 *
 * Wave 3, W28. The only on-product face of the Meta Messaging
 * connection. Tokens never come near this page: everything it shows
 * comes from /api/integrations/instagram/status, which returns a safe
 * projection and a `hasToken` boolean.
 *
 * Three states, and it renders all three honestly:
 *   - server not configured  → the missing env vars, by name, plus the
 *                              one-time Meta app setup steps
 *   - configured, not linked → Connect
 *   - linked                 → account, status, last event, Disconnect
 *
 * Nothing here crashes when Meta credentials are absent. That is the
 * point: the page is usable the day before the app is approved, so the
 * operator can read the setup steps and copy the webhook URL in advance.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Copy,
  MessageSquareText,
  Loader2,
  Settings,
} from 'lucide-react'

interface InstagramConnection {
  id: string
  igBusinessId: string | null
  igUsername: string | null
  pageId: string | null
  pageName: string | null
  pageTokenEnvKey: string | null
  hasToken: boolean
  status: 'pending' | 'connected' | 'error' | 'revoked'
  statusReason: string | null
  connectedAt: string | null
  lastEventAt: string | null
  lastErrorAt: string | null
  lastErrorMessage: string | null
}

interface StatusPayload {
  configured: boolean
  missing: string[]
  connection: InstagramConnection | null
  setup: {
    webhookUrl: string
    redirectUri: string
    scopes: string[]
    webhookFields: string[]
  }
}

function formatWhen(iso: string | null): string {
  if (!iso) return 'never'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return 'never'
  const minutes = Math.round((Date.now() - t) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-sage-700">{label}</label>
      <div className="flex gap-2">
        <code className="flex-1 min-w-0 truncate rounded border border-sage-200 bg-warm-white px-3 py-1.5 font-mono text-xs text-sage-900">
          {value}
        </code>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value)
              setCopied(true)
              setTimeout(() => setCopied(false), 1800)
            } catch {
              // Clipboard blocked. The value is on screen and selectable,
              // so there is nothing to recover from.
            }
          }}
          className="inline-flex items-center gap-1 rounded border border-sage-300 px-2 py-1.5 text-xs text-sage-700 transition-colors hover:bg-sage-50"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}

export default function InstagramIntegrationPage() {
  const sp = useSearchParams()
  const [state, setState] = useState<StatusPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await fetch('/api/integrations/instagram/status')
      if (!resp.ok) {
        setError('Could not load the Instagram connection.')
        return
      }
      setState((await resp.json()) as StatusPayload)
    } catch {
      setError('Could not load the Instagram connection.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function disconnect() {
    setBusy(true)
    setError(null)
    try {
      const resp = await fetch('/api/integrations/instagram/disconnect', {
        method: 'POST',
      })
      if (!resp.ok) {
        setError('Disconnect failed. Try again, or check the server logs.')
        return
      }
      await load()
    } finally {
      setBusy(false)
    }
  }

  if (loading || !state) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-sage-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
      </div>
    )
  }

  const okFromCallback = sp.get('ok') === '1'
  const warnFromCallback = sp.get('warn')
  const errFromCallback = sp.get('error')
  const conn = state.connection
  const linked = conn?.status === 'connected'

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <Link
          href="/settings/integrations"
          className="inline-flex items-center gap-1 text-xs text-sage-600 hover:text-sage-900"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Integrations
        </Link>
      </div>

      <header className="flex items-start gap-3">
        <MessageSquareText className="mt-1 h-6 w-6 text-sage-600" />
        <div>
          <h1 className="font-serif text-2xl text-sage-900">Instagram DMs</h1>
          <p className="mt-1 max-w-2xl text-sm text-sage-600">
            Most couples say something on Instagram before they say anything
            anywhere else. Connect the venue account and every direct message
            arrives with the sender&apos;s handle attached, so the first DM sits
            on the same record as the tour, the contract and the review.
          </p>
        </div>
      </header>

      {okFromCallback && (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          Connected. Meta will start delivering messages to the webhook.
        </div>
      )}
      {warnFromCallback === 'subscribe_failed' && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          Connected, but Bloom could not subscribe the Page to the{' '}
          <code className="rounded bg-amber-100 px-1">messages</code> field.
          Tick it yourself in the Meta app dashboard under Webhooks.
        </div>
      )}
      {errFromCallback && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Connection failed: <code>{errFromCallback}</code>
            {conn?.statusReason ? <span className="block mt-1">{conn.statusReason}</span> : null}
          </span>
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          {error}
        </div>
      )}

      {/* ---- Not configured ---- */}
      {!state.configured && (
        <section className="space-y-4 rounded-lg border border-amber-200 bg-amber-50/60 p-5">
          <h2 className="flex items-center gap-2 font-serif text-lg text-amber-900">
            <Settings className="h-4 w-4 text-amber-700" /> Not configured yet
          </h2>
          <p className="text-sm text-amber-900">
            Instagram DMs need three environment variables on the server before
            any venue can connect. Until they are set, the webhook answers
            503 and this page stays read-only. Nothing breaks; nothing arrives.
          </p>
          <div>
            <div className="text-xs uppercase tracking-wide text-amber-800">Missing</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-amber-900">
              {state.missing.map((m) => (
                <li key={m}>
                  <code>{m}</code>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-xs text-amber-900">
            <code>INSTAGRAM_APP_ID</code> and <code>INSTAGRAM_APP_SECRET</code>{' '}
            come from the Meta app.{' '}
            <code>INSTAGRAM_VERIFY_TOKEN</code> is a string you invent; you paste
            the same value into the Meta webhook form and into Vercel.
          </p>
        </section>
      )}

      {/* ---- Connection ---- */}
      <section className="space-y-4 rounded-lg border border-border bg-warm-white p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium text-sage-800">Connection</h2>
            <p className="mt-0.5 text-xs text-sage-500">
              One Instagram professional account per venue.
            </p>
          </div>
          {linked ? (
            <button
              type="button"
              onClick={() => void disconnect()}
              disabled={busy}
              className="shrink-0 rounded-lg border border-sage-300 px-3 py-2 text-sm font-medium text-sage-700 transition-colors hover:bg-sage-50 disabled:opacity-50"
            >
              Disconnect
            </button>
          ) : (
            <button
              type="button"
              disabled={!state.configured || busy}
              onClick={() => {
                window.location.href = '/api/integrations/instagram/oauth/start'
              }}
              className="shrink-0 rounded-lg bg-sage-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-sage-700 disabled:opacity-50"
              title={
                state.configured
                  ? undefined
                  : 'Set the three environment variables first'
              }
            >
              Connect Instagram
            </button>
          )}
        </div>

        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-sage-500">Account</dt>
            <dd className="text-sage-900">
              {conn?.igUsername ? `@${conn.igUsername}` : 'Not linked'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-sage-500">Facebook Page</dt>
            <dd className="text-sage-900">{conn?.pageName ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-sage-500">Status</dt>
            <dd className="text-sage-900">{conn?.status ?? 'not connected'}</dd>
          </div>
          <div>
            <dt className="text-xs text-sage-500">Last event</dt>
            <dd className="text-sage-900">{formatWhen(conn?.lastEventAt ?? null)}</dd>
          </div>
          <div>
            <dt className="text-xs text-sage-500">Page token</dt>
            <dd className="text-sage-900">
              {conn?.hasToken
                ? conn.pageTokenEnvKey
                  ? `from ${conn.pageTokenEnvKey}`
                  : 'stored'
                : 'none'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-sage-500">Connected</dt>
            <dd className="text-sage-900">{formatWhen(conn?.connectedAt ?? null)}</dd>
          </div>
        </dl>

        {conn?.statusReason && conn.status !== 'connected' && (
          <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {conn.statusReason}
          </p>
        )}

        {linked && (
          <p className="text-xs text-sage-500">
            Disconnecting stops ingestion and drops the stored token. It does not
            revoke the grant on Meta&apos;s side; remove Bloom under Business
            Settings, Apps to do that.
          </p>
        )}
      </section>

      {/* ---- Meta app setup ---- */}
      <section className="space-y-4 rounded-lg border border-border bg-warm-white p-4">
        <div>
          <h2 className="text-sm font-medium text-sage-800">Meta app setup</h2>
          <p className="mt-0.5 text-xs text-sage-500">
            One time, by whoever owns the Meta developer account.
          </p>
        </div>

        <CopyRow label="Webhook callback URL" value={state.setup.webhookUrl} />
        <CopyRow label="OAuth redirect URI" value={state.setup.redirectUri} />

        <ol className="list-decimal space-y-2 pl-5 text-xs text-sage-700">
          <li>
            At developers.facebook.com, create an app of type{' '}
            <strong>Business</strong>, then add the{' '}
            <strong>Instagram</strong> and <strong>Webhooks</strong> products.
          </li>
          <li>
            The Instagram account must be a <strong>professional</strong>{' '}
            account (Business or Creator) and must be linked to a Facebook Page.
            A personal account cannot receive messages through the API.
          </li>
          <li>
            Facebook Login for Business → Valid OAuth redirect URIs: paste the
            redirect URI above.
          </li>
          <li>
            Webhooks → Instagram → Subscribe. Callback URL: the webhook URL
            above. Verify token: the same string you set as{' '}
            <code>INSTAGRAM_VERIFY_TOKEN</code>. Subscribe to the fields{' '}
            {state.setup.webhookFields.map((f) => (
              <code key={f} className="mx-0.5 rounded bg-sage-50 px-1">
                {f}
              </code>
            ))}
            .
          </li>
          <li>
            Request these permissions in App Review:{' '}
            {state.setup.scopes.map((s) => (
              <code key={s} className="mx-0.5 rounded bg-sage-50 px-1">
                {s}
              </code>
            ))}
            . In development mode they work for anyone with a role on the app,
            which is enough to test before review.
          </li>
          <li>
            Set <code>INSTAGRAM_APP_ID</code>,{' '}
            <code>INSTAGRAM_APP_SECRET</code> and{' '}
            <code>INSTAGRAM_VERIFY_TOKEN</code> in Vercel, redeploy, then press
            Connect above.
          </li>
        </ol>
      </section>

      <section className="flex items-start gap-2 rounded-lg border border-sage-200 bg-sage-50/40 p-3 text-xs text-sage-700">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-sage-500" />
        <div>
          Inbound only for now. Replying to a DM from inside Bloom is not built,
          and Meta only allows a reply within 24 hours of the couple&apos;s last
          message anyway. What you get today is the record: every DM on the
          couple&apos;s timeline, with the handle that ties it to everything
          else they have done.
        </div>
      </section>
    </div>
  )
}
