'use client'

/**
 * /agent/brain-dump — coordinator-facing listing of brain-dump entries
 * + entry points to the rule audit (/agent/brain-dump/grants).
 *
 * The historical surface for this data was /settings/brain-dump-log,
 * buried under settings. This page is the natural Agent-mode entry
 * point: latest entries, filterable by status, plus an active-grants
 * banner pointing into the rule management flow (Bug 6).
 */

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import {
  Loader2,
  Brain,
  Clock,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ListFilter,
  ArrowRight,
  Sparkles,
} from 'lucide-react'
import { ActiveGrantsBanner } from '@/components/agent/active-grants-banner'

interface BrainDumpEntry {
  id: string
  raw_input: string
  raw_input_excerpt: string
  input_type: string
  parse_status: string
  intent: string | null
  routed_table: string | null
  routed_to: Array<{ table?: string; action?: string; field?: string }>
  clarification_question: string | null
  clarification_answer: string | null
  submitter_name: string | null
  created_at: string
  parsed_at: string | null
  resolved_at: string | null
}

const TABLE_LABELS: Record<string, string> = {
  admin_notifications: 'Notifications',
  marketing_spend: 'Marketing spend',
  voice_preferences: 'Voice preferences',
  forbidden_topics: 'Forbidden topics',
  weddings: 'Lead profile',
  interactions: 'Email log',
  knowledge_gaps: 'Knowledge gaps',
  knowledge_base: 'Knowledge base',
  reviews: 'Reviews',
  tangential_signals: 'Identity signals',
}

function tableLabel(table: string): string {
  if (TABLE_LABELS[table]) return TABLE_LABELS[table]
  return table.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatDateTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function statusBadge(status: string): { bg: string; text: string; label: string; Icon: typeof CheckCircle2 } {
  switch (status) {
    case 'parsed':
    case 'confirmed':
      return {
        bg: 'bg-emerald-50',
        text: 'text-emerald-700',
        label: status === 'confirmed' ? 'Confirmed' : 'Parsed',
        Icon: CheckCircle2,
      }
    case 'needs_clarification':
      return { bg: 'bg-amber-50', text: 'text-amber-700', label: 'Needs clarification', Icon: AlertTriangle }
    case 'dismissed':
      return { bg: 'bg-sage-50', text: 'text-sage-600', label: 'Dismissed', Icon: XCircle }
    case 'pending':
    default:
      return { bg: 'bg-blue-50', text: 'text-blue-700', label: 'Pending', Icon: Loader2 }
  }
}

export default function BrainDumpListPage() {
  const [entries, setEntries] = useState<BrainDumpEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<string>('all')

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/brain-dump/entries')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as { entries: BrainDumpEntry[] }
      setEntries(json.entries)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load entries')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const filtered = entries.filter((e) => statusFilter === 'all' || e.parse_status === statusFilter)

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-heading text-3xl font-semibold text-sage-900 flex items-center gap-2">
            <Brain className="w-7 h-7" />
            Brain-dump
          </h1>
          <p className="text-sm text-sage-600 mt-2 max-w-2xl">
            Every brain-dump submission for the last 30 days, newest first. Standing rules and pattern candidates live on the rules page.
          </p>
        </div>
        <Link
          href="/agent/brain-dump/grants"
          className="inline-flex items-center gap-2 text-sm px-3 py-2 rounded-lg border border-sage-300 hover:border-sage-400 hover:bg-sage-50 text-sage-700"
        >
          <Sparkles className="w-4 h-4" />
          Manage rules
          <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>

      {/* Bug 6: banner showing active grants count + link to manage. */}
      <ActiveGrantsBanner />

      {error && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          {error}
        </div>
      )}

      <section>
        <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-sage-500">
            Recent entries (30d)
          </h2>
          <div className="flex items-center gap-1 text-xs">
            <ListFilter className="w-3 h-3 text-sage-400" />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="border border-sage-200 rounded px-2 py-1 text-xs bg-warm-white text-sage-700"
            >
              <option value="all">All statuses</option>
              <option value="parsed">Parsed</option>
              <option value="confirmed">Confirmed</option>
              <option value="needs_clarification">Needs clarification</option>
              <option value="pending">Pending</option>
              <option value="dismissed">Dismissed</option>
            </select>
          </div>
        </div>

        {loading && entries.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-sage-500 py-12 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading entries…
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-lg border border-sage-200 bg-warm-white p-6 text-center text-sm text-sage-500">
            No brain-dump entries in this view.
          </div>
        ) : (
          <ul className="space-y-2">
            {filtered.map((e) => {
              const badge = statusBadge(e.parse_status)
              const StatusIcon = badge.Icon
              return (
                <li key={e.id} className="rounded-lg border border-sage-200 bg-warm-white p-4">
                  <div className="flex items-start justify-between gap-3 mb-2 flex-wrap">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${badge.bg} ${badge.text}`}
                      >
                        <StatusIcon className="w-3 h-3" />
                        {badge.label}
                      </span>
                      {e.intent && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-sage-50 text-sage-700">
                          intent: {e.intent}
                        </span>
                      )}
                      {e.routed_table && (
                        <span
                          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-700"
                          title={`routed to ${e.routed_table}`}
                        >
                          {`-> ${tableLabel(e.routed_table)}`}
                        </span>
                      )}
                      {e.input_type !== 'text' && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-sage-50 text-sage-600">
                          {e.input_type}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-sage-500 flex items-center gap-2 shrink-0">
                      <Clock className="w-3 h-3" />
                      {formatDateTime(e.created_at)}
                      {e.submitter_name && <span className="text-sage-400">· {e.submitter_name}</span>}
                    </div>
                  </div>
                  <p className="text-sm text-sage-800 leading-snug whitespace-pre-wrap break-words">
                    {e.raw_input_excerpt}
                    {e.raw_input.length > e.raw_input_excerpt.length && '…'}
                  </p>
                  {e.clarification_question && (
                    <div className="mt-2 text-xs text-amber-800 bg-amber-50/60 border border-amber-200 rounded p-2">
                      <strong className="font-semibold">Clarification asked:</strong> {e.clarification_question}
                      {e.clarification_answer && (
                        <div className="mt-1 text-sage-700">
                          <strong className="font-semibold">Answer:</strong> {e.clarification_answer}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
