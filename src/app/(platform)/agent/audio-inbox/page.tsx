'use client'

/**
 * Agent -> Audio Inbox
 *
 * T2-E Phase 2 (2026-05-01): provider-agnostic triage surface for
 * audio-capture transcripts (OMI today, iPhone upload / Otter /
 * AssemblyAI / Deepgram in the future) that couldn't be auto-matched
 * to a scheduled tour (walk-ins, testing sessions, anything outside
 * the match window, or venues with auto-match disabled). Each orphan
 * carries its source provider tag so coordinators can tell the source.
 *
 * Per-row actions:
 *   - Attach to tour: pick from recent tours for this venue; server
 *     copies the orphan transcript into tours.transcript + binds
 *     session_id and rewrites segment rows to point at the tour.
 *   - Dismiss: marks status='dismissed', nothing touches tours.
 *
 * Wave 29 (2026-05-11): the page now also shows multi-channel signals
 * — SMS (Twilio) and Zoom meeting transcripts — that ride the same
 * "non-email conversation" surface (interactions.surface='voice_capture').
 * A tab strip filters between All Voice / Omi / SMS / Zoom. Omi orphans
 * stay in their own table (tour_transcript_orphans); SMS + Zoom live
 * in interactions because they're already wedding-scoped at ingest.
 *
 * White-label: no venue-name or AI-name hardcoding. Help copy resolves
 * venue_ai_config.ai_name so Rixey sees "Sage", Oakwood sees "Iris", etc.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useScope } from '@/lib/hooks/use-scope'
import { createClient } from '@/lib/supabase/client'
import { Inbox, Paperclip, X, MapPin, MessageSquare, Video, Mic } from 'lucide-react'

interface Orphan {
  id: string
  venue_id: string
  session_id: string
  transcript: string
  segments_count: number
  first_segment_at: string
  last_segment_at: string
  status: 'pending' | 'attached' | 'dismissed'
  created_at: string
}

interface TourOption {
  id: string
  scheduled_at: string | null
  tour_type: string | null
  outcome: string | null
  wedding_id: string | null
  notes: string | null
}

interface VoiceInteraction {
  id: string
  venue_id: string
  wedding_id: string | null
  type: 'sms' | 'meeting' | 'voicemail' | string
  direction: 'inbound' | 'outbound' | string
  subject: string | null
  body_preview: string | null
  full_body: string | null
  from_name: string | null
  /** SMS rows store the phone number here (the from_email column doubles
   *  as the canonical sender identifier per migration 063). Used to
   *  group messages from the same phone into a single thread. */
  from_email: string | null
  timestamp: string
  extracted_identity: Record<string, unknown> | null
}

interface VoiceThread {
  /** Composite key: wedding_id when matched, else the phone/from address. */
  key: string
  /** True when these messages are linked to a wedding; drives the View
   *  Lead button vs Unmatched badge. */
  weddingId: string | null
  /** Display label: couple name (when we can derive it from from_name on
   *  any message) or the phone number for unmatched threads. */
  label: string
  /** Phone number / from-address for the thread; surfaced in the header. */
  fromAddress: string | null
  provider: 'sms' | 'zoom' | 'omi' | 'other'
  messages: VoiceInteraction[]
}

type VoiceTab = 'all' | 'omi' | 'sms' | 'zoom'

/**
 * Map an interaction row to a provider label for the tab filter.
 * Order matters: SMS = type='sms'; Zoom = type='meeting' + meeting-shaped
 * extracted_identity.provider; Omi = type='meeting' or 'voicemail' that
 * came from Omi adapter (falls through to default).
 */
function providerForInteraction(row: VoiceInteraction): 'sms' | 'zoom' | 'omi' | 'other' {
  if (row.type === 'sms') return 'sms'
  const provider = (row.extracted_identity as { provider?: string } | null)?.provider
  if (provider === 'zoom') return 'zoom'
  if (provider === 'omi') return 'omi'
  if (row.type === 'meeting' && /zoom/i.test(row.subject ?? '')) return 'zoom'
  // Default: if it's a meeting/voicemail without a tagged provider, treat as Omi
  if (row.type === 'meeting' || row.type === 'voicemail') return 'omi'
  return 'other'
}

