'use client'

/**
 * Brain Dump Queue — Phase 2.5 Task 29.
 *
 * Dashboard widget showing the most recent coordinator brain-dump
 * submissions. Entries needing clarification float to the top; resolved
 * entries fade out (parse_status='parsed' + resolved_at < 48h ago).
 *
 * The widget is read-only for the quick view — click through to
 * /agent/notifications to resolve a clarification, or to
 * /settings/brain-dump-log for the full audit trail.
 */

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { Brain, AlertCircle, CheckCircle2, Clock } from 'lucide-react'

interface BrainDumpEntry {
  id: string
  raw_input: string
  parse_status: 'pending' | 'parsed' | 'needs_clarification' | 'confirmed' | 'dismissed'
  clarification_question: string | null
  parse_result: { intent?: string; confidence?: number } | null
  created_at: string
  resolved_at: string | null
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

function statusIcon(s: BrainDumpEntry['parse_status']) {
  if (s === 'needs_clarification') return <AlertCircle className="w-4 h-4 text-amber-600" />
  if (s === 'parsed' || s === 'confirmed') return <CheckCircle2 className="w-4 h-4 text-emerald-600" />
  return <Clock className="w-4 h-4 text-sage-500" />
}

export function BrainDumpQueue() {
  const venueId = useVenueId()
  const [entries, setEntries] = useState<BrainDumpEntry[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!venueId) return
    const supabase = createClient()
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
    // Pull anything needing attention OR anything resolved in the last 48h.
    const { data } = await supabase
      .from('brain_dump_entries')
      .select('id, raw_input, parse_status, clarification_question, parse_result, created_at, resolved_at')
      .eq('venue_id', venueId)
      .or(`parse_status.eq.needs_clarification,and(parse_status.eq.parsed,resolved_at.gte.${cutoff})`)
      .order('created_at', { ascending: false })
      .limit(10)
    setEntries((data ?? []) as BrainDumpEntry[])
    setLoading(false)
  }, [venueId])

  useEffect(() => {
    load()
  }, [load])

  if (loading) return null
  if (entries.length === 0) return null

  const needingAttention = entries.filter((e) => e.parse_status === 'needs_clarification')

  return (
    <div className="bg-white border border-sage-200 rounded-xl p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-heading text-base font-semibold text-sage-900 flex items-center gap-2">
          <Brain className="w-4 h-4 text-sage-600" />
          Recent captures
          {needingAttention.length > 0 && (
            <span className="text-xs font-normal text-amber-700 bg-amber-100 px-2 py-0.5 rounded">
              {needingAttention.length} need{needingAttention.length === 1 ? 's' : ''} attention
            </span>
          )}
        </h3>
      </div>
      <div className="space-y-2">
        {entries.map((e) => (
          <div
            key={e.id}
            className="flex items-start gap-2 text-sm"
            title={e.raw_input}
          >
            <div className="pt-0.5">{statusIcon(e.parse_status)}</div>
            <div className="flex-1 min-w-0">
              <p className="text-sage-900 truncate">
                {e.raw_input.length > 80 ? `${e.raw_input.slice(0, 80)}…` : e.raw_input}
              </p>
              <p className="text-xs text-sage-500 mt-0.5 flex items-center gap-2">
                <span>{timeAgo(e.created_at)}</span>
                {e.parse_result?.intent && (
                  <>
                    <span>·</span>
                    <span className="italic">{e.parse_result.intent.replace(/_/g, ' ')}</span>
                  </>
                )}
                {e.parse_status === 'needs_clarification' && e.clarification_question && (
                  <>
                    <span>·</span>
                    <span className="text-amber-700">{e.clarification_question.slice(0, 60)}</span>
                  </>
                )}
              </p>
            </div>
          </div>
        ))}
      </div>
      {needingAttention.length > 0 && (
        <p className="text-xs text-sage-500 mt-3 pt-3 border-t border-sage-100">
          Resolve clarifications in{' '}
          <a href="/agent/notifications" className="text-sage-700 underline">
            Notifications
          </a>.
        </p>
      )}
    </div>
  )
}
