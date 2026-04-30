'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import {
  Send, Eye, Bookmark, MessageSquare, MousePointerClick,
  Phone, Star, Activity, ShieldOff, Settings as SettingsIcon,
  AlertTriangle,
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

export default function ReEngagementPage() {
  const [data, setData] = useState<QueueResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [toggling, setToggling] = useState(false)

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

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-32 bg-sage-50 rounded-xl animate-pulse" />
        <div className="h-64 bg-sage-50 rounded-xl animate-pulse" />
      </div>
    )
  }

  if (!data) return null

  if (!data.enabled) {
    // Opt-in CTA. Nothing to show; nothing has been done with
    // the underlying candidate data either (the service returns
    // an empty list when the flag is off).
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
              <button
                disabled
                title="AI drafter ships in Stage 2"
                className="px-3 py-1.5 text-xs bg-sage-100 text-sage-400 rounded-lg cursor-not-allowed flex items-center gap-1.5 shrink-0"
              >
                <Send className="w-3 h-3" />
                Draft (soon)
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-xs text-amber-700">
        <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
        <p>
          Stage 1 of Phase D Tier 2: read-only queue. The AI drafter,
          send/discard tracking, and conversion attribution land in
          Stages 2 + 3. <Link href="/intel/sources" className="underline">/intel/sources</Link> already
          shows the related "non-converting cohort" panel for cross-reference.
        </p>
      </div>
    </div>
  )
}
