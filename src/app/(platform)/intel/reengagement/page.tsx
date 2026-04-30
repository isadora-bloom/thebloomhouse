'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  Send, Eye, Bookmark, MessageSquare, MousePointerClick,
  Phone, Star, Activity, ShieldOff, Settings as SettingsIcon,
  AlertTriangle, X, Mail, Copy, CheckCircle, Loader2,
} from 'lucide-react'

interface Candidate {
  candidate_id: string
  source_platform: string
  first_name: string | null
  last_initial: string | null
  state: string | null
  funnel_depth: number
  signal_count: number
  action_counts: Record<string, number> | null
  first_seen: string | null
  last_seen: string | null
}

interface QueueResponse {
  enabled: boolean
  candidates: Candidate[]
  already_actioned: number
}

type Channel = 'email' | 'manual_paste'

function platformLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function actionIcon(action: string) {
  if (action === 'view') return <Eye className="w-3 h-3" />
  if (action === 'save') return <Bookmark className="w-3 h-3" />
  if (action === 'message') return <MessageSquare className="w-3 h-3" />
  if (action === 'click') return <MousePointerClick className="w-3 h-3" />
  if (action === 'review') return <Star className="w-3 h-3" />
  if (action === 'call') return <Phone className="w-3 h-3" />
  return <Activity className="w-3 h-3" />
}

