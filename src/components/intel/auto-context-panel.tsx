'use client'

/**
 * What we know about this couple — auto-context note feed.
 *
 * Renders the rolling soft-context observations the continuous profile-
 * enrichment pipeline gathered from emails / brain-dumps / tour
 * transcripts (migration 253 + src/lib/services/identity/profile-
 * enrichment.ts), plus a "What was learned this week" rollup, plus a
 * coordinator "Add a note" textarea.
 *
 * 2026-05-09 user mandate.
 */

import { useEffect, useState, useCallback } from 'react'
import {
  Brain,
  Pin,
  PinOff,
  Archive,
  ArchiveRestore,
  Plus,
  Loader2,
  Sparkles,
  AlertCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface NoteRow {
  id: string
  body: string
  category: string | null
  source: string
  source_interaction_id: string | null
  confidence: number | null
  pinned: boolean
  is_active: boolean
  created_at: string
  archived_at: string | null
}

interface WeekRollupRow {
  id: string
  body: string
  category: string | null
  source: string
  is_active: boolean
  created_at: string
}

interface ApiResponse {
  notes: NoteRow[]
  weekRollup: WeekRollupRow[]
  lastEnrichedAt: string | null
  lastEnrichedTrigger: string | null
}

const CATEGORY_LABELS: Record<string, string> = {
  life_context: 'Life',
  family: 'Family',
  vendors: 'Vendors',
  budget: 'Budget',
  health: 'Health',
  dietary: 'Dietary',
  timeline: 'Timeline',
  cultural: 'Cultural',
  preferences: 'Preferences',
  logistics: 'Logistics',
  misc: 'Note',
}

const CATEGORY_COLOR: Record<string, string> = {
  life_context: 'bg-amber-50 text-amber-700 border border-amber-200',
  family: 'bg-rose-50 text-rose-700 border border-rose-200',
  vendors: 'bg-violet-50 text-violet-700 border border-violet-200',
  budget: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  health: 'bg-red-50 text-red-700 border border-red-200',
  dietary: 'bg-orange-50 text-orange-700 border border-orange-200',
  timeline: 'bg-blue-50 text-blue-700 border border-blue-200',
  cultural: 'bg-pink-50 text-pink-700 border border-pink-200',
  preferences: 'bg-sage-50 text-sage-700 border border-sage-200',
  logistics: 'bg-slate-50 text-slate-700 border border-slate-200',
  misc: 'bg-neutral-50 text-neutral-700 border border-neutral-200',
}

const SOURCE_LABEL: Record<string, string> = {
  ai_email_extraction: 'AI · email',
  ai_calculator_extraction: 'AI · calculator',
  ai_brain_dump: 'AI · brain dump',
  ai_tour_transcript: 'AI · tour',
  coordinator_added: 'Coordinator',
}

function fmtRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h ago`
  if (ms < 7 * 86400_000) return `${Math.floor(ms / 86400_000)}d ago`
  return new Date(iso).toLocaleDateString()
}

export function AutoContextPanel({ weddingId }: { weddingId: string }) {
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [draftCategory, setDraftCategory] = useState('misc')
  const [posting, setPosting] = useState(false)
  const [actionId, setActionId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setErr(null)
    try {
      const res = await fetch(`/api/intel/auto-context/${weddingId}`)
      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText)
        throw new Error(errText || `HTTP ${res.status}`)
      }
      const body = (await res.json()) as ApiResponse
      setData(body)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [weddingId])

  useEffect(() => {
    setLoading(true)
    void refresh()
  }, [refresh])

  async function patchNote(id: string, action: 'pin' | 'unpin' | 'archive' | 'unarchive') {
    setActionId(id)
    try {
      const res = await fetch(`/api/intel/auto-context/${weddingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      })
      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText)
        throw new Error(errText)
      }
      await refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setActionId(null)
    }
  }

  async function submitNote(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = draft.trim()
    if (!trimmed) return
    setPosting(true)
    setErr(null)
    try {
      const res = await fetch(`/api/intel/auto-context/${weddingId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: trimmed, category: draftCategory }),
      })
      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText)
        throw new Error(errText)
      }
      setDraft('')
      setDraftCategory('misc')
      await refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setPosting(false)
    }
  }

  if (loading) {
    return (
      <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-3">
          <Brain className="w-4 h-4 text-sage-500" />
          <h2 className="font-heading text-base font-semibold text-sage-900">
            What we know about this couple
          </h2>
        </div>
        <div className="flex items-center gap-2 text-sage-500 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading context notes…
        </div>
      </div>
    )
  }

  const notes = data?.notes ?? []
  const week = data?.weekRollup ?? []
  const newThisWeek = week.filter((w) => w.is_active)

  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Brain className="w-4 h-4 text-sage-500" />
            <h2 className="font-heading text-base font-semibold text-sage-900">
              What we know about this couple
            </h2>
          </div>
          <p className="text-xs text-sage-500 mt-1">
            Auto-extracted soft context. Sage uses these for tone and empathy without quoting them
            verbatim.
          </p>
        </div>
        {data?.lastEnrichedAt && (
          <div className="text-[11px] text-sage-400 text-right shrink-0">
            <div className="flex items-center gap-1">
              <Sparkles className="w-3 h-3" />
              <span>last enriched {fmtRelative(data.lastEnrichedAt)}</span>
            </div>
            {data.lastEnrichedTrigger && (
              <div className="opacity-70">via {data.lastEnrichedTrigger.replace(/_/g, ' ')}</div>
            )}
          </div>
        )}
      </div>

      {err && (
        <div className="flex items-start gap-2 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>{err}</div>
        </div>
      )}

      {/* Coordinator add-a-note */}
      <form onSubmit={submitNote} className="space-y-2">
        <div className="flex items-center gap-2 text-xs font-medium text-sage-700">
          <Plus className="w-3.5 h-3.5" />
          Add a note
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Anything Sage should know but shouldn't quote — vendor preferences, family context, mood from the last call…"
          rows={2}
          maxLength={1000}
          className="w-full text-sm rounded-lg border border-sage-200 bg-warm-white px-3 py-2 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-400"
        />
        <div className="flex items-center gap-2">
          <select
            value={draftCategory}
            onChange={(e) => setDraftCategory(e.target.value)}
            className="text-xs rounded border border-sage-200 bg-warm-white px-2 py-1 text-sage-700"
          >
            {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={posting || !draft.trim()}
            className="text-xs rounded-md bg-sage-700 text-white px-3 py-1.5 hover:bg-sage-800 disabled:opacity-50"
          >
            {posting ? 'Saving…' : 'Add note'}
          </button>
        </div>
      </form>

      {/* What was learned this week — only render when there's something */}
      {newThisWeek.length > 0 && (
        <div>
          <div className="text-xs font-medium text-sage-700 mb-2">What was learned this week</div>
          <ul className="space-y-1.5 text-sm text-sage-700">
            {newThisWeek.slice(0, 6).map((w) => (
              <li key={w.id} className="flex items-start gap-2">
                <span className="text-sage-400 mt-1">·</span>
                <span className="leading-snug">
                  <span
                    className={cn(
                      'inline-block text-[10px] px-1.5 py-0.5 rounded mr-1.5 align-middle',
                      CATEGORY_COLOR[w.category ?? 'misc'] ?? CATEGORY_COLOR.misc,
                    )}
                  >
                    {CATEGORY_LABELS[w.category ?? 'misc'] ?? 'Note'}
                  </span>
                  {w.body}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Active note feed */}
      {notes.length === 0 ? (
        <div className="text-sm text-sage-500 italic">
          No context notes yet. The AI will populate this as new emails come in, or you can add
          one above.
        </div>
      ) : (
        <ul className="space-y-2">
          {notes.map((n) => {
            const cat = n.category ?? 'misc'
            return (
              <li
                key={n.id}
                className={cn(
                  'border rounded-lg p-3',
                  n.pinned ? 'bg-amber-50 border-amber-200' : 'bg-warm-white border-sage-100',
                )}
              >
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                      <span
                        className={cn(
                          'text-[10px] px-1.5 py-0.5 rounded font-medium',
                          CATEGORY_COLOR[cat] ?? CATEGORY_COLOR.misc,
                        )}
                      >
                        {CATEGORY_LABELS[cat] ?? 'Note'}
                      </span>
                      <span className="text-[10px] text-sage-500">
                        {SOURCE_LABEL[n.source] ?? n.source}
                      </span>
                      {n.confidence != null && (
                        <span className="text-[10px] text-sage-400">· {n.confidence}%</span>
                      )}
                      <span className="text-[10px] text-sage-400 ml-auto">
                        {fmtRelative(n.created_at)}
                      </span>
                    </div>
                    <p className="text-sm text-sage-800 leading-snug whitespace-pre-wrap">
                      {n.body}
                    </p>
                  </div>
                  <div className="flex flex-col gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => patchNote(n.id, n.pinned ? 'unpin' : 'pin')}
                      disabled={actionId === n.id}
                      title={n.pinned ? 'Unpin' : 'Pin'}
                      className="p-1 rounded hover:bg-sage-100 text-sage-600 disabled:opacity-50"
                    >
                      {n.pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => patchNote(n.id, 'archive')}
                      disabled={actionId === n.id}
                      title="Archive"
                      className="p-1 rounded hover:bg-sage-100 text-sage-600 disabled:opacity-50"
                    >
                      <Archive className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <p className="text-[11px] text-sage-400 italic">
        Archived notes are preserved for the forensic record. Use the audit panel to restore them.
        <ArchiveRestore className="inline w-3 h-3 ml-1 -mt-0.5" />
      </p>
    </div>
  )
}
