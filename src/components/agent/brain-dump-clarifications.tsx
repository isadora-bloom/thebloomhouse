'use client'

/**
 * Brain-dump clarifications — the missing half of the /agent/notifications
 * page. When the brain-dump classifier flags an entry as needs_clarification
 * (ambiguous intent, destructive availability change, analytics preview),
 * the entry lands in brain_dump_entries with parse_status='needs_clarification'
 * but previously nothing rendered it. The FloatingBrainDump success message
 * told users to "check the Notifications page" and that was a dead end.
 *
 * This widget closes the loop: pulls pending entries, shows the classifier's
 * question, lets the coordinator type a clarifying answer and confirm (which
 * stamps the entry confirmed) or dismiss (which marks it dismissed).
 */

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { AlertCircle, Brain, CheckCircle2, Loader2, X } from 'lucide-react'

interface PendingEntry {
  id: string
  raw_input: string
  input_type: string
  clarification_question: string | null
  parse_result: { intent?: string } | null
  created_at: string
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function BrainDumpClarifications() {
  const venueId = useVenueId()
  const [entries, setEntries] = useState<PendingEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    if (!venueId) return
    const supabase = createClient()
    const { data } = await supabase
      .from('brain_dump_entries')
      .select('id, raw_input, input_type, clarification_question, parse_result, created_at')
      .eq('venue_id', venueId)
      .eq('parse_status', 'needs_clarification')
      .order('created_at', { ascending: false })
      .limit(50)
    setEntries((data ?? []) as PendingEntry[])
    setLoading(false)
  }, [venueId])

  useEffect(() => {
    load()
  }, [load])

  async function resolve(id: string, action: 'confirm' | 'dismiss') {
    setBusyId(id)
    try {
      const res = await fetch(`/api/brain-dump/${id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          answer: action === 'confirm' ? (drafts[id]?.trim() || undefined) : undefined,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        alert(err.error || `HTTP ${res.status}`)
        return
      }
      await load()
    } finally {
      setBusyId(null)
    }
  }

  if (loading || entries.length === 0) return null

  return (
    <div>
      <h2 className="font-heading text-lg font-semibold text-sage-900 mb-3 flex items-center gap-2">
        <Brain className="w-5 h-5 text-amber-500" />
        Captures Needing Clarification
        <span className="text-xs font-normal text-amber-700 bg-amber-100 px-2 py-0.5 rounded">
          {entries.length}
        </span>
      </h2>
      <div className="bg-surface border border-amber-200 rounded-xl shadow-sm overflow-hidden divide-y divide-amber-100">
        {entries.map((e) => (
          <div key={e.id} className="px-5 py-4">
            <div className="flex items-start gap-3 mb-3">
              <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-sage-900">
                  {e.clarification_question || 'Needs clarification.'}
                </p>
                <p className="text-xs text-sage-500 mt-1">
                  {timeAgo(e.created_at)}
                  {e.parse_result?.intent && (
                    <>
                      <span> · </span>
                      <span className="italic">{e.parse_result.intent.replace(/_/g, ' ')}</span>
                    </>
                  )}
                  <span> · </span>
                  <span>{e.input_type}</span>
                </p>
              </div>
            </div>
            <div className="bg-sage-50 border border-sage-100 rounded-lg p-2 mb-3">
              <p className="text-xs text-sage-500 uppercase tracking-wide mb-1">Original</p>
              <p className="text-xs text-sage-800 whitespace-pre-wrap break-words">
                {e.raw_input.length > 400 ? `${e.raw_input.slice(0, 400)}...` : e.raw_input}
              </p>
            </div>
            <textarea
              rows={2}
              placeholder="Answer (optional) — or dismiss if you no longer want to file this"
              value={drafts[e.id] ?? ''}
              onChange={(ev) => setDrafts((d) => ({ ...d, [e.id]: ev.target.value }))}
              className="w-full px-2 py-1.5 border border-sage-200 rounded text-xs mb-2"
            />
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => resolve(e.id, 'dismiss')}
                disabled={busyId === e.id}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-sage-700 border border-sage-200 rounded hover:bg-sage-50 disabled:opacity-50"
              >
                <X className="w-3 h-3" />
                Dismiss
              </button>
              <button
                onClick={() => resolve(e.id, 'confirm')}
                disabled={busyId === e.id}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-sage-600 text-white rounded hover:bg-sage-700 disabled:opacity-50"
              >
                {busyId === e.id ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-3 h-3" />
                )}
                Confirm
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