function fmtDate(d: string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

interface DraftState {
  candidate: Candidate
  channel: Channel
  /** action_id once the row is created. */
  actionId: string | null
  draftText: string
  recipientEmail: string
  loading: boolean
  error: string | null
  /** True after Send / Discard succeeds; modal stays open showing
   *  the success state until coordinator closes it. */
  done: 'sent' | 'discarded' | null
}

export default function ReEngagementPage() {
  const [data, setData] = useState<QueueResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [toggling, setToggling] = useState(false)
  const [draft, setDraft] = useState<DraftState | null>(null)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/intel/reengagement', { credentials: 'include' })
    if (res.ok) setData(await res.json())
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  async function toggleEnabled(next: boolean) {
    if (!confirm(next
      ? 'Turn on re-engagement candidates? Bloom will start surfacing high-funnel non-converting candidates so you can reach back out. You can turn this off any time.'
      : 'Turn off re-engagement? The queue will stop surfacing candidates. Existing drafts and sent records stay.')
    ) return
    setToggling(true)
    const res = await fetch('/api/intel/reengagement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    })
    if (res.ok) await load()
    setToggling(false)
  }

  async function startDraft(candidate: Candidate, channel: Channel) {
    setDraft({
      candidate,
      channel,
      actionId: null,
      draftText: '',
      recipientEmail: '',
      loading: true,
      error: null,
      done: null,
    })
    const res = await fetch('/api/intel/reengagement/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidate_id: candidate.candidate_id, channel }),
    })
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setDraft((d) => d && { ...d, loading: false, error: j.error ?? 'Drafter failed' })
      return
    }
    const j = await res.json() as { action: { id: string; draft_text: string }; intended_channel: Channel }
    setDraft((d) => d && {
      ...d,
      actionId: j.action.id,
      draftText: j.action.draft_text,
      loading: false,
    })
  }

  async function commitAction(action: 'send' | 'discard') {
    if (!draft || !draft.actionId) return
    setDraft((d) => d && { ...d, loading: true, error: null })
    const res = await fetch(`/api/intel/reengagement/${draft.actionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        action === 'discard'
          ? { action: 'discard' }
          : {
              action: 'send',
              channel: draft.channel,
              sent_text: draft.draftText,
              recipient_email: draft.channel === 'email' ? draft.recipientEmail : undefined,
            },
      ),
    })
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setDraft((d) => d && { ...d, loading: false, error: j.error ?? 'Action failed' })
      return
    }
    setDraft((d) => d && { ...d, loading: false, done: action === 'send' ? 'sent' : 'discarded' })
    // Refresh queue so the candidate drops off the list.
    void load()
  }

  function copyDraft() {
    if (!draft) return
    navigator.clipboard.writeText(draft.draftText)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <div className="h-32 bg-sage-50 rounded-xl animate-pulse" />
        <div className="h-64 bg-sage-50 rounded-xl animate-pulse" />
      </div>
    )
  }

  if (!data) return null

  if (!data.enabled) {
    return (
      <div className="max-w-3xl">
        <div className="bg-surface border border-border rounded-xl p-8 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-full bg-sage-50 flex items-center justify-center shrink-0">
              <ShieldOff className="w-6 h-6 text-sage-500" />
            </div>
            <div className="flex-1">
              <h2 className="font-heading text-xl font-semibold text-sage-900">
                Re-engagement is off for this venue
              </h2>
              <p className="text-sm text-sage-700 mt-3 leading-relaxed">
                When turned on, Bloom surfaces candidates who engaged
                deeply on a vendor platform (The Knot, WeddingWire,
                Instagram, etc.) but never inquired with you. You can
                draft a generic outreach message and either email it
                directly (when we have their address) or copy it to
                paste into the platform&apos;s DM tool.
              </p>
              <p className="text-sm text-sage-700 mt-3 leading-relaxed">
                We don&apos;t reference specific signal counts in the
                outreach — only platform-level engagement (&quot;you&apos;ve
                been browsing wedding venues&quot;). The cohort is limited
                to candidates who engaged within the last 90 days, with
                a minimum funnel depth of 3 distinct actions. We never
                send a second message to the same candidate.
              </p>
              <div className="mt-6 flex items-center gap-3">
                <button
                  onClick={() => toggleEnabled(true)}
                  disabled={toggling}
                  className="px-4 py-2 bg-sage-600 text-white rounded-lg hover:bg-sage-700 disabled:opacity-50 text-sm font-medium"
                >
                  Turn on re-engagement
                </button>
                <span className="text-xs text-sage-500">You can turn this back off any time.</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold text-sage-900">
            Re-engagement queue
          </h1>
          <p className="text-sm text-sage-600 mt-1">
            High-funnel non-converting candidates from the last 90 days.{' '}
            {data.already_actioned > 0 && (
              <span className="text-sage-500">
                {data.already_actioned} candidate{data.already_actioned === 1 ? '' : 's'} already actioned.
              </span>
            )}
          </p>
        </div>
        <button
          onClick={() => toggleEnabled(false)}
          disabled={toggling}
          className="text-xs text-sage-500 hover:text-sage-700 flex items-center gap-1 shrink-0"
          title="Turn off re-engagement"
        >
          <SettingsIcon className="w-3.5 h-3.5" />
          Turn off
        </button>
      </div>

      {data.candidates.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 text-center shadow-sm">
          <p className="text-sage-700 font-medium">No re-engagement candidates right now.</p>
          <p className="text-sage-500 text-sm mt-2">
            Candidates appear here when someone engages 3+ distinct actions on a tracked platform without inquiring.
          </p>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-xl shadow-sm divide-y divide-border">
          {data.candidates.map((c) => (
            <div key={c.candidate_id} className="px-5 py-4 flex items-start gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-base font-semibold text-sage-900">
                    {c.first_name ?? '?'} {c.last_initial ? c.last_initial.toUpperCase() + '.' : ''}
                  </p>
                  <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-sage-50 text-sage-700 border border-sage-100">
                    {platformLabel(c.source_platform)}
                  </span>
                  {c.state && (
                    <span className="text-xs text-sage-500">({c.state.toUpperCase()})</span>
                  )}
                </div>
                <p className="text-xs text-sage-500 mt-1">
                  Funnel depth {c.funnel_depth} · {c.signal_count} signal{c.signal_count === 1 ? '' : 's'} ·
                  Last seen {fmtDate(c.last_seen)}
                </p>
                {c.action_counts && Object.keys(c.action_counts).length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {Object.entries(c.action_counts).map(([k, v]) => (
                      <span
                        key={k}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-sage-50 text-sage-700 border border-sage-100"
                      >
                        {actionIcon(k)}
                        {v} {k}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1.5 shrink-0">
                <button
                  onClick={() => startDraft(c, 'manual_paste')}
                  className="px-3 py-1.5 text-xs bg-sage-600 text-white rounded-lg hover:bg-sage-700 flex items-center gap-1.5"
                >
                  <MessageSquare className="w-3 h-3" />
                  Draft DM
                </button>
                <button
                  onClick={() => startDraft(c, 'email')}
                  className="px-3 py-1.5 text-xs bg-white text-sage-700 border border-sage-200 rounded-lg hover:bg-sage-50 flex items-center gap-1.5"
                >
                  <Mail className="w-3 h-3" />
                  Draft email
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---- Draft modal ---- */}
      {draft && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-surface rounded-xl shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-border flex items-center justify-between">
              <div>
                <h3 className="font-heading text-lg font-semibold text-sage-900">
                  {draft.channel === 'email' ? 'Email draft' : 'DM draft'} — {draft.candidate.first_name ?? '?'} {draft.candidate.last_initial?.toUpperCase()}.
                </h3>
                <p className="text-xs text-sage-500 mt-0.5">
                  {platformLabel(draft.candidate.source_platform)} · funnel depth {draft.candidate.funnel_depth}
                </p>
              </div>
              <button
                onClick={() => setDraft(null)}
                className="text-sage-500 hover:text-sage-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              {draft.error && (
                <div className="bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 text-sm text-rose-700">
                  {draft.error}
                </div>
              )}

              {draft.done === 'sent' && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-3 text-sm text-emerald-800 flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 text-emerald-600" />
                  {draft.channel === 'email' ? 'Email sent.' : 'Marked sent. Paste the text into the platform DM.'}
                </div>
              )}
              {draft.done === 'discarded' && (
                <div className="bg-sage-50 border border-sage-200 rounded-lg px-3 py-3 text-sm text-sage-800 flex items-center gap-2">
                  <X className="w-4 h-4 text-sage-600" />
                  Discarded. This candidate won&apos;t appear in the queue again.
                </div>
              )}

              {draft.loading && !draft.draftText ? (
                <div className="flex items-center gap-2 text-sm text-sage-500 py-12 justify-center">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Generating draft…
                </div>
              ) : draft.draftText ? (
                <>
                  <div>
                    <label className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                      Draft (editable)
                    </label>
                    <textarea
                      value={draft.draftText}
                      onChange={(e) => setDraft((d) => d && { ...d, draftText: e.target.value })}
                      disabled={Boolean(draft.done)}
                      rows={draft.channel === 'email' ? 10 : 4}
                      className="w-full mt-1 px-3 py-2 border border-border rounded-lg text-sm font-mono leading-relaxed disabled:bg-sage-50/50"
                    />
                  </div>

                  {draft.channel === 'email' && !draft.done && (
                    <div>
                      <label className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                        Recipient email
                      </label>
                      <input
                        type="email"
                        value={draft.recipientEmail}
                        onChange={(e) => setDraft((d) => d && { ...d, recipientEmail: e.target.value })}
                        placeholder="customer@example.com"
                        className="w-full mt-1 px-3 py-2 border border-border rounded-lg text-sm"
                      />
                      <p className="text-[11px] text-sage-500 mt-1">
                        We send from your venue&apos;s connected Gmail account. Subject is generic.
                      </p>
                    </div>
                  )}

                  {!draft.done && (
                    <div className="flex items-center gap-2 pt-2">
                      {draft.channel === 'manual_paste' && (
                        <button
                          onClick={copyDraft}
                          className="px-3 py-1.5 text-xs bg-white border border-sage-200 text-sage-700 rounded-lg hover:bg-sage-50 flex items-center gap-1.5"
                        >
                          {copied ? <CheckCircle className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                          {copied ? 'Copied' : 'Copy text'}
                        </button>
                      )}
                      <button
                        onClick={() => commitAction('send')}
                        disabled={draft.loading || (draft.channel === 'email' && !draft.recipientEmail.trim())}
                        className="px-3 py-1.5 text-xs bg-sage-600 text-white rounded-lg hover:bg-sage-700 disabled:opacity-50 flex items-center gap-1.5"
                      >
                        <Send className="w-3 h-3" />
                        {draft.channel === 'email' ? 'Send email' : 'Mark sent'}
                      </button>
                      <button
                        onClick={() => commitAction('discard')}
                        disabled={draft.loading}
                        className="px-3 py-1.5 text-xs bg-white border border-sage-200 text-sage-700 rounded-lg hover:bg-sage-50 disabled:opacity-50"
                      >
                        Discard
                      </button>
                    </div>
                  )}
                  {draft.done && (
                    <div className="pt-2">
                      <button
                        onClick={() => setDraft(null)}
                        className="px-3 py-1.5 text-xs bg-sage-600 text-white rounded-lg hover:bg-sage-700"
                      >
                        Close
                      </button>
                    </div>
                  )}
                </>
              ) : null}
            </div>
          </div>
        </div>
      )}

      <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-xs text-amber-700">
        <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
        <p>
          Stage 2 of Phase D Tier 2: AI drafting + send/discard tracking. Stage 3 (60-day conversion attribution + ROI panel) is still to ship.
        </p>
      </div>
    </div>
  )
}
