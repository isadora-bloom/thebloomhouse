/**
 * Cohort-action workspace — natural-language cohort retrieval +
 * verification + bulk follow-up drafting.
 *
 * Step 3 of BLOOM-TEST-QUESTIONS.md Q37: the operator types a free-text
 * question ("everyone i had a tour with this weekend"), confirms the
 * couple list Bloom returns, then triggers bulk-draft. Drafts land in
 * /agent/drafts as status='pending' for normal approval.
 *
 * Flow:
 *   1. Input + Submit → POST /api/agent/cohort { action: 'parse' }
 *   2. Brain returns CohortQuery + interpretation → POST { action: 'preview' }
 *   3. Render couple list with checkboxes + skip-context (prior follow-up?
 *      in post-tour sequence?). Operator unchecks anyone they don't want.
 *   4. "Draft follow-ups" → POST { action: 'draft', weddingIds: [...] }
 *   5. Render result: drafted N, skipped M with reasons, failed K.
 *
 * Doctrine fit: the verification step IS the safety. The bulk drafter
 * cannot fire without explicit operator consent on a specific
 * weddingIds list. No auto-execute.
 */

'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Search, Send, Loader2, CheckCircle, XCircle, AlertCircle, ArrowRight } from 'lucide-react'
import type { CohortQuery } from '@/lib/services/brain/cohort-query'
import type { CoupleListItem } from '@/lib/services/cohort/operator-query'
import type { BulkFollowUpResult } from '@/lib/services/cohort/bulk-follow-up'

type Stage = 'input' | 'previewing' | 'previewed' | 'drafting' | 'done'

const SUGGESTIONS = [
  'everyone I had a tour with this weekend',
  'tours scheduled next week',
  'inquiries from last 7 days I haven\'t replied to',
  'estimates submitted in the last 14 days',
]

