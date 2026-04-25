'use client'

import { useState, useEffect, useCallback } from 'react'
import { CheckCircle2, AlertCircle, Search, Loader2, Inbox } from 'lucide-react'

/**
 * Source-backtrace review panel — shared between Settings and the
 * onboarding flow. Pulls candidates from /api/intel/sources/backtrace,
 * lets the coordinator approve / reject / override each suggestion,
 * applies approved ones one-at-a-time so a partial run still sticks.
 *
 * Why this exists: scheduling tools (Calendly / Acuity / HoneyBook /
 * Dubsado) are surface-level channels. They show up as the wedding's
 * first-touch source because that's where the tour got booked, but
 * the couple actually came in through The Knot, the website, etc.
 * This panel back-traces by matching the couple's name in Gmail
 * history, runs the earliest matching email through the form-relay
 * parsers, and proposes a real first-touch source.
 */

interface Evidence {
  interactionId: string
  fromEmail: string | null
  fromName: string | null
  subject: string | null
  timestamp: string
  snippet: string
}

export interface BacktraceCandidate {
  weddingId: string
  coupleNames: string | null
  currentSource: string
  inquiryDate: string | null
  suggestedSource: string | null
  evidence: Evidence | null
  confidence: 'high' | 'medium' | 'low' | 'none'
}

const SOURCE_OPTIONS = [
  'the_knot',
  'wedding_wire',
  'here_comes_the_guide',
  'zola',
  'website',
  'venue_calculator',
  'instagram',
  'facebook',
  'google',
  'referral',
  'walk_in',
  'direct',
  'other',
]

function formatSource(s: string | null | undefined): string {
  if (!s) return 'unknown'
  const map: Record<string, string> = {
    the_knot: 'The Knot',
    wedding_wire: 'Wedding Wire',
    here_comes_the_guide: 'Here Comes The Guide',
    zola: 'Zola',
    website: 'Website',
    venue_calculator: 'Venue Calculator',
    instagram: 'Instagram',
    facebook: 'Facebook',
    google: 'Google',
    referral: 'Word of Mouth',
    walk_in: 'Walk-in',
    direct: 'Direct',
    calendly: 'Calendly',
    acuity: 'Acuity',
    honeybook: 'HoneyBook',
    dubsado: 'Dubsado',
    other: 'Other',
  }
  return map[s] ?? s
}

interface PanelProps {
  /** Compact mode trims chrome for the onboarding flow. */
  compact?: boolean
  onComplete?: (count: { applied: number; skipped: number }) => void
}

