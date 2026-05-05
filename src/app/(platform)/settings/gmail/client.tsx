'use client'

/**
 * Settings → Gmail — client island.
 *
 * Renders the connection list, toast for ?gmail=connected|error|partial,
 * and the disconnect / connect-another buttons. The actual OAuth flow
 * is initiated by full-page navigation to /api/gmail/oauth/start so
 * the browser carries any same-site cookies (none required, but the
 * navigation pattern is what Google's consent screen expects).
 */

import { useCallback, useEffect, useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  Mail,
  CheckCircle2,
  AlertTriangle,
  Plug,
  Plus,
  Loader2,
  Trash2,
} from 'lucide-react'

export interface GmailConnectionView {
  id: string
  emailAddress: string | null
  isPrimary: boolean
  syncEnabled: boolean
  label: string | null
  status: string | null
  errorMessage: string | null
  lastSyncAt: string | null
  createdAt: string | null
}

interface Props {
  connections: GmailConnectionView[]
  loadError: string | null
  venueId: string
}

function fmtRelative(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms)) return 'never'
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

const ERROR_LABELS: Record<string, string> = {
  access_denied: 'You declined access on Google&apos;s consent screen.',
  not_configured:
    'Gmail OAuth is not configured. Set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET.',
  state_secret_missing:
    'STATE_SIGNING_SECRET is not configured on the server.',
  bad_state_missing: 'OAuth state was missing — please try again.',
  bad_state_malformed: 'OAuth state was malformed — please try again.',
  bad_state_bad_signature:
    'OAuth state signature did not verify. Possible tampering — please try again.',
  bad_state_expired: 'OAuth state expired (10 min limit). Please try again.',
  bad_state_not_configured: 'Server is not configured for OAuth state signing.',
  no_code: 'Google did not return an authorization code.',
  token_exchange_failed: 'Google rejected the authorization code.',
  no_access_token: 'Google did not return an access token.',
  no_refresh_token:
    'Google did not return a refresh token. Try disconnecting at myaccount.google.com first.',
  userinfo_failed: 'Could not read your Gmail address from Google.',
  db_write_failed: 'Could not save your Gmail connection to the database.',
  state_mint_failed: 'Server failed to sign the OAuth state token.',
  consent_url_failed: 'Server failed to build the Google consent URL.',
  google_error: 'Google returned an unexpected error.',
}

