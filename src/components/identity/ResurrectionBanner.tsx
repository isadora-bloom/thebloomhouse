'use client'

/**
 * Resurrection dispute banner.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §9 ("Resurrection dispute
 * flow"). Shows inline on the couple page when the couple was
 * resurrected from Ghost status by a recent high-tier signal.
 *
 *   Confirm  → dismisses the banner (the resurrection was correct;
 *              the couple_merge_events 'resurrection' row is the
 *              permanent record, no further action needed).
 *   Not them → prompts for a reason, POSTs to
 *              /api/admin/identity/resurrection, which flips the
 *              couple back to Ghost and blacklists the identifier so
 *              it never re-resurrects the same Ghost.
 */

import { useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'

interface Props {
  coupleId: string
  resurrectedAt: string
  onResolved: () => void
}

export function ResurrectionBanner({
  coupleId,
  resurrectedAt,
  onResolved,
}: Props) {
  const [dismissed, setDismissed] = useState(false)
  const [disputing, setDisputing] = useState(false)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (dismissed) return null

  const submitReject = async () => {
    if (reason.trim().length === 0) {
      setError('A reason is required.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/identity/resurrection', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ couple_id: coupleId, reason: reason.trim() }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
      }
      if (!res.ok || !data.ok) {
        setError(data.error ?? `HTTP ${res.status}`)
        return
      }
      onResolved()
      setDismissed(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
        <div className="flex-1">
          <div className="text-sm font-medium text-amber-900">
            This couple came back from Past status
          </div>
          <div className="text-xs text-amber-800">
            A high-confidence signal on{' '}
            {new Date(resurrectedAt).toLocaleDateString()} matched a couple
            that had decayed to Ghost. We restored them. Is that correct?
          </div>

          {!disputing ? (
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={() => setDismissed(true)}
                className="rounded-md bg-amber-700 px-3 py-1 text-xs text-white hover:bg-amber-800"
              >
                Yes, that's them
              </button>
              <button
                onClick={() => setDisputing(true)}
                className="rounded-md border border-amber-300 bg-white px-3 py-1 text-xs text-amber-900 hover:bg-amber-100"
              >
                Not them
              </button>
            </div>
          ) : (
            <div className="mt-2">
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                placeholder="Why isn't this the same couple? (recycled email, different couple same name, phone reassigned...)"
                className="w-full rounded-md border border-amber-300 px-2 py-1 text-xs outline-none"
              />
              {error && (
                <div className="mt-1 text-xs text-red-700">{error}</div>
              )}
              <div className="mt-1 flex items-center gap-2">
                <button
                  onClick={submitReject}
                  disabled={submitting}
                  className="flex items-center gap-1 rounded-md bg-red-700 px-3 py-1 text-xs text-white hover:bg-red-800 disabled:opacity-50"
                >
                  {submitting && <Loader2 className="h-3 w-3 animate-spin" />}
                  Send back to Past + block this identifier
                </button>
                <button
                  onClick={() => setDisputing(false)}
                  className="text-xs text-amber-800 hover:underline"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
