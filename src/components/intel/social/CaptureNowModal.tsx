'use client'

/**
 * 3-step capture modal for /intel/social-integration.
 *
 * Step 1 -- Link out: open instagram.com/<handle>/followers/ in a new
 *           tab. The button is gated on the venue_handle from
 *           platform_configs (passed in by the parent page).
 * Step 2 -- Instructions: numbered list with the copy-paste JS snippet
 *           the operator runs in their browser console.
 * Step 3 -- Paste area: a textarea + submit. POSTs to
 *           /api/intel/social-integration/capture and renders the
 *           result inline (matched count, pre-inquiry surfaced, samples).
 *
 * The modal is self-contained so the parent page does not own the
 * fetch + result state. After submit, the modal stays open showing the
 * result; the operator closes it manually and the parent refreshes.
 */

import { useState } from 'react'
import { ExternalLink, X, Loader2, CheckCircle2, Sparkles, Image as ImageIcon } from 'lucide-react'

/** One handle and what the spine did with it. */
interface SpineSample {
  handle: string
  display_name: string | null
  couple_id: string | null
  couple_name: string | null
  outcome: string
  occurred_at: string
  match_status: 'matched' | 'unmatched'
}

interface CaptureResult {
  captureId: string
  total: number
  processed: number
  skipped: number
  attached: number
  minted: number
  candidates: number
  fragments: number
  duplicates: number
  matched: number
  unmatched: number
  samples: SpineSample[]
  errors?: string[]
}

interface Props {
  platform: 'instagram'
  metricType: 'new_followers'
  venueHandle: string | null
  followersUrlOverride: string | null
  onClose: () => void
  onCaptured?: (result: CaptureResult) => void
}

const SNIPPET = `copy([...document.querySelectorAll('a[href*="/"]')].map(a => a.href.split('/').filter(Boolean).pop()).filter(h => h && !h.includes('.')).join('\\n'))`

export function CaptureNowModal({
  platform: _platform,
  metricType: _metricType,
  venueHandle,
  followersUrlOverride,
  onClose,
  onCaptured,
}: Props) {
  const [pasteText, setPasteText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<CaptureResult | null>(null)

  const followersUrl = followersUrlOverride
    ? followersUrlOverride
    : venueHandle
      ? `https://www.instagram.com/${venueHandle}/followers/`
      : 'https://www.instagram.com/'

  async function submit() {
    if (!pasteText.trim()) {
      setError('Paste your handles first.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const resp = await fetch('/api/intel/social-integration/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: 'instagram',
          metric_type: 'new_followers',
          source_text: pasteText,
        }),
      })
      if (!resp.ok) {
        const j = (await resp.json().catch(() => null)) as { error?: string; message?: string } | null
        setError(j?.message ?? j?.error ?? 'Capture failed')
        return
      }
      const j = (await resp.json()) as CaptureResult
      setResult(j)
      onCaptured?.(j)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl space-y-5 rounded-t-2xl bg-white p-6 shadow-2xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between">
          <div>
            <h2 className="font-serif text-xl text-stone-900">
              Capture Instagram new followers
            </h2>
            <p className="mt-1 text-sm text-stone-500">
              Instagram does not expose followers via API. We capture the
              list manually and match it against couples already in your
              pipeline.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-stone-400 hover:bg-stone-100"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {result ? (
          <ResultView result={result} onClose={onClose} />
        ) : (
          <>
            {/* Step 1 */}
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">
                Step 1 — Open Instagram
              </h3>
              <a
                href={followersUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-md bg-sage-600 px-4 py-2 text-sm text-white transition hover:bg-sage-700"
              >
                Open Instagram followers list
                <ExternalLink className="h-4 w-4" />
              </a>
              <p className="text-xs text-stone-500">
                We&apos;ll wait here while you grab the data.
              </p>
            </section>

            {/* Step 2 */}
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">
                Step 2 — Grab the handles
              </h3>
              <ol className="ml-4 list-decimal space-y-2 text-sm text-stone-700">
                <li>
                  Scroll through the followers list to load the names you
                  want to capture (Instagram lazy-loads, so scroll until
                  &ldquo;Loading…&rdquo; stops).
                </li>
                <li>
                  Right-click → Inspect → Console. Paste this snippet and
                  press Enter. The output copies to your clipboard.
                  <pre className="mt-1 overflow-x-auto rounded-md bg-stone-900 p-3 text-[11px] text-stone-100">
                    <code>{SNIPPET}</code>
                  </pre>
                </li>
                <li>Paste below.</li>
              </ol>

              <details className="rounded-md border border-stone-200 bg-stone-50 p-3 text-xs text-stone-600">
                <summary className="cursor-pointer text-stone-700">
                  <ImageIcon className="mr-1 inline h-3 w-3" />
                  Or screenshot the followers list and paste the image
                </summary>
                <p className="mt-2 text-stone-500">
                  Image OCR capture is coming in V1.1. For now, please
                  use the text-paste path.
                </p>
                <input
                  type="file"
                  accept="image/*"
                  disabled
                  className="mt-2 block w-full cursor-not-allowed text-xs text-stone-400"
                />
              </details>
            </section>

            {/* Step 3 */}
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">
                Step 3 — Paste handles
              </h3>
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder={'rosie.hoyle\njen_bee\nmconn\n…'}
                rows={8}
                className="w-full rounded-md border border-stone-200 bg-white p-3 text-sm text-stone-800 focus:border-sage-500 focus:outline-none focus:ring-1 focus:ring-sage-500"
                disabled={submitting}
              />

              {error ? (
                <p className="text-sm text-rose-600">{error}</p>
              ) : null}

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md px-4 py-2 text-sm text-stone-600 hover:bg-stone-100"
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submit}
                  disabled={submitting || !pasteText.trim()}
                  className="inline-flex items-center gap-2 rounded-md bg-sage-600 px-4 py-2 text-sm text-white transition hover:bg-sage-700 disabled:opacity-50"
                >
                  {submitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  Capture
                </button>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  )
}

