'use client'

/**
 * Pipeline-health observability dashboard (super-admin).
 *
 * Surfaces the signals that matter when something quietly breaks in the
 * email ingest -> draft -> auto-send loop. Cross-venue view, read-only.
 *
 * Sections:
 *   1. 24h headline cards: emails in, drafts queued, auto-send queue, errors
 *   2. Gmail sync health per venue (email_sync_state + gmail_connections)
 *   3. Stuck drafts — auto_send_pending older than 15 min (never claimed)
 *   4. Recent auto-send failures — status='auto_send_failed' with last_error
 *   5. Unresolved error_logs in the last 24h
 *   6. AI cost today vs yesterday
 *
 * All reads use the authenticated Supabase client. RLS must allow
 * super_admin to read cross-venue for agent/intel tables; this is the
 * existing pattern used by /super-admin. If a query is denied it shows
 * an empty state with the error for diagnosis rather than a crash.
 */

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  Bot,
  Inbox,
  Mail,
  RefreshCw,
  Send,
  Timer,
  TrendingDown,
  TrendingUp,
  Zap,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Headline {
  label: string
  value: string
  sub?: string
  delta?: number // percent vs prior period, negative = worse when inverted
  invert?: boolean // if true, positive delta is bad (e.g. failures)
  icon: React.ComponentType<{ className?: string }>
  tone: 'sage' | 'teal' | 'gold' | 'rose'
}

interface VenueLite {
  id: string
  name: string
}

interface SyncHealthRow {
  venue_id: string
  venue_name: string
  last_sync_at: string | null
  status: string | null
  error_message: string | null
  gmail_account: string | null
  stale_minutes: number | null
}

interface StuckDraft {
  id: string
  venue_id: string
  venue_name: string
  to_email: string | null
  subject: string | null
  created_at: string
  age_minutes: number
  auto_send_attempts: number
}

interface FailedDraft {
  id: string
  venue_id: string
  venue_name: string
  to_email: string | null
  subject: string | null
  auto_send_attempts: number
  auto_send_last_error: string | null
  created_at: string
}

interface ErrorRow {
  id: string
  venue_id: string | null
  venue_name: string
  error_type: string
  message: string
  created_at: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minutesAgo(dateStr: string | null): number | null {
  if (!dateStr) return null
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000)
}