export function SourceBacktracePanel({ compact = false, onComplete }: PanelProps) {
  const [candidates, setCandidates] = useState<BacktraceCandidate[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasScanned, setHasScanned] = useState(false)
  const [selections, setSelections] = useState<Record<string, string | null>>({})
  const [applying, setApplying] = useState(false)
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set())
  const [skippedIds, setSkippedIds] = useState<Set<string>>(new Set())

  const scan = useCallback(async (live: boolean) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/intel/sources/backtrace?live=${live ? 'true' : 'false'}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as { candidates: BacktraceCandidate[] }
      setCandidates(json.candidates ?? [])
      // Default selection: take whatever the service suggested. Null
      // suggestions stay null so the row renders with "Keep current /
      // pick manually" rather than auto-applying.
      const sel: Record<string, string | null> = {}
      for (const c of json.candidates ?? []) sel[c.weddingId] = c.suggestedSource
      setSelections(sel)
      setHasScanned(true)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Scan failed')
    } finally {
      setLoading(false)
    }
  }, [])

  // Auto-scan once on mount in compact (onboarding) mode so the user
  // doesn't have to click Scan to see whether they have anything to
  // review. In settings mode, wait for a click — Gmail search costs
  // quota and we don't want to fire it on every settings visit.
  useEffect(() => {
    if (compact && !hasScanned && !loading) {
      scan(true)
    }
  }, [compact, hasScanned, loading, scan])

  async function applyOne(weddingId: string, newSource: string) {
    setApplying(true)
    try {
      const res = await fetch('/api/intel/sources/backtrace', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ weddingId, newSource }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setAppliedIds((prev) => new Set(prev).add(weddingId))
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : 'Apply failed')
    } finally {
      setApplying(false)
    }
  }

  async function applyAll() {
    setApplying(true)
    setError(null)
    let applied = 0
    let skipped = 0
    for (const c of candidates) {
      if (appliedIds.has(c.weddingId) || skippedIds.has(c.weddingId)) continue
      const newSource = selections[c.weddingId]
      if (!newSource || newSource === c.currentSource) {
        skipped++
        continue
      }
      try {
        const res = await fetch('/api/intel/sources/backtrace', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ weddingId: c.weddingId, newSource }),
        })
        if (res.ok) {
          applied++
          setAppliedIds((prev) => new Set(prev).add(c.weddingId))
        } else {
          skipped++
        }
      } catch {
        skipped++
      }
    }
    setApplying(false)
    onComplete?.({ applied, skipped })
  }

  function skipOne(weddingId: string) {
    setSkippedIds((prev) => new Set(prev).add(weddingId))
  }

  const pending = candidates.filter(
    (c) => !appliedIds.has(c.weddingId) && !skippedIds.has(c.weddingId)
  )

  return (
    <div className="space-y-4">
      {!compact && (
        <div>
          <h2 className="font-heading text-xl font-semibold text-sage-900 flex items-center gap-2">
            <Search className="w-5 h-5 text-sage-600" />
            Re-attribute Scheduling-Tool Bookings
          </h2>
          <p className="text-sm text-sage-600 mt-1">
            Calendly, Acuity, HoneyBook and Dubsado are scheduling tools — never the real
            first-touch. We&apos;ll search your Gmail by couple name to find the original
            inquiry email and propose the real source.
          </p>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
          <span className="text-sm text-red-700">{error}</span>
        </div>
      )}

      {!hasScanned && !compact && (
        <div className="flex items-center gap-3">
          <button
            onClick={() => scan(true)}
            disabled={loading}
            className="px-4 py-2 bg-sage-700 hover:bg-sage-800 disabled:opacity-60 text-white rounded-lg text-sm font-medium transition-colors"
          >
            {loading ? 'Scanning Gmail…' : 'Scan Gmail for Real First-Touch'}
          </button>
          <span className="text-xs text-sage-500">
            Searches local email history + live Gmail (full mailbox).
          </span>
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-sm text-sage-600">
          <Loader2 className="w-4 h-4 animate-spin" />
          Scanning email history…
        </div>
      )}

      {hasScanned && candidates.length === 0 && (
        <div className="bg-sage-50 border border-sage-200 rounded-lg p-4 flex items-center gap-3">
          <CheckCircle2 className="w-5 h-5 text-emerald-600" />
          <span className="text-sm text-sage-700">
            No scheduling-tool first-touches found. Your sources look clean.
          </span>
        </div>
      )}

      {hasScanned && candidates.length > 0 && (
        <>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="text-sm text-sage-700">
              {pending.length} of {candidates.length} pending review
              {appliedIds.size > 0 && ` · ${appliedIds.size} applied`}
              {skippedIds.size > 0 && ` · ${skippedIds.size} skipped`}
            </span>
            <button
              onClick={applyAll}
              disabled={applying || pending.length === 0}
              className="px-4 py-2 bg-sage-700 hover:bg-sage-800 disabled:opacity-60 text-white rounded-lg text-sm font-medium transition-colors"
            >
              {applying ? 'Applying…' : 'Apply All Suggested'}
            </button>
          </div>

          <div className="space-y-3 max-h-[600px] overflow-y-auto pr-1">
            {candidates.map((c) => {
              const isApplied = appliedIds.has(c.weddingId)
              const isSkipped = skippedIds.has(c.weddingId)
              const selected = selections[c.weddingId] ?? null
              return (
                <div
                  key={c.weddingId}
                  className={`border rounded-lg p-4 ${
                    isApplied
                      ? 'bg-emerald-50 border-emerald-200'
                      : isSkipped
                      ? 'bg-sage-50 border-border opacity-60'
                      : 'bg-surface border-border'
                  }`}
                >
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-sage-900">
                        {c.coupleNames ?? '(no name)'}
                      </div>
                      <div className="text-xs text-sage-500 mt-0.5">
                        Inquired {c.inquiryDate?.slice(0, 10) ?? '—'} · current source:{' '}
                        <span className="font-medium">{formatSource(c.currentSource)}</span>
                      </div>
                    </div>
                    {isApplied && (
                      <span className="inline-flex items-center gap-1 text-xs text-emerald-700 font-medium">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Applied
                      </span>
                    )}
                    {isSkipped && (
                      <span className="text-xs text-sage-500 font-medium">Skipped</span>
                    )}
                  </div>

                  {c.evidence ? (
                    <div className="mt-3 bg-sage-50/50 border border-border rounded p-3 text-xs">
                      <div className="flex items-start gap-2">
                        <Inbox className="w-3.5 h-3.5 text-sage-500 mt-0.5 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="text-sage-700">
                            <span className="font-medium">{c.evidence.fromName ?? 'Unknown'}</span>{' '}
                            &lt;{c.evidence.fromEmail ?? '—'}&gt;
                          </div>
                          <div className="text-sage-600 mt-0.5">
                            {c.evidence.subject ?? '(no subject)'}
                          </div>
                          <div className="text-sage-500 mt-1 italic line-clamp-2">
                            {c.evidence.snippet}
                          </div>
                          <div className="text-sage-400 mt-1">
                            {c.evidence.timestamp.slice(0, 10)} · confidence:{' '}
                            <span className="font-medium">{c.confidence}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 text-xs text-sage-500 italic">
                      No matching email found in 90-day local history or live Gmail.
                    </div>
                  )}

                  {!isApplied && !isSkipped && (
                    <div className="mt-3 flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-sage-600">Set source to:</span>
                      <select
                        value={selected ?? ''}
                        onChange={(e) =>
                          setSelections((prev) => ({
                            ...prev,
                            [c.weddingId]: e.target.value || null,
                          }))
                        }
                        className="text-sm border border-border rounded px-2 py-1 bg-surface"
                      >
                        <option value="">— pick a source —</option>
                        {SOURCE_OPTIONS.map((s) => (
                          <option key={s} value={s}>
                            {formatSource(s)}
                          </option>
                        ))}
                      </select>
                      <button
                        disabled={!selected || selected === c.currentSource || applying}
                        onClick={() => selected && applyOne(c.weddingId, selected)}
                        className="px-3 py-1 text-xs bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white rounded font-medium transition-colors"
                      >
                        Apply
                      </button>
                      <button
                        onClick={() => skipOne(c.weddingId)}
                        className="px-3 py-1 text-xs bg-surface border border-border hover:bg-sage-50 text-sage-700 rounded font-medium transition-colors"
                      >
                        Keep {formatSource(c.currentSource)}
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