export default function CohortPage() {
  const [input, setInput] = useState('')
  const [stage, setStage] = useState<Stage>('input')
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState<CohortQuery | null>(null)
  const [couples, setCouples] = useState<CoupleListItem[]>([])
  const [totalMatched, setTotalMatched] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [result, setResult] = useState<BulkFollowUpResult | null>(null)

  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), [])

  const resetToInput = () => {
    setStage('input')
    setError(null)
    setQuery(null)
    setCouples([])
    setTotalMatched(0)
    setSelected(new Set())
    setResult(null)
  }

  const runPreview = async (textOverride?: string) => {
    const text = (textOverride ?? input).trim()
    if (!text) return
    setStage('previewing')
    setError(null)
    setResult(null)
    try {
      const parseRes = await fetch('/api/agent/cohort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'parse', input: text, today: todayIso }),
      })
      const parseJson = await parseRes.json()
      if (!parseRes.ok || !parseJson.ok) {
        throw new Error(parseJson.error || 'Parse failed')
      }
      const parsedQuery = parseJson.query as CohortQuery
      setQuery(parsedQuery)

      const previewRes = await fetch('/api/agent/cohort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'preview', query: parsedQuery }),
      })
      const previewJson = await previewRes.json()
      if (!previewRes.ok || !previewJson.ok) {
        throw new Error(previewJson.error || 'Preview failed')
      }
      const list = (previewJson.couples ?? []) as CoupleListItem[]
      setCouples(list)
      setTotalMatched(previewJson.totalMatched ?? list.length)
      // Pre-select the ones that aren't already in suppression. Operator
      // can re-add any if they really want a second-touch.
      const preChecked = new Set<string>(
        list
          .filter((c) => !c.priorFollowUpAt && !c.inPostTourSequence)
          .map((c) => c.weddingId),
      )
      setSelected(preChecked)
      setStage('previewed')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to preview cohort')
      setStage('input')
    }
  }

  const runBulkDraft = async () => {
    if (selected.size === 0) return
    setStage('drafting')
    setError(null)
    try {
      const res = await fetch('/api/agent/cohort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'draft',
          weddingIds: [...selected],
        }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error || 'Draft failed')
      setResult({
        drafted: json.drafted ?? [],
        skipped: json.skipped ?? [],
        failed: json.failed ?? [],
      })
      setStage('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to draft follow-ups')
      setStage('previewed')
    }
  }

  const toggleSelection = (weddingId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(weddingId)) next.delete(weddingId)
      else next.add(weddingId)
      return next
    })
  }

  const selectAll = () => {
    setSelected(new Set(couples.map((c) => c.weddingId)))
  }
  const clearAll = () => setSelected(new Set())

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-playfair text-sage-900">Cohort actions</h1>
        <p className="text-sm text-sage-600 mt-1">
          Ask in plain English. Bloom finds the matching couples, you
          confirm the list, then drafts get queued — with a state-aware
          skip on anyone already followed up.
        </p>
      </div>

      {/* Search input */}
      <div className="bg-white border border-sage-200 rounded-xl p-4 shadow-sm">
        <div className="flex items-center gap-2">
          <Search className="w-5 h-5 text-sage-400" />
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runPreview()
            }}
            placeholder="e.g. everyone I had a tour with this weekend"
            className="flex-1 outline-none text-sage-900 placeholder-sage-400 bg-transparent"
            disabled={stage === 'previewing' || stage === 'drafting'}
          />
          <button
            onClick={() => runPreview()}
            disabled={!input.trim() || stage === 'previewing' || stage === 'drafting'}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-sage-500 hover:bg-sage-600 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {stage === 'previewing' ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Finding…
              </>
            ) : (
              <>
                <ArrowRight className="w-4 h-4" />
                Find
              </>
            )}
          </button>
        </div>
        {stage === 'input' && (
          <div className="mt-3 flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => {
                  setInput(s)
                  runPreview(s)
                }}
                className="text-xs px-3 py-1.5 rounded-full bg-sage-50 text-sage-700 hover:bg-sage-100 border border-sage-200"
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-3 text-sm flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>{error}</div>
        </div>
      )}

      {/* Interpretation banner */}
      {query && (stage === 'previewed' || stage === 'drafting' || stage === 'done') && (
        <div className="bg-sage-50 border border-sage-200 rounded-lg p-3 text-sm">
          <div className="font-medium text-sage-800">Bloom read your request as:</div>
          <div className="text-sage-700 italic mt-1">{query.interpretation}</div>
          <div className="text-xs text-sage-500 mt-2 font-mono">
            anchor={query.anchor}
            {query.time_window && ` · window=${query.time_window.from} → ${query.time_window.to}`}
            {query.exclude_lifecycle_states.length > 0 &&
              ` · exclude=${query.exclude_lifecycle_states.join(',')}`}
          </div>
        </div>
      )}

      {/* Verification list */}
      {stage === 'previewed' && couples.length > 0 && (
        <div className="bg-white border border-sage-200 rounded-xl shadow-sm">
          <div className="px-5 py-3 border-b border-sage-200 flex items-center justify-between">
            <div className="text-sm text-sage-700">
              <span className="font-medium">{couples.length} couple{couples.length === 1 ? '' : 's'}</span>
              {totalMatched > couples.length && (
                <span className="text-sage-500"> · {totalMatched} matched (showing first {couples.length})</span>
              )}
              <span className="text-sage-500"> · {selected.size} selected</span>
            </div>
            <div className="flex gap-2">
              <button onClick={selectAll} className="text-xs text-sage-600 hover:text-sage-900">
                Select all
              </button>
              <span className="text-sage-300">·</span>
              <button onClick={clearAll} className="text-xs text-sage-600 hover:text-sage-900">
                Clear
              </button>
            </div>
          </div>
          <ul className="divide-y divide-sage-100">
            {couples.map((c) => {
              const isSelected = selected.has(c.weddingId)
              const suppression =
                c.inPostTourSequence
                  ? 'in post-tour sequence (cron will follow up)'
                  : c.priorFollowUpAt
                    ? `follow-up sent ${c.priorFollowUpAt.slice(0, 10)}`
                    : null
              return (
                <li key={c.weddingId} className="px-5 py-3 flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelection(c.weddingId)}
                    className="mt-1 w-4 h-4 accent-sage-500"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sage-900">
                        {c.displayName}
                      </span>
                      {c.lifecycleState && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-sage-100 text-sage-700">
                          {c.lifecycleState}
                        </span>
                      )}
                      {c.source && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-warm-50 text-warm-700 border border-warm-200">
                          {c.source}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-sage-500 mt-0.5">
                      {c.anchorLabel}
                      {c.weddingDate && ` · wedding ${c.weddingDate.slice(0, 10)}`}
                    </div>
                    {suppression && (
                      <div className="text-xs text-amber-700 mt-1 flex items-center gap-1">
                        <AlertCircle className="w-3 h-3" />
                        Would skip: {suppression}
                      </div>
                    )}
                  </div>
                  <Link
                    href={`/intel/clients/${c.weddingId}`}
                    className="text-xs text-sage-500 hover:text-sage-900 shrink-0"
                  >
                    View
                  </Link>
                </li>
              )
            })}
          </ul>
          <div className="px-5 py-4 border-t border-sage-200 flex items-center justify-between bg-sage-50 rounded-b-xl">
            <div className="text-sm text-sage-700">
              {selected.size === 0
                ? 'Pick at least one couple to draft.'
                : `Will draft ${selected.size} follow-up${selected.size === 1 ? '' : 's'}. Already-followed-up couples will be skipped automatically.`}
            </div>
            <button
              onClick={runBulkDraft}
              disabled={selected.size === 0 || stage !== 'previewed'}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Send className="w-4 h-4" />
              Draft follow-ups
            </button>
          </div>
        </div>
      )}

      {/* Drafting spinner */}
      {stage === 'drafting' && (
        <div className="bg-white border border-sage-200 rounded-xl p-6 text-center">
          <Loader2 className="w-6 h-6 animate-spin mx-auto text-sage-500" />
          <div className="text-sm text-sage-700 mt-2">
            Drafting {selected.size} follow-up{selected.size === 1 ? '' : 's'}…
          </div>
          <div className="text-xs text-sage-500 mt-1">
            Each takes ~5-10 seconds. Don't refresh.
          </div>
        </div>
      )}

      {/* Result */}
      {stage === 'done' && result && (
        <div className="bg-white border border-sage-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium text-sage-900">Done</h2>
            <Link
              href="/agent/drafts"
              className="text-sm text-sage-600 hover:text-sage-900 flex items-center gap-1"
            >
              Review drafts <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
              <div className="text-2xl font-medium text-emerald-700">{result.drafted.length}</div>
              <div className="text-xs text-emerald-800 mt-1">drafted</div>
            </div>
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <div className="text-2xl font-medium text-amber-700">{result.skipped.length}</div>
              <div className="text-xs text-amber-800 mt-1">skipped</div>
            </div>
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <div className="text-2xl font-medium text-red-700">{result.failed.length}</div>
              <div className="text-xs text-red-800 mt-1">failed</div>
            </div>
          </div>
          {result.skipped.length > 0 && (
            <div>
              <div className="text-sm font-medium text-sage-800 mb-2">Skipped:</div>
              <ul className="space-y-1.5 text-sm">
                {result.skipped.map((s) => {
                  const couple = couples.find((c) => c.weddingId === s.weddingId)
                  return (
                    <li key={s.weddingId} className="flex items-start gap-2">
                      <XCircle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                      <div>
                        <span className="font-medium text-sage-800">
                          {couple?.displayName ?? s.weddingId.slice(0, 8)}
                        </span>
                        <span className="text-sage-600"> — {s.detail}</span>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
          {result.drafted.length > 0 && (
            <div>
              <div className="text-sm font-medium text-sage-800 mb-2">Drafted:</div>
              <ul className="space-y-1.5 text-sm">
                {result.drafted.map((d) => {
                  const couple = couples.find((c) => c.weddingId === d.weddingId)
                  return (
                    <li key={d.weddingId} className="flex items-start gap-2">
                      <CheckCircle className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
                      <div>
                        <span className="font-medium text-sage-800">
                          {couple?.displayName ?? d.weddingId.slice(0, 8)}
                        </span>
                        <span className="text-sage-600"> → {d.toEmail}</span>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
          {result.failed.length > 0 && (
            <div>
              <div className="text-sm font-medium text-red-800 mb-2">Failed:</div>
              <ul className="space-y-1.5 text-sm">
                {result.failed.map((f) => {
                  const couple = couples.find((c) => c.weddingId === f.weddingId)
                  return (
                    <li key={f.weddingId}>
                      <span className="font-medium">{couple?.displayName ?? f.weddingId.slice(0, 8)}</span>
                      <span className="text-red-600"> — {f.reason}</span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
          <button
            onClick={resetToInput}
            className="text-sm text-sage-600 hover:text-sage-900"
          >
            New query
          </button>
        </div>
      )}

      {/* Empty result */}
      {stage === 'previewed' && couples.length === 0 && (
        <div className="bg-white border border-sage-200 rounded-xl p-6 text-center">
          <div className="text-sage-700">No couples matched.</div>
          <div className="text-xs text-sage-500 mt-1">
            Try a different time window or anchor.
          </div>
        </div>
      )}
    </div>
  )
}