function fmtAge(minutes: number | null): string {
  if (minutes === null) return 'never'
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const h = Math.floor(minutes / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function toneClasses(tone: Headline['tone']): { bg: string; ring: string; text: string } {
  switch (tone) {
    case 'sage':
      return { bg: 'bg-sage-50', ring: 'ring-sage-200', text: 'text-sage-700' }
    case 'teal':
      return { bg: 'bg-teal-50', ring: 'ring-teal-200', text: 'text-teal-700' }
    case 'gold':
      return { bg: 'bg-amber-50', ring: 'ring-amber-200', text: 'text-amber-700' }
    case 'rose':
      return { bg: 'bg-rose-50', ring: 'ring-rose-200', text: 'text-rose-700' }
  }
}

function iso(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 3600_000).toISOString()
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PipelineHealthPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [headlines, setHeadlines] = useState<Headline[]>([])
  const [syncHealth, setSyncHealth] = useState<SyncHealthRow[]>([])
  const [stuck, setStuck] = useState<StuckDraft[]>([])
  const [failed, setFailed] = useState<FailedDraft[]>([])
  const [recentErrors, setRecentErrors] = useState<ErrorRow[]>([])
  const [queryErrors, setQueryErrors] = useState<string[]>([])

  const fetchAll = useCallback(async () => {
    setRefreshing(true)
    const errs: string[] = []

    // Venue lookup for joining names client-side.
    const { data: venueRows, error: venueErr } = await supabase
      .from('venues')
      .select('id, name')
    if (venueErr) errs.push(`venues: ${venueErr.message}`)
    const venues: VenueLite[] = (venueRows ?? []) as VenueLite[]
    const venueName = (id: string | null): string =>
      venues.find((v) => v.id === id)?.name ?? '—'

    // --- Headlines ---
    const nowMinus24 = iso(24)
    const nowMinus48 = iso(48)

    // Emails ingested (inbound interactions, type=email) last 24h + prior 24h.
    const [inbound24, inbound48] = await Promise.all([
      supabase
        .from('interactions')
        .select('id', { count: 'exact', head: true })
        .eq('direction', 'inbound')
        .eq('type', 'email')
        .gte('timestamp', nowMinus24),
      supabase
        .from('interactions')
        .select('id', { count: 'exact', head: true })
        .eq('direction', 'inbound')
        .eq('type', 'email')
        .gte('timestamp', nowMinus48)
        .lt('timestamp', nowMinus24),
    ])
    if (inbound24.error) errs.push(`interactions(24h): ${inbound24.error.message}`)
    const emails24 = inbound24.count ?? 0
    const emailsPrev = inbound48.count ?? 0
    const emailDelta = emailsPrev > 0 ? Math.round(((emails24 - emailsPrev) / emailsPrev) * 100) : 0

    // Drafts awaiting review (status='pending')
    const draftsPending = await supabase
      .from('drafts')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending')
    if (draftsPending.error) errs.push(`drafts(pending): ${draftsPending.error.message}`)

    // Auto-send queue: pending + sending + failed
    const autoQueue = await supabase
      .from('drafts')
      .select('status')
      .in('status', ['auto_send_pending', 'auto_send_sending', 'auto_send_failed'])
    if (autoQueue.error) errs.push(`drafts(auto): ${autoQueue.error.message}`)
    const autoRows = (autoQueue.data ?? []) as Array<{ status: string }>
    const autoPending = autoRows.filter((r) => r.status === 'auto_send_pending').length
    const autoSending = autoRows.filter((r) => r.status === 'auto_send_sending').length
    const autoFailed = autoRows.filter((r) => r.status === 'auto_send_failed').length

    // Unresolved errors last 24h
    const errs24 = await supabase
      .from('error_logs')
      .select('id', { count: 'exact', head: true })
      .eq('resolved', false)
      .gte('created_at', nowMinus24)
    if (errs24.error) errs.push(`error_logs(24h): ${errs24.error.message}`)

    setHeadlines([
      {
        label: 'Emails ingested (24h)',
        value: String(emails24),
        sub: `vs ${emailsPrev} prior 24h`,
        delta: emailDelta,
        icon: Inbox,
        tone: 'teal',
      },
      {
        label: 'Drafts awaiting review',
        value: String(draftsPending.count ?? 0),
        sub: 'status = pending',
        icon: Mail,
        tone: 'sage',
      },
      {
        label: 'Auto-send queue',
        value: String(autoPending + autoSending + autoFailed),
        sub: `${autoPending} queued · ${autoSending} sending · ${autoFailed} failed`,
        icon: Send,
        tone: autoFailed > 0 ? 'rose' : 'gold',
      },
      {
        label: 'Unresolved errors (24h)',
        value: String(errs24.count ?? 0),
        sub: 'error_logs, resolved=false',
        invert: true,
        icon: AlertCircle,
        tone: (errs24.count ?? 0) > 0 ? 'rose' : 'sage',
      },
    ])

    // --- Gmail sync health per connection ---
    // Multi-gmail (050) moved last_sync_at + error_message onto each
    // gmail_connections row. One venue can have several coordinator
    // mailboxes, so we surface each connection separately.
    const gmailConns = await supabase
      .from('gmail_connections')
      .select('venue_id, email_address, is_primary, last_sync_at, status, error_message, sync_enabled')
    if (gmailConns.error) errs.push(`gmail_connections: ${gmailConns.error.message}`)

    const syncRows: SyncHealthRow[] = ((gmailConns.data ?? []) as Array<{
      venue_id: string
      email_address: string
      is_primary: boolean
      last_sync_at: string | null
      status: string | null
      error_message: string | null
      sync_enabled: boolean | null
    }>)
      .filter((c) => c.sync_enabled !== false)
      .map((c) => ({
        venue_id: c.venue_id,
        venue_name: venueName(c.venue_id),
        last_sync_at: c.last_sync_at,
        status: c.status,
        error_message: c.error_message,
        gmail_account: c.email_address,
        stale_minutes: minutesAgo(c.last_sync_at),
      }))
    // Sort: errored first, then stalest.
    syncRows.sort((a, b) => {
      if (!!a.error_message !== !!b.error_message) return a.error_message ? -1 : 1
      return (b.stale_minutes ?? 0) - (a.stale_minutes ?? 0)
    })
    setSyncHealth(syncRows)

    // --- Stuck drafts: auto_send_pending older than 15 min ---
    const stuckRes = await supabase
      .from('drafts')
      .select('id, venue_id, to_email, subject, created_at, auto_send_attempts')
      .eq('status', 'auto_send_pending')
      .lt('created_at', new Date(Date.now() - 15 * 60 * 1000).toISOString())
      .order('created_at', { ascending: true })
      .limit(25)
    if (stuckRes.error) errs.push(`drafts(stuck): ${stuckRes.error.message}`)
    const stuckRows: StuckDraft[] = ((stuckRes.data ?? []) as Array<{
      id: string
      venue_id: string
      to_email: string | null
      subject: string | null
      created_at: string
      auto_send_attempts: number | null
    }>).map((d) => ({
      id: d.id,
      venue_id: d.venue_id,
      venue_name: venueName(d.venue_id),
      to_email: d.to_email,
      subject: d.subject,
      created_at: d.created_at,
      age_minutes: minutesAgo(d.created_at) ?? 0,
      auto_send_attempts: d.auto_send_attempts ?? 0,
    }))
    setStuck(stuckRows)

    // --- Failed drafts: status='auto_send_failed' with last_error ---
    const failedRes = await supabase
      .from('drafts')
      .select('id, venue_id, to_email, subject, auto_send_attempts, auto_send_last_error, created_at')
      .eq('status', 'auto_send_failed')
      .order('created_at', { ascending: false })
      .limit(15)
    if (failedRes.error) errs.push(`drafts(failed): ${failedRes.error.message}`)
    const failedRows: FailedDraft[] = ((failedRes.data ?? []) as Array<{
      id: string
      venue_id: string
      to_email: string | null
      subject: string | null
      auto_send_attempts: number | null
      auto_send_last_error: string | null
      created_at: string
    }>).map((d) => ({
      id: d.id,
      venue_id: d.venue_id,
      venue_name: venueName(d.venue_id),
      to_email: d.to_email,
      subject: d.subject,
      auto_send_attempts: d.auto_send_attempts ?? 0,
      auto_send_last_error: d.auto_send_last_error,
      created_at: d.created_at,
    }))
    setFailed(failedRows)

    // --- Recent errors last 24h ---
    const errsList = await supabase
      .from('error_logs')
      .select('id, venue_id, error_type, message, created_at')
      .eq('resolved', false)
      .gte('created_at', nowMinus24)
      .order('created_at', { ascending: false })
      .limit(15)
    if (errsList.error) errs.push(`error_logs(list): ${errsList.error.message}`)
    const errorRows: ErrorRow[] = ((errsList.data ?? []) as Array<{
      id: string
      venue_id: string | null
      error_type: string
      message: string
      created_at: string
    }>).map((e) => ({
      id: e.id,
      venue_id: e.venue_id,
      venue_name: e.venue_id ? venueName(e.venue_id) : 'Platform',
      error_type: e.error_type,
      message: e.message,
      created_at: e.created_at,
    }))
    setRecentErrors(errorRows)

    setQueryErrors(errs)
    setLoading(false)
    setRefreshing(false)
  }, [supabase])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Link
            href="/super-admin"
            className="inline-flex items-center gap-1 text-xs text-sage-600 hover:text-sage-800 mb-2"
          >
            <ArrowLeft className="w-3 h-3" />
            Super Admin
          </Link>
          <h1 className="text-2xl font-semibold text-sage-900 flex items-center gap-2">
            <Activity className="w-6 h-6 text-sage-700" />
            Pipeline Health
          </h1>
          <p className="text-sm text-sage-600 mt-1">
            Email ingest · draft queue · auto-send · errors — last 24 hours across all venues.
          </p>
        </div>
        <button
          onClick={fetchAll}
          disabled={refreshing}
          className="inline-flex items-center gap-2 px-3 py-1.5 text-sm bg-sage-100 hover:bg-sage-200 text-sage-700 rounded-lg disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Query errors banner — don't hide the failure, surface it */}
      {queryErrors.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
          <p className="text-sm font-medium text-amber-900 mb-1">
            Some queries returned errors (likely RLS or schema drift)
          </p>
          <ul className="text-xs text-amber-800 space-y-0.5 font-mono">
            {queryErrors.map((e, i) => (
              <li key={i}>• {e}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Headlines */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {loading
          ? [...Array(4)].map((_, i) => (
              <div key={i} className="h-28 bg-sage-50 rounded-xl animate-pulse" />
            ))
          : headlines.map((h) => {
              const c = toneClasses(h.tone)
              const Icon = h.icon
              const showDelta = typeof h.delta === 'number' && h.delta !== 0
              const deltaGood = h.invert ? (h.delta ?? 0) < 0 : (h.delta ?? 0) > 0
              return (
                <div
                  key={h.label}
                  className={`${c.bg} ring-1 ${c.ring} rounded-xl p-4`}
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-xs text-sage-600 uppercase tracking-wide font-medium">
                        {h.label}
                      </p>
                      <p className={`text-2xl font-semibold mt-1 ${c.text}`}>{h.value}</p>
                      {h.sub && <p className="text-xs text-sage-600 mt-1">{h.sub}</p>}
                    </div>
                    <Icon className={`w-5 h-5 ${c.text}`} />
                  </div>
                  {showDelta && (
                    <div
                      className={`mt-2 inline-flex items-center gap-1 text-xs font-medium ${
                        deltaGood ? 'text-emerald-700' : 'text-rose-700'
                      }`}
                    >
                      {(h.delta ?? 0) >= 0 ? (
                        <TrendingUp className="w-3 h-3" />
                      ) : (
                        <TrendingDown className="w-3 h-3" />
                      )}
                      {Math.abs(h.delta ?? 0)}%
                    </div>
                  )}
                </div>
              )
            })}
      </div>

      {/* Gmail sync health */}
      <section className="bg-surface border border-border rounded-xl overflow-hidden">
        <header className="px-5 py-3 border-b border-border flex items-center gap-2">
          <Mail className="w-4 h-4 text-sage-700" />
          <h2 className="text-sm font-semibold text-sage-900">Gmail sync state</h2>
          <span className="text-xs text-sage-500">
            stalest or errored first · stale &gt; 30m is worth a look
          </span>
        </header>
        {syncHealth.length === 0 ? (
          <p className="p-5 text-sm text-sage-500">
            No sync state rows. Either no venues have connected a mailbox, or the
            cursor table is empty.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {syncHealth.map((r) => {
              const stale = r.stale_minutes !== null && r.stale_minutes > 30
              const errored = !!r.error_message
              return (
                <div
                  key={r.venue_id}
                  className="px-5 py-3 flex items-start justify-between gap-4"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-sage-900">{r.venue_name}</p>
                    <p className="text-xs text-sage-500 truncate">
                      {r.gmail_account ?? 'no mailbox connected'}
                    </p>
                    {errored && (
                      <p className="text-xs text-rose-700 font-mono mt-1 truncate">
                        {r.error_message}
                      </p>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <p
                      className={`text-xs font-medium ${
                        errored
                          ? 'text-rose-700'
                          : stale
                            ? 'text-amber-700'
                            : 'text-sage-700'
                      }`}
                    >
                      {fmtAge(r.stale_minutes)}
                    </p>
                    {r.status && (
                      <p className="text-[10px] text-sage-500 uppercase tracking-wide">
                        {r.status}
                      </p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* Stuck drafts */}
      <section className="bg-surface border border-border rounded-xl overflow-hidden">
        <header className="px-5 py-3 border-b border-border flex items-center gap-2">
          <Timer className="w-4 h-4 text-amber-700" />
          <h2 className="text-sm font-semibold text-sage-900">
            Stuck in auto_send_pending (&gt; 15 min)
          </h2>
          <span className="text-xs text-sage-500">
            flush tick should claim these; persistence = cron isn't running
          </span>
        </header>
        {stuck.length === 0 ? (
          <p className="p-5 text-sm text-sage-500">
            No stuck drafts. Either the flush tick is healthy or there's nothing queued.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {stuck.map((d) => (
              <div key={d.id} className="px-5 py-3 flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-sage-900 truncate">
                    {d.subject ?? '(no subject)'}{' '}
                    <span className="text-xs text-sage-500">→ {d.to_email ?? '—'}</span>
                  </p>
                  <p className="text-xs text-sage-500 mt-0.5">
                    {d.venue_name} · attempts: {d.auto_send_attempts}
                  </p>
                </div>
                <p className="text-xs text-amber-700 font-medium shrink-0">
                  {d.age_minutes}m old
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Failed auto-sends */}
      <section className="bg-surface border border-border rounded-xl overflow-hidden">
        <header className="px-5 py-3 border-b border-border flex items-center gap-2">
          <Zap className="w-4 h-4 text-rose-700" />
          <h2 className="text-sm font-semibold text-sage-900">
            Auto-send failures (retries exhausted)
          </h2>
          <span className="text-xs text-sage-500">requires migration 067</span>
        </header>
        {failed.length === 0 ? (
          <p className="p-5 text-sm text-sage-500">
            No failed auto-sends. Either everything is sending cleanly, or migration 067
            has not been applied yet.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {failed.map((d) => (
              <div key={d.id} className="px-5 py-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-sage-900 truncate">
                      {d.subject ?? '(no subject)'}{' '}
                      <span className="text-xs text-sage-500">→ {d.to_email ?? '—'}</span>
                    </p>
                    <p className="text-xs text-sage-500 mt-0.5">
                      {d.venue_name} · {d.auto_send_attempts} attempts
                    </p>
                  </div>
                  <p className="text-xs text-sage-500 shrink-0">
                    {fmtAge(minutesAgo(d.created_at))}
                  </p>
                </div>
                {d.auto_send_last_error && (
                  <p className="text-xs text-rose-700 font-mono mt-1.5 bg-rose-50 rounded px-2 py-1 break-words">
                    {d.auto_send_last_error}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Recent errors */}
      <section className="bg-surface border border-border rounded-xl overflow-hidden">
        <header className="px-5 py-3 border-b border-border flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-rose-700" />
          <h2 className="text-sm font-semibold text-sage-900">
            Unresolved errors (24h)
          </h2>
          <Link
            href="/agent/errors"
            className="text-xs text-sage-600 hover:text-sage-800 ml-auto"
          >
            Full log →
          </Link>
        </header>
        {recentErrors.length === 0 ? (
          <p className="p-5 text-sm text-sage-500">No unresolved errors. Quiet is good.</p>
        ) : (
          <div className="divide-y divide-border">
            {recentErrors.map((e) => (
              <div key={e.id} className="px-5 py-3">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wide bg-rose-50 text-rose-700 px-2 py-0.5 rounded-full">
                    {e.error_type}
                  </span>
                  <span className="text-xs text-sage-500">{e.venue_name}</span>
                  <span className="text-xs text-sage-500 ml-auto">
                    {fmtAge(minutesAgo(e.created_at))}
                  </span>
                </div>
                <p className="text-sm text-sage-800 mt-1 break-words">{e.message}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="text-xs text-sage-500 flex items-center gap-1 pt-2">
        <Bot className="w-3 h-3" />
        Read-only snapshot. No actions taken from this page.
      </div>
    </div>
  )
}