function GmailSettingsBody({ connections, loadError }: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [toast, setToast] = useState<{ kind: 'success' | 'error' | 'warning'; message: string } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  // Read ?gmail=connected|error|partial and surface a toast, then
  // strip the query so a refresh doesn't re-fire it.
  useEffect(() => {
    const gmail = searchParams.get('gmail')
    if (!gmail) return
    if (gmail === 'connected') {
      const email = searchParams.get('email')
      setToast({
        kind: 'success',
        message: email
          ? `Connected ${email}.`
          : 'Gmail connected.',
      })
    } else if (gmail === 'partial') {
      const missing = searchParams.get('missing_scopes') ?? ''
      setToast({
        kind: 'warning',
        message: `Connected, but Google withheld these scopes: ${missing}. Reconnect and grant all of them for full sync.`,
      })
    } else if (gmail === 'error') {
      const reason = searchParams.get('reason') ?? 'unknown'
      const friendly = ERROR_LABELS[reason] ?? `OAuth failed (${reason}).`
      setToast({ kind: 'error', message: friendly })
    }
    // Clean URL.
    router.replace('/settings/gmail')
  }, [searchParams, router])

  const handleConnect = useCallback(() => {
    const returnTo = '/settings/gmail'
    window.location.href = `/api/gmail/oauth/start?returnTo=${encodeURIComponent(returnTo)}`
  }, [])

  const handleDisconnect = useCallback(
    async (id: string, email: string | null) => {
      const label = email ?? 'this connection'
      const ok = window.confirm(
        `Disconnect ${label}? This revokes the token at Google and deletes the connection.`,
      )
      if (!ok) return
      setBusyId(id)
      try {
        const res = await fetch(`/api/gmail/connections/${id}/disconnect`, {
          method: 'DELETE',
        })
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean
          reason?: string
          revokedAtGoogle?: boolean
        }
        if (!res.ok || !json.ok) {
          setToast({
            kind: 'error',
            message: `Disconnect failed${json.reason ? `: ${json.reason}` : ''}.`,
          })
        } else {
          setToast({
            kind: 'success',
            message: json.revokedAtGoogle
              ? `${label} disconnected and revoked at Google.`
              : `${label} disconnected (Google revoke skipped — token was missing or already invalid).`,
          })
          // Refresh the server component to pick up the new state.
          router.refresh()
        }
      } catch {
        setToast({ kind: 'error', message: 'Disconnect request failed.' })
      } finally {
        setBusyId(null)
      }
    },
    [router],
  )

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1 flex items-center gap-3">
          <Mail className="w-8 h-8 text-sage-500" />
          Gmail
        </h1>
        <p className="text-sage-600 max-w-2xl">
          Connect the Gmail inboxes the Agent should read inquiries from and send
          replies through. Each connection stores a refresh token so the cron can
          poll without you signing in again.
        </p>
      </header>

      {loadError && (
        <div className="px-4 py-3 rounded-lg border border-amber-200 bg-amber-50 text-amber-800 text-sm flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{loadError}</span>
        </div>
      )}

      {toast && (
        <div
          className={
            'px-4 py-3 rounded-lg border text-sm flex items-start gap-2 ' +
            (toast.kind === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : toast.kind === 'warning'
                ? 'border-amber-200 bg-amber-50 text-amber-800'
                : 'border-rose-200 bg-rose-50 text-rose-800')
          }
        >
          {toast.kind === 'success' ? (
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
          ) : (
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          )}
          <span>{toast.message}</span>
        </div>
      )}

      <section className="bg-surface border border-border rounded-xl shadow-sm">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="font-heading text-xl font-semibold text-sage-900">
            Connected inboxes
          </h2>
          <button
            onClick={handleConnect}
            className="inline-flex items-center gap-2 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
          >
            {connections.length === 0 ? (
              <>
                <Plug className="w-4 h-4" />
                Connect Gmail
              </>
            ) : (
              <>
                <Plus className="w-4 h-4" />
                Connect another inbox
              </>
            )}
          </button>
        </div>

        {connections.length === 0 ? (
          <div className="p-8 text-center text-sage-500 text-sm">
            No Gmail inboxes connected yet. Connect one to start polling and drafting replies.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {connections.map((conn) => {
              const showsError = conn.status === 'error' || conn.status === 'disconnected'
              return (
                <li
                  key={conn.id}
                  className="px-6 py-4 flex items-center justify-between gap-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sage-900 truncate">
                        {conn.emailAddress ?? '(unknown)'}
                      </span>
                      {conn.isPrimary && (
                        <span className="text-xs uppercase tracking-wide bg-sage-100 text-sage-700 rounded px-2 py-0.5">
                          Primary
                        </span>
                      )}
                      {!conn.syncEnabled && (
                        <span className="text-xs uppercase tracking-wide bg-amber-100 text-amber-800 rounded px-2 py-0.5">
                          Sync paused
                        </span>
                      )}
                      {showsError && (
                        <span className="text-xs uppercase tracking-wide bg-rose-100 text-rose-700 rounded px-2 py-0.5 inline-flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" />
                          {conn.status}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-sage-500 mt-0.5">
                      Last sync {fmtRelative(conn.lastSyncAt)}
                      {conn.label ? ` · ${conn.label}` : ''}
                    </p>
                    {conn.errorMessage && (
                      <p className="text-xs text-rose-600 mt-1">{conn.errorMessage}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {showsError && (
                      <button
                        onClick={handleConnect}
                        className="text-xs font-medium px-3 py-1.5 border border-sage-300 text-sage-700 hover:bg-sage-50 rounded-lg"
                      >
                        Reconnect
                      </button>
                    )}
                    <button
                      onClick={() => handleDisconnect(conn.id, conn.emailAddress)}
                      disabled={busyId === conn.id}
                      className="text-xs font-medium px-3 py-1.5 text-rose-600 hover:bg-rose-50 rounded-lg disabled:opacity-50 inline-flex items-center gap-1"
                    >
                      {busyId === conn.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                      )}
                      Disconnect
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="bg-surface border border-border rounded-xl shadow-sm p-6 text-sm text-sage-700 space-y-2">
        <h2 className="font-heading text-lg font-semibold text-sage-900">
          What we ask Google for
        </h2>
        <ul className="list-disc list-inside space-y-1">
          <li>Read your inbox (gmail.readonly)</li>
          <li>Send replies on your behalf (gmail.send)</li>
          <li>Update labels on synced threads (gmail.modify)</li>
          <li>Your email address + basic profile (openid email profile)</li>
        </ul>
        <p className="text-xs text-sage-500 pt-2">
          You can revoke access any time from this page or from{' '}
          <a
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            myaccount.google.com/permissions
          </a>
          .
        </p>
      </section>
    </div>
  )
}

export function GmailSettingsClient(props: Props) {
  // useSearchParams forces CSR bailout — wrap in Suspense per Next 16.
  return (
    <Suspense
      fallback={
        <div className="p-8 text-sm text-sage-500">Loading Gmail settings…</div>
      }
    >
      <GmailSettingsBody {...props} />
    </Suspense>
  )
}