export default function AudioInboxPage() {
  const { venueId } = useScope()
  const [orphans, setOrphans] = useState<Orphan[]>([])
  const [voiceRows, setVoiceRows] = useState<VoiceInteraction[]>([])
  const [tours, setTours] = useState<TourOption[]>([])
  const [aiName, setAiName] = useState<string>('your assistant')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [selection, setSelection] = useState<Record<string, string>>({})
  const [activeTab, setActiveTab] = useState<VoiceTab>('all')

  const load = useCallback(async () => {
    if (!venueId) return
    setLoading(true)
    setError(null)
    try {
      const supabase = createClient()
      const [
        { data: orphanData, error: oErr },
        { data: tourData },
        { data: aiData },
        { data: voiceData },
      ] = await Promise.all([
        supabase
          .from('tour_transcript_orphans')
          .select('*')
          .eq('venue_id', venueId)
          .eq('status', 'pending')
          .order('last_segment_at', { ascending: false }),
        supabase
          .from('tours')
          .select('id, scheduled_at, tour_type, outcome, wedding_id, notes')
          .eq('venue_id', venueId)
          .in('outcome', ['pending', 'completed'])
          .order('scheduled_at', { ascending: false })
          .limit(50),
        supabase
          .from('venue_ai_config')
          .select('ai_name')
          .eq('venue_id', venueId)
          .maybeSingle(),
        // Wave 29: pull voice_capture interactions (SMS / Zoom / non-orphan Omi).
        supabase
          .from('interactions')
          .select(
            'id, venue_id, wedding_id, type, direction, subject, body_preview, full_body, from_name, from_email, timestamp, extracted_identity',
          )
          .eq('venue_id', venueId)
          .eq('surface', 'voice_capture')
          .order('timestamp', { ascending: false })
          .limit(100),
      ])
      if (oErr) throw oErr
      setOrphans((orphanData ?? []) as Orphan[])
      setTours((tourData ?? []) as TourOption[])
      setAiName((aiData?.ai_name as string | undefined) || 'your assistant')
      setVoiceRows((voiceData ?? []) as VoiceInteraction[])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [venueId])

  useEffect(() => {
    load()
  }, [load])

  async function handleAttach(orphan: Orphan) {
    const tourId = selection[orphan.id]
    if (!tourId) {
      setError('Pick a tour first.')
      return
    }
    setBusyId(orphan.id)
    setError(null)
    try {
      const res = await fetch(`/api/omi/orphans/${orphan.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attachToTourId: tourId }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Failed' }))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      setOrphans((rows) => rows.filter((r) => r.id !== orphan.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to attach')
    } finally {
      setBusyId(null)
    }
  }

  async function handleDismiss(orphan: Orphan) {
    if (!confirm('Dismiss this transcript? It stays in the database but will not appear here again.')) return
    setBusyId(orphan.id)
    setError(null)
    try {
      const res = await fetch(`/api/omi/orphans/${orphan.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dismiss: true }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setOrphans((rows) => rows.filter((r) => r.id !== orphan.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to dismiss')
    } finally {
      setBusyId(null)
    }
  }

  // ---- Tab filtering ----
  const tabCounts = useMemo(() => {
    const counts = { all: 0, omi: orphans.length, sms: 0, zoom: 0 }
    for (const row of voiceRows) {
      const p = providerForInteraction(row)
      if (p === 'sms') counts.sms++
      else if (p === 'zoom') counts.zoom++
      else if (p === 'omi') counts.omi++
    }
    counts.all = orphans.length + counts.sms + counts.zoom
    // Omi count is orphans only since interactions-side Omi rows are
    // already matched to a tour (not orphans).
    return counts
  }, [orphans, voiceRows])

  const filteredVoiceRows = useMemo(() => {
    if (activeTab === 'all' || activeTab === 'omi') return [] // Omi shows via orphans path
    return voiceRows.filter((r) => {
      const p = providerForInteraction(r)
      return p === activeTab
    })
  }, [voiceRows, activeTab])

  // 2026-05-11: collapse messages from the same phone (or same wedding)
  // into one thread card. Sort by latest activity. Each thread carries
  // every message inline so the operator can expand it without leaving
  // the page; click View Lead to jump to the full timeline.
  const voiceThreads = useMemo<VoiceThread[]>(() => {
    const source =
      activeTab === 'all'
        ? voiceRows.filter((r) => {
            const p = providerForInteraction(r)
            return p === 'sms' || p === 'zoom'
          })
        : filteredVoiceRows
    const buckets = new Map<string, VoiceInteraction[]>()
    for (const row of source) {
      const key = row.wedding_id ?? row.from_email ?? `unmatched:${row.id}`
      const existing = buckets.get(key)
      if (existing) existing.push(row)
      else buckets.set(key, [row])
    }
    const threads: VoiceThread[] = []
    for (const [key, messages] of buckets.entries()) {
      // Newest first within a thread so the card preview shows the
      // most recent message.
      messages.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
      const first = messages[0]
      const fromAddress =
        messages.find((m) => m.from_email)?.from_email ?? null
      const inferredName =
        messages.find((m) => m.from_name && m.from_name.trim())?.from_name ??
        null
      const label = inferredName || fromAddress || 'Unmatched contact'
      threads.push({
        key,
        weddingId: first.wedding_id,
        label,
        fromAddress,
        provider: providerForInteraction(first),
        messages,
      })
    }
    // Newest activity wins at the top.
    threads.sort(
      (a, b) => (a.messages[0].timestamp < b.messages[0].timestamp ? 1 : -1),
    )
    return threads
  }, [voiceRows, activeTab, filteredVoiceRows])

  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const toggleExpanded = (key: string): void =>
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))

  // Re-match action. Operator-triggered counterpart to the hourly
  // sms_rematch cron — runs the LLM name + event-context matcher
  // against every unlinked SMS row on this venue and updates rows in
  // place. Refreshes the page data on completion.
  const [rematching, setRematching] = useState(false)
  const [rematchSummary, setRematchSummary] = useState<{
    scanned: number
    matched: number
    updated: number
  } | null>(null)
  async function handleRematch() {
    if (!venueId) return
    setRematching(true)
    setRematchSummary(null)
    try {
      const res = await fetch('/api/admin/sms/rematch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = (await res.json()) as {
        ok: boolean
        scanned?: number
        matched?: number
        updated?: number
        error?: string
      }
      if (!res.ok || !data.ok) {
        setError(data.error ?? 'Re-match failed.')
        return
      }
      setRematchSummary({
        scanned: data.scanned ?? 0,
        matched: data.matched ?? 0,
        updated: data.updated ?? 0,
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error.')
    } finally {
      setRematching(false)
    }
  }

  // Unmatched-thread count drives the prominence of the Re-match button.
  const unmatchedThreadCount = voiceThreads.filter((t) => !t.weddingId).length

  const showOrphans = activeTab === 'all' || activeTab === 'omi'
  const showVoiceList = activeTab === 'all' || activeTab === 'sms' || activeTab === 'zoom'

  return (
    <div className="max-w-5xl space-y-6">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <Inbox className="w-6 h-6 text-sage-600 flex-shrink-0" />
          <div>
            <h1 className="text-2xl font-serif text-sage-900">Audio Inbox</h1>
            <p className="text-sm text-sage-600 mt-1">
              Voice + SMS signals from your audio-capture providers. Omi
              transcripts that couldn&apos;t be auto-matched to a tour need
              attach or dismiss; SMS and Zoom transcripts land here for
              triage so {aiName} can learn from them.
            </p>
          </div>
        </div>
        {unmatchedThreadCount > 0 && (
          <button
            type="button"
            onClick={handleRematch}
            disabled={rematching}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-sage-300 bg-warm-white text-sage-800 hover:bg-sage-50 transition-colors text-sm disabled:opacity-50"
          >
            {rematching ? 'Matching…' : `Re-match ${unmatchedThreadCount} unmatched`}
          </button>
        )}
      </header>
      {rematchSummary && (
        <div className="rounded-md bg-sage-50 border border-sage-200 px-4 py-2 text-sm text-sage-800">
          Scanned {rematchSummary.scanned} · matched {rematchSummary.matched} · linked{' '}
          {rematchSummary.updated}.
        </div>
      )}

      {/* Tab strip — Wave 29 */}
      <div className="flex flex-wrap gap-1 border border-border rounded-lg p-1 bg-warm-white w-fit">
        {([
          { id: 'all', label: 'All Voice', count: tabCounts.all, icon: Inbox },
          { id: 'omi', label: 'Omi', count: tabCounts.omi, icon: Mic },
          { id: 'sms', label: 'SMS', count: tabCounts.sms, icon: MessageSquare },
          { id: 'zoom', label: 'Zoom', count: tabCounts.zoom, icon: Video },
        ] as const).map((t) => {
          const Icon = t.icon
          const active = activeTab === t.id
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className={
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ' +
                (active
                  ? 'bg-sage-600 text-white'
                  : 'text-sage-700 hover:bg-sage-50')
              }
              aria-pressed={active}
            >
              <Icon className="w-3.5 h-3.5" />
              {t.label}
              <span
                className={
                  'ml-1 inline-block min-w-[18px] text-center text-[10px] px-1 py-0.5 rounded ' +
                  (active ? 'bg-white/20' : 'bg-sage-100 text-sage-700')
                }
              >
                {t.count}
              </span>
            </button>
          )
        })}
      </div>

      {error && (
        <div className="border border-red-200 bg-red-50 text-red-700 text-sm rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-sage-500">Loading...</div>
      ) : (
        <>
          {showOrphans && orphans.length === 0 && filteredVoiceRows.length === 0 && activeTab === 'all' && (
            <div className="text-sm text-sage-500 border border-dashed border-border rounded-lg px-4 py-10 text-center">
              Nothing to triage. Orphan Omi transcripts, inbound SMS, and Zoom meeting transcripts will show up here.
            </div>
          )}

          {showOrphans && orphans.length > 0 && (
            <section className="space-y-3">
              {activeTab === 'all' && (
                <h2 className="text-sm font-medium text-sage-800 flex items-center gap-2">
                  <Mic className="w-4 h-4" />
                  Orphan Omi transcripts
                </h2>
              )}
              {orphans.map((orphan) => {
                const preview = (orphan.transcript || '').slice(0, 200)
                const shortSession = orphan.session_id.slice(0, 12)
                return (
                  <div
                    key={orphan.id}
                    className="border border-border rounded-lg bg-warm-white p-4 space-y-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-xs text-sage-600">
                        <span className="font-mono bg-sage-50 px-2 py-0.5 rounded border border-sage-200">
                          {shortSession}
                        </span>
                        <span>{new Date(orphan.first_segment_at).toLocaleString()}</span>
                        <span className="text-sage-400">·</span>
                        <span>{orphan.segments_count} segments</span>
                      </div>
                    </div>

                    <p className="text-sm text-sage-800 leading-relaxed">
                      {preview.trim() || <span className="italic text-sage-500">Empty transcript</span>}
                      {orphan.transcript && orphan.transcript.length > 200 && (
                        <span className="text-sage-400">...</span>
                      )}
                    </p>

                    <div className="flex flex-col sm:flex-row gap-2 pt-1">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <MapPin className="w-4 h-4 text-sage-500 shrink-0" />
                        <select
                          value={selection[orphan.id] ?? ''}
                          onChange={(e) =>
                            setSelection((prev) => ({ ...prev, [orphan.id]: e.target.value }))
                          }
                          disabled={busyId === orphan.id || tours.length === 0}
                          className="flex-1 min-w-0 border border-border rounded-lg px-3 py-2 bg-warm-white text-sage-900 text-sm focus:outline-none focus:ring-2 focus:ring-sage-300"
                        >
                          <option value="">
                            {tours.length === 0 ? 'No tours for this venue yet' : 'Attach to tour...'}
                          </option>
                          {tours.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.scheduled_at
                                ? new Date(t.scheduled_at).toLocaleString()
                                : 'No scheduled time'}
                              {t.tour_type ? ` · ${t.tour_type}` : ''}
                              {t.outcome ? ` · ${t.outcome}` : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => handleAttach(orphan)}
                          disabled={busyId === orphan.id || !selection[orphan.id]}
                          className="inline-flex items-center gap-1.5 px-3 py-2 bg-sage-600 text-white rounded-lg text-sm font-medium hover:bg-sage-700 disabled:opacity-50 transition-colors"
                        >
                          <Paperclip className="w-4 h-4" />
                          Attach
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDismiss(orphan)}
                          disabled={busyId === orphan.id}
                          className="inline-flex items-center gap-1.5 px-3 py-2 border border-border text-sage-700 rounded-lg text-sm hover:bg-sage-50 disabled:opacity-50 transition-colors"
                        >
                          <X className="w-4 h-4" />
                          Dismiss
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </section>
          )}

          {showVoiceList && (
            <section className="space-y-3">
              {activeTab === 'all' && (voiceRows.length > 0) && (
                <h2 className="text-sm font-medium text-sage-800 flex items-center gap-2">
                  <MessageSquare className="w-4 h-4" />
                  SMS &amp; Zoom transcripts
                </h2>
              )}
              {voiceThreads.length === 0 && activeTab !== 'all' && (
                <div className="text-sm text-sage-500 border border-dashed border-border rounded-lg px-4 py-10 text-center">
                  No {activeTab === 'sms' ? 'SMS' : 'Zoom'} signals yet. Configure the channel under Settings -&gt; Multi-channel.
                </div>
              )}
              {voiceThreads.map((thread) => {
                const Icon =
                  thread.provider === 'sms'
                    ? MessageSquare
                    : thread.provider === 'zoom'
                      ? Video
                      : Mic
                const latest = thread.messages[0]
                const preview = (latest.body_preview || latest.full_body || '')
                  .slice(0, 200)
                const isOpen = !!expanded[thread.key]
                const messageCount = thread.messages.length
                return (
                  <div
                    key={thread.key}
                    className="border border-border rounded-lg bg-warm-white p-4 space-y-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-sage-600">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Icon className="w-4 h-4 text-sage-500" />
                        <span className="font-medium uppercase tracking-wide text-[10px] text-sage-700">
                          {thread.provider}
                        </span>
                        <span>·</span>
                        <span className="font-medium text-sage-900">{thread.label}</span>
                        {thread.fromAddress && thread.fromAddress !== thread.label && (
                          <>
                            <span>·</span>
                            <span className="text-sage-500">{thread.fromAddress}</span>
                          </>
                        )}
                        <span>·</span>
                        <span>
                          {messageCount} {messageCount === 1 ? 'message' : 'messages'}
                        </span>
                        <span>·</span>
                        <span>{new Date(latest.timestamp).toLocaleString()}</span>
                      </div>
                      {thread.weddingId ? (
                        <a
                          href={`/intel/clients/${thread.weddingId}`}
                          className="text-sage-700 hover:underline text-xs"
                        >
                          View lead
                        </a>
                      ) : (
                        <span className="italic text-sage-500 text-xs">Unmatched</span>
                      )}
                    </div>
                    {!isOpen ? (
                      <>
                        <p className="text-sm text-sage-800 leading-relaxed whitespace-pre-wrap">
                          {preview.trim() || (
                            <span className="italic text-sage-500">Empty body</span>
                          )}
                          {(latest.full_body || '').length > 200 && (
                            <span className="text-sage-400">...</span>
                          )}
                        </p>
                        {messageCount > 1 && (
                          <button
                            type="button"
                            onClick={() => toggleExpanded(thread.key)}
                            className="text-xs text-sage-600 hover:text-sage-800 hover:underline"
                          >
                            Show all {messageCount} messages
                          </button>
                        )}
                      </>
                    ) : (
                      <div className="space-y-3 pt-2">
                        {thread.messages.map((msg) => (
                          <div
                            key={msg.id}
                            className={`rounded-md px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                              msg.direction === 'inbound'
                                ? 'bg-sage-50 text-sage-900'
                                : 'bg-stone-50 text-stone-800'
                            }`}
                          >
                            <div className="text-[10px] uppercase tracking-wide text-sage-500 mb-1">
                              {msg.direction === 'inbound' ? 'In' : 'Out'} · {new Date(msg.timestamp).toLocaleString()}
                            </div>
                            {msg.full_body || msg.body_preview || (
                              <span className="italic text-sage-400">Empty body</span>
                            )}
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => toggleExpanded(thread.key)}
                          className="text-xs text-sage-600 hover:text-sage-800 hover:underline"
                        >
                          Collapse
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </section>
          )}
        </>
      )}
    </div>
  )
}
