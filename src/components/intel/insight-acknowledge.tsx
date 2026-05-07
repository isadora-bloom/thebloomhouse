'use client'

/**
 * Reusable acknowledge/dismiss button for intel insight cards.
 * Tier-B #64A.
 *
 * Usage:
 *   <InsightAcknowledge kind="forecasts.q3_dropoff" insightKey="2026-08" />
 *
 * Wrap around any display-only insight card. When the coordinator
 * clicks "Got it," the row is suppressed for 7 days (default) and the
 * onAcknowledged callback fires so the parent can hide the card.
 *
 * Pages that want to LIST already-acknowledged insights call the
 * GET endpoint directly and exclude matching (kind, key) pairs from
 * their render set.
 */

import { useState } from 'react'
import { Check, Loader2, X } from 'lucide-react'

interface InsightAcknowledgeProps {
  kind: string
  insightKey: string
  /** Default 7 days. Pass a higher value for insights that re-surface monthly. */
  suppressDays?: number
  /** Fired after the server confirms. Parent should hide the card. */
  onAcknowledged?: () => void
  /** Optional label override. Defaults to "Got it". */
  label?: string
  /** Render style. 'icon' for a small ✕, 'button' for a labelled button. */
  variant?: 'icon' | 'button'
  className?: string
}

export function InsightAcknowledge({
  kind,
  insightKey,
  suppressDays,
  onAcknowledged,
  label = 'Got it',
  variant = 'button',
  className,
}: InsightAcknowledgeProps) {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleClick() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/intel/acknowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind,
          key: insightKey,
          ...(suppressDays !== undefined ? { suppressDays } : {}),
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'Failed to dismiss')
        return
      }
      setDone(true)
      onAcknowledged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setBusy(false)
    }
  }

  if (variant === 'icon') {
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={busy || done}
        title={done ? 'Acknowledged' : error ?? label}
        className={
          className ??
          'p-1.5 rounded-md text-sage-400 hover:text-sage-700 hover:bg-sage-50 disabled:opacity-50'
        }
      >
        {busy ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : done ? (
          <Check className="w-4 h-4 text-green-600" />
        ) : (
          <X className="w-4 h-4" />
        )}
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy || done}
      title={error ?? undefined}
      className={
        className ??
        'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sage-50 text-sage-700 hover:bg-sage-100 text-xs font-medium disabled:opacity-50'
      }
    >
      {busy ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : done ? (
        <Check className="w-3.5 h-3.5 text-green-600" />
      ) : (
        <Check className="w-3.5 h-3.5" />
      )}
      {done ? 'Acknowledged' : label}
    </button>
  )
}
