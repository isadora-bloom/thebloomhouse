'use client'

/**
 * Capture modal for /intel/social-integration.
 *
 * Step 1 -- Link out: open instagram.com/<handle>/followers/ in a new
 *           tab. The button is gated on the venue_handle from
 *           platform_configs (passed in by the parent page).
 * Step 2 -- Instructions: numbered list with the copy-paste JS snippet
 *           the operator runs in their browser console, plus a
 *           screenshot upload as the alternative.
 * Step 3 -- Paste area: a textarea + submit. POSTs to
 *           /api/intel/social-integration/capture and renders the
 *           result inline (matched count, pre-inquiry surfaced, samples).
 *
 * NOVEMBER-PLAN.md wave 6 (W41): the screenshot file input used to be
 * disabled with a "coming in V1.1" label. It is live now -- one or more
 * JPEG/PNG/WebP files, <=10 MB each, POST as multipart/form-data to the
 * same route. The server resizes, runs vision extraction, and hands the
 * rows through the identical spine path a paste uses, so the result
 * view below is shared between both capture modes without a fork: a
 * screenshot row and a pasted row render the same "what happened to
 * each handle" list.
 *
 * The modal is self-contained so the parent page does not own the
 * fetch + result state. After submit, the modal stays open showing the
 * result; the operator closes it manually and the parent refreshes.
 */

import { useRef, useState } from 'react'
import Link from 'next/link'
import { ExternalLink, X, Loader2, CheckCircle2, Sparkles, Image as ImageIcon, AlertTriangle } from 'lucide-react'

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

/** Per-image outcome, screenshot mode only. */
interface ImageOutcome {
  filename: string
  ok: boolean
  error?: string
  rowCount: number
  invalidCount: number
  rejected?: 'file_too_large' | 'unsupported_type' | 'empty_file'
}

/** A row the model returned that did not validate -- shown, never
 *  silently dropped. */
interface InvalidVisionRow {
  index: number
  reason: string
  handle_hint: string | null
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
  /** Screenshot mode only. */
  images?: ImageOutcome[]
  visionInvalid?: { count: number; samples: InvalidVisionRow[] }
}

const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_IMAGES = 6

interface Props {
  platform: 'instagram' | 'tiktok' | 'facebook' | 'pinterest'
  metricType: string
  venueHandle: string | null
  followersUrlOverride: string | null
  onClose: () => void
  onCaptured?: (result: CaptureResult) => void
}

const SNIPPET = `copy([...document.querySelectorAll('a[href*="/"]')].map(a => a.href.split('/').filter(Boolean).pop()).filter(h => h && !h.includes('.')).join('\\n'))`