function ResultView({
  result,
  onClose,
}: {
  result: CaptureResult
  onClose: () => void
}) {
  const inReview = result.candidates
  return (
    <div className="space-y-4">
      <div className="rounded-md border border-sage-200 bg-sage-50 p-4 text-sm text-sage-900">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-sage-700" />
          <strong className="font-medium">Capture saved.</strong>
        </div>
        <p className="mt-1 text-sage-800">
          {result.total} handles parsed · {result.attached} attached to a
          couple you already have · {result.minted} became a new record ·{' '}
          {inReview} in review · {result.fragments} waiting for an identity.
        </p>
        {result.duplicates > 0 ? (
          <p className="mt-1 text-xs text-sage-700">
            {result.duplicates} were already on the timeline from an earlier
            capture, so nothing was added twice.
          </p>
        ) : null}
        {result.skipped > 0 ? (
          <p className="mt-1 text-xs text-sage-700">
            {result.skipped} rows were not usable handles and were left alone.
          </p>
        ) : null}
      </div>

      <p className="text-xs text-stone-500">
        A handle on its own is not a name. Bloom attaches it when it knows
        whose handle it is, and holds it as a fragment when it does not.
        Nothing here is a guess.
      </p>

      {result.samples.length > 0 ? (
        <section>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
            What happened to each handle
          </h4>
          <ul className="max-h-64 divide-y divide-stone-100 overflow-y-auto rounded-md border border-stone-200 bg-white">
            {result.samples.map((s) => (
              <li
                key={s.handle}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium text-stone-800">
                    {s.couple_name ?? s.display_name ?? `@${s.handle}`}
                  </div>
                  <div className="truncate text-xs text-stone-500">@{s.handle}</div>
                </div>
                <OutcomeBadge sample={s} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md bg-sage-600 px-4 py-2 text-sm text-white hover:bg-sage-700"
        >
          Done
        </button>
      </div>
    </div>
  )
}

/** Plain English, not a confidence number. A candidate is in review and a
 *  fragment is waiting; neither is a match, and neither should look like
 *  one. */
function OutcomeBadge({ sample }: { sample: SpineSample }) {
  const label =
    sample.outcome === 'attached'
      ? 'Attached'
      : sample.outcome === 'minted'
        ? 'New record'
        : sample.outcome === 'duplicate'
          ? 'Already known'
          : sample.outcome === 'candidate_medium' || sample.outcome === 'candidate_low'
            ? 'In review'
            : 'Awaiting identity'
  const tone =
    sample.match_status === 'matched'
      ? 'bg-sage-50 text-sage-700'
      : sample.outcome === 'candidate_medium' || sample.outcome === 'candidate_low'
        ? 'bg-gold-50 text-gold-700'
        : 'bg-stone-100 text-stone-600'
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${tone}`}>
      {label}
    </span>
  )
}
