'use client'

/**
 * Wave 24 — The Channel Truth Report (narrated-intelligence surface).
 *
 * Anchor docs:
 *   - feedback_measure_dont_assume.md (page narrates measured outcomes;
 *     never validates a pre-judged narrative; surfaces sample size +
 *     prompt version + freshness on every claim)
 *   - feedback_self_reported_sources_not_truth.md (the stated-vs-
 *     forensic question surfaces the gap, not one side)
 *   - feedback_deep_fix_vs_bandaid.md (this is the lead-with-grade
 *     evidence surface — Isadora demos it externally; airtightness
 *     rules layered into every answer, not bolted on)
 *
 * UX doctrine
 * -----------
 * NOT a query builder. The page narrates pre-built questions in plain
 * English. Filters / intent classes / role taxonomies stay in the
 * /admin/attribution/roles operator power tool — this page is for the
 * venue owner who asks "is Knot actually working?"
 */

import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  Calendar,
  Loader2,
  Send,
  Sparkles,
} from 'lucide-react'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { ChannelTruthAnswer } from '@/components/intel/ChannelTruthAnswer'
import type {
  ChannelTruthPagePayload,
  NarratedAnswer,
} from '@/lib/services/channel-truth/types'

export default function ChannelTruthPage() {
  const venueId = useVenueId()
  const [payload, setPayload] = useState<ChannelTruthPagePayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [askText, setAskText] = useState('')
  const [askResult, setAskResult] = useState<{
    question_id: string | null
    refusal_reason: string | null
  } | null>(null)
  const [askLoading, setAskLoading] = useState(false)

  const load = useCallback(async () => {
    if (!venueId) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/intel/channel-truth/page?venueId=${venueId}`)
      const json = (await res.json()) as ChannelTruthPagePayload
      if (!res.ok || !json.ok) {
        setError(json.error ?? `HTTP ${res.status}`)
        return
      }
      setPayload(json)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [venueId])

  useEffect(() => {
    load()
  }, [load])

  const handleShare = useCallback(
    async (questionId: string, format: 'csv' | 'pdf' | 'link') => {
      try {
        const res = await fetch('/api/admin/intel/channel-truth/share', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ questionId, format, venueId }),
        })
        if (!res.ok) {
          const txt = await res.text()
          alert(`Share failed: ${txt}`)
          return
        }
        if (format === 'csv') {
          const blob = await res.blob()
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `channel-truth-${questionId}.csv`
          a.click()
          URL.revokeObjectURL(url)
          return
        }
        const data = await res.json()
        if (format === 'link' && data.audit_id) {
          await navigator.clipboard.writeText(`${window.location.origin}/intel/channel-truth/snapshot/${data.audit_id}`)
          alert('Snapshot link copied to clipboard')
          return
        }
        // pdf: download a JSON for now (real PDF generation is a follow-up).
        const blob = new Blob([JSON.stringify(data.snapshot, null, 2)], {
          type: 'application/json',
        })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `channel-truth-${questionId}.json`
        a.click()
        URL.revokeObjectURL(url)
      } catch (err) {
        alert(`Share error: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [venueId],
  )

  const handleAsk = useCallback(async () => {
    if (askText.trim().length < 4) return
    setAskLoading(true)
    setAskResult(null)
    try {
      const res = await fetch('/api/admin/intel/channel-truth/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: askText.trim() }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        setAskResult({
          question_id: null,
          refusal_reason: json.error ?? 'failed',
        })
      } else {
        setAskResult({
          question_id: json.question_id,
          refusal_reason: json.refusal_reason,
        })
      }
    } catch (err) {
      setAskResult({
        question_id: null,
        refusal_reason: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setAskLoading(false)
    }
  }, [askText])

  const freshnessAgeHours = payload
    ? (Date.now() - Date.parse(payload.calibration.data_freshness_iso)) /
      (1000 * 60 * 60)
    : 0
  const isStale = freshnessAgeHours > 24

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <header className="mb-6">
        <h1 className="text-3xl font-serif text-stone-900 mb-2">
          The Channel Truth Report
        </h1>
        <p className="text-stone-600 max-w-3xl">
          What&apos;s actually true about your channel attribution? Every
          number on this page is reproducible, sample-size-annotated, and
          prompt-version-disclosed. Findings are exportable for external
          sharing.
        </p>
      </header>

      {payload && payload.ok && (
        <div className="mb-6 p-4 bg-stone-50 border border-stone-200 rounded-md flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <CalibrationPill
            label="Venue"
            value={payload.calibration.venue_label}
            tone="neutral"
          />
          <CalibrationPill
            label="Classified events"
            value={`${payload.calibration.total_classified_count.toLocaleString()}`}
            tone="neutral"
          />
          <CalibrationPill
            label="v1-classified"
            value={
              payload.calibration.total_classified_count > 0
                ? `${payload.calibration.v1_classified_pct.toFixed(1)}% (${payload.calibration.v1_classified_count})`
                : '0%'
            }
            tone={payload.calibration.v1_classified_pct > 5 ? 'warn' : 'ok'}
          />
          <CalibrationPill
            label="Data freshness"
            value={`${freshnessAgeHours.toFixed(1)}h ago`}
            tone={isStale ? 'warn' : 'ok'}
          />
          <CalibrationPill
            label="Narrator prompt"
            value={payload.calibration.narrator_prompt_version}
            tone="neutral"
          />
        </div>
      )}

      {payload && payload.ok && isStale && (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-md text-sm text-amber-900 flex items-start gap-2">
          <Calendar className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold">Data is {freshnessAgeHours.toFixed(0)}h old.</span>{' '}
            The intent-classify cron has not run recently; numbers reflect
            the last refresh, not realtime state.
          </div>
        </div>
      )}

      {payload &&
        payload.ok &&
        payload.calibration.v1_classified_pct > 5 && (
          <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-md text-sm text-amber-900 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold">
                {payload.calibration.v1_classified_pct.toFixed(1)}% of
                classified attribution events were processed under the v1
                bias-contaminated prompts.
              </span>{' '}
              Findings touching v1 cells carry an inline asterisk. Run{' '}
              <code className="text-xs bg-amber-100 px-1 rounded">
                /api/admin/attribution/reclassify-v1
              </code>{' '}
              to clean numbers before sharing externally.
            </div>
          </div>
        )}

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-md flex items-start gap-2">
          <AlertCircle className="w-5 h-5 text-red-700 flex-shrink-0" />
          <div className="text-red-800 text-sm">{error}</div>
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-stone-600">
          <Loader2 className="w-4 h-4 animate-spin" />
          Computing answers…
        </div>
      )}

      {payload && payload.ok && payload.answers.length === 0 && !loading && (
        <div className="p-6 bg-stone-50 border border-stone-200 rounded-md text-stone-600 text-sm">
          No answerable questions yet for this venue. Run the intent and
          role classifiers first.
        </div>
      )}

      <div className="space-y-4">
        {payload?.ok &&
          payload.answers.map((a: NarratedAnswer) => (
            <ChannelTruthAnswer
              key={a.question_id}
              answer={a}
              onShare={handleShare}
            />
          ))}
      </div>

      {payload?.ok && payload.suggested_not_answerable.length > 0 && (
        <div className="mt-6 p-4 bg-stone-50 border border-stone-200 rounded-md">
          <div className="text-sm font-semibold text-stone-700 mb-2">
            Questions considered but not yet answerable
          </div>
          <ul className="text-xs text-stone-600 space-y-1">
            {payload.suggested_not_answerable.map((n) => (
              <li key={n.question_id}>
                <span className="font-mono">{n.question_id}</span>: {n.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-8 p-4 bg-white border border-stone-200 rounded-lg">
        <div className="flex items-center gap-2 mb-2 text-stone-700">
          <Sparkles className="w-4 h-4" />
          <span className="font-medium">Ask a different question</span>
        </div>
        <p className="text-xs text-stone-500 mb-3">
          Type any question. We&apos;ll route it to the closest pre-built
          deterministic answer, or refuse if none matches.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={askText}
            onChange={(e) => setAskText(e.target.value)}
            placeholder="e.g. Are my Instagram leads converting faster than Knot leads?"
            className="flex-1 px-3 py-2 border border-stone-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-stone-300"
            maxLength={500}
          />
          <button
            onClick={handleAsk}
            disabled={askLoading || askText.trim().length < 4}
            className="px-4 py-2 bg-stone-900 text-white text-sm rounded-md hover:bg-stone-800 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1"
          >
            {askLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
            Ask
          </button>
        </div>
        {askResult && (
          <div className="mt-3">
            {askResult.question_id ? (
              <div className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-md p-2">
                Closest match:{' '}
                <span className="font-mono">{askResult.question_id}</span>{' '}
                — already rendered above.
              </div>
            ) : (
              <div className="text-sm text-stone-700 bg-stone-100 border border-stone-200 rounded-md p-2">
                {askResult.refusal_reason ??
                  "I don't have a deterministic answer for that yet."}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

interface CalibrationPillProps {
  label: string
  value: string
  tone: 'ok' | 'warn' | 'neutral'
}

function CalibrationPill({ label, value, tone }: CalibrationPillProps) {
  const cls =
    tone === 'warn'
      ? 'text-amber-900'
      : tone === 'ok'
        ? 'text-emerald-900'
        : 'text-stone-900'
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-stone-500">
        {label}
      </span>
      <span className={`text-sm font-medium ${cls}`}>{value}</span>
    </div>
  )
}