export function CaptureNowModal({
  platform,
  metricType,
  venueHandle,
  followersUrlOverride,
  onClose,
  onCaptured,
}: Props) {
  const [pasteText, setPasteText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [fileError, setFileError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<CaptureResult | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const followersUrl = followersUrlOverride
    ? followersUrlOverride
    : venueHandle
      ? `https://www.instagram.com/${venueHandle}/followers/`
      : 'https://www.instagram.com/'

  function onFilesSelected(selected: FileList | null) {
    setFileError(null)
    if (!selected || selected.length === 0) return
    const picked = Array.from(selected)
    if (picked.length > MAX_IMAGES) {
      setFileError(`Pick at most ${MAX_IMAGES} screenshots at a time.`)
      return
    }
    const bad = picked.find(
      (f) => !ACCEPTED_IMAGE_TYPES.includes(f.type.toLowerCase()) || f.size > MAX_IMAGE_BYTES,
    )
    if (bad) {
      setFileError(
        !ACCEPTED_IMAGE_TYPES.includes(bad.type.toLowerCase())
          ? `${bad.name} is not a JPEG, PNG or WebP image.`
          : `${bad.name} is over 10 MB.`,
      )
      return
    }
    setFiles(picked)
  }

  function clearFiles() {
    setFiles([])
    setFileError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

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

  async function submitFiles() {
    if (files.length === 0) {
      setFileError('Choose one or more screenshots first.')
      return
    }
    setSubmitting(true)
    setFileError(null)
    setError(null)
    try {
      const form = new FormData()
      form.set('platform', platform)
      form.set('metric_type', metricType)
      for (const f of files) form.append('files', f)

      const resp = await fetch('/api/intel/social-integration/capture', {
        method: 'POST',
        body: form,
      })
      if (!resp.ok) {
        const j = (await resp.json().catch(() => null)) as { error?: string; message?: string } | null
        setFileError(j?.message ?? j?.error ?? 'Capture failed')
        return
      }
      const j = (await resp.json()) as CaptureResult
      setResult(j)
      onCaptured?.(j)
    } catch (e) {
      setFileError((e as Error).message)
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

              <details className="rounded-md border border-stone-200 bg-stone-50 p-3 text-xs text-stone-600" open={files.length > 0}>
                <summary className="cursor-pointer text-stone-700">
                  <ImageIcon className="mr-1 inline h-3 w-3" />
                  Or upload a screenshot instead
                </summary>
                <p className="mt-2 text-stone-500">
                  Can&apos;t copy the list as text (story viewers, DMs)?
                  Screenshot it and upload the image -- Bloom reads the
                  handles off the picture and captures them the same way.
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  onChange={(e) => onFilesSelected(e.target.files)}
                  disabled={submitting}
                  className="mt-2 block w-full text-xs text-stone-600 file:mr-2 file:rounded file:border-0 file:bg-sage-100 file:px-2 file:py-1 file:text-sage-700"
                />
                {files.length > 0 ? (
                  <div className="mt-2 space-y-1">
                    <p className="text-stone-600">
                      {files.length} image{files.length === 1 ? '' : 's'} selected (
                      {(files.reduce((sum, f) => sum + f.size, 0) / (1024 * 1024)).toFixed(1)} MB)
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={submitFiles}
                        disabled={submitting}
                        className="inline-flex items-center gap-1 rounded-md bg-sage-600 px-3 py-1.5 text-xs text-white transition hover:bg-sage-700 disabled:opacity-50"
                      >
                        {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                        Capture from screenshots
                      </button>
                      <button
                        type="button"
                        onClick={clearFiles}
                        disabled={submitting}
                        className="text-stone-500 hover:underline"
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                ) : null}
                {fileError ? (
                  <p className="mt-2 flex items-center gap-1 text-rose-600">
                    <AlertTriangle className="h-3 w-3" /> {fileError}
                  </p>
                ) : null}
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
        <Link
          href={`/intel/social-integration/captures/${result.captureId}`}
          className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-sage-700 hover:underline"
        >
          View this capture&apos;s full detail
          <ExternalLink className="h-3 w-3" />
        </Link>
      </div>

      {result.images && result.images.length > 0 ? (
        <section className="rounded-md border border-stone-200 bg-white p-3 text-xs text-stone-600">
          <h4 className="mb-1 font-semibold uppercase tracking-wide text-stone-500">
            Screenshots
          </h4>
          <ul className="space-y-1">
            {result.images.map((img, i) => (
              <li key={`${img.filename}-${i}`} className="flex items-center justify-between gap-2">
                <span className="truncate">{img.filename}</span>
                {img.rejected ? (
                  <span className="shrink-0 text-rose-600">
                    Skipped ({img.rejected === 'file_too_large' ? 'over 10 MB' : img.rejected === 'unsupported_type' ? 'not a supported image' : 'empty file'})
                  </span>
                ) : !img.ok ? (
                  <span className="shrink-0 text-rose-600">{img.error ?? 'Could not process'}</span>
                ) : (
                  <span className="shrink-0 text-stone-500">
                    {img.rowCount} row{img.rowCount === 1 ? '' : 's'}
                    {img.invalidCount > 0 ? `, ${img.invalidCount} unusable` : ''}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {result.visionInvalid && result.visionInvalid.count > 0 ? (
        <section className="rounded-md border border-gold-200 bg-gold-50 p-3 text-xs text-gold-800">
          <div className="flex items-center gap-1 font-semibold uppercase tracking-wide text-gold-700">
            <AlertTriangle className="h-3 w-3" />
            {result.visionInvalid.count} row{result.visionInvalid.count === 1 ? '' : 's'} the model returned did not validate
          </div>
          <p className="mt-1 text-gold-700">
            Nothing here was written. These rows are shown, not dropped silently.
          </p>
          <ul className="mt-1 space-y-0.5">
            {result.visionInvalid.samples.map((r, i) => (
              <li key={i}>
                {r.handle_hint ? `@${r.handle_hint}` : `row ${r.index + 1}`} — {r.reason}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
