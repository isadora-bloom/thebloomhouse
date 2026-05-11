'use client'

/**
 * Banner shown on the lead detail page when a wedding has the sticky
 * AI opt-out flag set (weddings.ai_opted_out, mig 303). Surfaces:
 *   - when the opt-out fired
 *   - the reason
 *   - a "Resume AI drafting" button that POSTs to the toggle route
 *
 * Surfaces here so the operator always knows when Sage is silent for
 * this couple. Without the banner an operator could spend hours waiting
 * for a draft that will never appear.
 */

import { useState } from 'react'
import { Bot, Loader2, CheckCircle2 } from 'lucide-react'

interface AiOptOutBannerProps {
  weddingId: string
  optedOutAt: string | null
  reason: string | null
  /** Called after the operator successfully resumes AI drafting so the
   *  parent page can re-fetch / clear local state. */
  onResumed?: () => void
}

function humanReason(raw: string | null): string {
  if (!raw) return 'they asked for a real person'
  if (raw.startsWith('escalation:magic_words'))
    return 'they replied with "HUMAN REQUESTED" (the legacy magic-words form)'
  if (raw.startsWith('escalation:haiku_detected'))
    return 'they asked to talk to a real person in their reply'
  if (raw === 'historical_escalation_backfill')
    return 'they had previously asked for a real person (auto-detected on backfill)'
  if (raw === 'operator_set') return 'you set this manually'
  return raw
}

function relativeTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const diff = Date.now() - d.getTime()
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function AiOptOutBanner({
  weddingId,
  optedOutAt,
  reason,
  onResumed,
}: AiOptOutBannerProps) {
  const [resuming, setResuming] = useState(false)
  const [resumed, setResumed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleResume() {
    setResuming(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/weddings/${weddingId}/ai-opt-out`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ optedOut: false }),
      })
      const data = (await res.json()) as { error?: string; ok?: boolean }
      if (!res.ok || !data.ok) {
        setError(data.error ?? 'Could not resume AI drafting.')
        return
      }
      setResumed(true)
      onResumed?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error.')
    } finally {
      setResuming(false)
    }
  }

  if (resumed) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 flex items-center gap-2">
        <CheckCircle2 className="w-4 h-4" />
        Sage will draft replies for this couple again starting with their next inbound.
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <div className="flex items-start gap-2">
        <Bot className="w-4 h-4 mt-0.5 flex-shrink-0" />
        <div className="flex-1 space-y-1">
          <div className="font-semibold">Sage is not drafting for this couple.</div>
          <div className="leading-relaxed">
            Reason: {humanReason(reason)}
            {optedOutAt ? ` (${relativeTime(optedOutAt)})` : ''}. Any inbound from this
            thread skips drafting and waits for you to reply manually.
          </div>
          {error && (
            <div className="text-rose-700 text-xs pt-1">{error}</div>
          )}
        </div>
        <button
          type="button"
          onClick={handleResume}
          disabled={resuming}
          className="self-start inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100 transition-colors disabled:opacity-50"
        >
          {resuming ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
          Resume AI drafting
        </button>
      </div>
    </div>
  )
}
