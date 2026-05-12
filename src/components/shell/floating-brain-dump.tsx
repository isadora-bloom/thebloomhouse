'use client'

/**
 * Floating capture button — Phase 2.5 Task 26.
 *
 * Mounts on every platform page (not standalone routes). On click: opens a
 * modal with a free-text area + optional file drop-zone. Submits to
 * /api/brain-dump which classifies + routes.
 *
 * White-label: button + modal copy read ai_name from useAiName(), which
 * reads from VenueScopeProvider (resolved server-side in (platform)/layout).
 * A venue that renamed to "Ivy" sees "Tell Ivy something". T5-β.2
 * replaced an ad-hoc useEffect fetch with this synchronous hook.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Brain, X, Loader2, Send, CheckCircle2, AlertCircle, Upload, ArrowRight, HelpCircle, Camera } from 'lucide-react'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { useAiName } from '@/lib/hooks/use-ai-name'

/**
 * Confirm-button label per intent. The bubble's pendingConfirm card uses
 * this so a coordinator sees "Add to knowledge base" instead of a
 * generic "Confirm". 2026-05-08 (Isadora feedback).
 */
function confirmLabelFor(intent: string): string {
  if (intent.endsWith('_preview')) return 'Confirm import'
  if (intent === 'client_note') return 'Save to couple'
  if (intent === 'knowledge_base_import') return 'Add to knowledge base'
  if (intent === 'operational_note') return 'File as operational note'
  if (intent === 'availability') return 'Apply availability change'
  if (intent === 'analytics') return 'Import spend rows'
  if (intent === 'staff_observation') return 'Save observation'
  return 'Confirm'
}

interface ImportSummaryShape {
  inserted: number
  updated: number
  skipped: number
  errors: string[]
  phase_b?: {
    candidates_created: number
    candidates_updated: number
    candidates_flagged_for_review: number
    auto_linked_to_wedding: number
    deferred_to_ai: number
    conflicts_flagged: number
    no_match: number
  }
}

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | {
      kind: 'done'
      intent: string
      clarification: string | null
      importSummary?: ImportSummaryShape | null
      // 2026-05-08 (Isadora feedback): inline confirm for ANY
      // actionable propose-and-confirm intent, not just CSV preview.
      // 2026-05-08 #2: also surface dismiss-only inline cards for
      // failure intents (pdf_extract_failed, oversized, etc.) so the
      // coordinator can clear the entry without leaving the bubble.
      pendingConfirm?: {
        entryId: string
        intent: string
        previewRows?: number
        confirmLabel?: string
        // When true, hide the Confirm button and only render Dismiss.
        // For failure shapes (PDF parse failure, oversized payload)
        // there is nothing to confirm but the entry still parks in
        // brain_dump_entries.parse_status='needs_clarification'.
        dismissOnly?: boolean
        // Bug 17 (2026-05-09). PDF preview only — flag that the
        // extractor hit the 50K-char cap so the bubble can render an
        // explicit "this PDF was truncated" hint above Confirm.
        pdfTruncated?: boolean
      } | null
      // Deep-link destination for "go where this lives now" affordance.
      nextHref?: string | null
      nextLabel?: string | null
      // Q&A help-mode answer (intent='help_question'). Bubble renders
      // the answer + clickable link tiles.
      helpAnswer?: { body: string; links: Array<{ label: string; href: string }> } | null
      // PDF confirm post-result fields (Case J in resolve route).
      // 'csv_import' = headers detected and runCsvImport ran;
      // 'text_classifier' = extracted text fed to classifyBrainDump.
      pdfRoute?: 'csv_import' | 'text_classifier' | null
      classifierIntent?: string | null
      classifierConfidence?: number | null
      // Coordinator-facing summary headline: composed from the
      // shape of the import (eg "Imported 287 leads" / "Created
      // knowledge base entries" / "Filed as ambiguous"). Falls
      // back to "Filed." when nothing more specific applies.
      summaryHeadline?: string | null
    }
  | { kind: 'confirming'; entryId: string }
  | { kind: 'error'; message: string }

const BUCKET = 'brain-dump'

/**
 * Compose a coordinator-friendly headline for the success card based
 * on the confirm response shape. Pre-fix the bubble said "Filed."
 * for every confirm regardless of whether 1 or 287 rows landed in
 * the database. Coordinator had no signal that a 43-page PDF
 * actually became 287 weddings + 18 matched + 7 ambiguous.
 *
 * Headlines key off the import shape, the PDF route, the classifier
 * intent, and how many rows were touched. Falls back to "Filed."
 * when nothing more specific applies (like a plain client_note
 * confirm).
 */
function summarizeConfirmResult(args: {
  intent: string
  importSummary?: ImportSummaryShape | null
  pdfRoute?: 'csv_import' | 'text_classifier' | null
  classifierIntent?: string | null
}): string {
  const { intent, importSummary, pdfRoute, classifierIntent } = args
  const inserted = importSummary?.inserted ?? 0
  const updated = importSummary?.updated ?? 0
  const total = inserted + updated

  // PDF that ran through the CSV-shape path: usually a spreadsheet
  // or triage sheet. Show the row count.
  if (pdfRoute === 'csv_import') {
    if (total === 0) {
      return 'PDF imported. No rows matched the detected shape.'
    }
    if (intent.includes('lead') || intent.includes('couple') || intent.includes('client')) {
      return `Imported ${total.toLocaleString()} couple${total === 1 ? '' : 's'} from the spreadsheet.`
    }
    if (intent.includes('review')) {
      return `Imported ${total.toLocaleString()} review${total === 1 ? '' : 's'}.`
    }
    return `Imported ${total.toLocaleString()} row${total === 1 ? '' : 's'} from the spreadsheet.`
  }

  // PDF that fed the regular text classifier — the bubble's classifier
  // intent tells the coordinator how it was filed.
  if (pdfRoute === 'text_classifier' && classifierIntent) {
    return `PDF text classified as ${classifierIntent.replace(/_/g, ' ')}.`
  }

  // CSV import (top-level kind, not via PDF).
  if (intent.endsWith('_preview') && total > 0) {
    const noun = intent.replace(/_preview$/, '').replace(/_/g, ' ')
    return `Imported ${total.toLocaleString()} ${noun} row${total === 1 ? '' : 's'}.`
  }

  // Knowledge-base or operational confirm.
  if (intent === 'knowledge_base_import') {
    return inserted > 0 ? `Added ${inserted} Q/A entr${inserted === 1 ? 'y' : 'ies'} to the knowledge base.` : 'Knowledge base entries filed.'
  }
  if (intent === 'operational_note') return 'Operational note filed.'
  if (intent === 'staff_observation') return 'Staff observation filed.'
  if (intent === 'analytics') return total > 0 ? `Imported ${total} marketing-spend row${total === 1 ? '' : 's'}.` : 'Analytics filed.'
  if (intent === 'availability') return 'Availability change applied.'
  if (intent === 'client_note') return 'Note added to the couple.'
  if (intent === 'imported') return total > 0 ? `Imported ${total} row${total === 1 ? '' : 's'}.` : 'Filed.'
  if (intent === 'dismissed') return 'Dismissed.'

  return 'Filed.'
}



/**
 * Pre-fill hint derived from the current pathname (ARCH-20.5.5).
 * Captures what the coordinator was looking at when they opened the
 * dump so the LLM classifier has context — e.g., "About this client:"
 * if they were on a wedding detail page. Pre-fix the text always
 * initialised empty regardless of where Cmd+K fired from.
 */
function pathPrefillHint(pathname: string | null): string {
  if (!pathname) return ''
  // Capture wedding id from /intel/clients/<uuid> or
  // /agent/leads/<uuid>; the dump's classifier resolves the client
  // by name normally, but a path-derived hint anchors the parser
  // when the coordinator's note doesn't name the couple.
  const clientMatch = pathname.match(/\/(?:intel\/clients|agent\/clients)\/([0-9a-f-]{36})/i)
  if (clientMatch) return 'About this client: '
  if (pathname.startsWith('/agent/leads')) return 'About a lead: '
  if (pathname.startsWith('/agent/pipeline')) return 'About the pipeline: '
  if (pathname.startsWith('/agent/learning')) return 'Voice/style note: '
  if (pathname.startsWith('/intel/sources')) return 'Marketing-spend or source note: '
  if (pathname.startsWith('/intel/cultural-moments')) return 'Cultural moment to add: '
  return ''
}

export function FloatingBrainDump() {
  const venueId = useVenueId()
  const pathname = usePathname()
  // Synchronous read from VenueScopeProvider — no flash, no race. Falls
  // back to a neutral noun phrase when venue_ai_config.ai_name is missing.
  // T5-β.2.
  const aiName = useAiName()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [captureError, setCaptureError] = useState<string | null>(null)

  /**
   * Capture a single frame from a browser tab (or window/screen) via the
   * Screen Capture API and attach it as a PNG File to the brain-dump.
   * Lets the coordinator screenshot Knot / Instagram / Pinterest / X /
   * TikTok / Facebook content without leaving the page.
   *
   * Browser support: getDisplayMedia is in every modern desktop browser.
   * Mobile is best-effort; the button renders regardless and the API
   * call's NotAllowedError / NotSupportedError surface as an inline hint
   * so the operator knows to fall back to the file-upload path.
   */
  const captureTab = useCallback(async () => {
    if (capturing) return
    setCaptureError(null)
    setCapturing(true)
    let stream: MediaStream | null = null
    try {
      // The browser opens an OS picker listing tabs / windows / screens.
      // We pass preferCurrentTab=false so the picker defaults to the
      // tab-list view (most common for socials screenshots).
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser' } as MediaTrackConstraints,
        audio: false,
        // preferCurrentTab is a Chrome-only hint; left unset so the
        // picker shows all sources.
      })
      const [track] = stream.getVideoTracks()
      if (!track) throw new Error('No video track in capture stream')

      // ImageCapture is the cleanest path on Chromium. Safari + Firefox
      // need the video-element + canvas fallback. Try ImageCapture first.
      let blob: Blob | null = null
      const ImageCaptureCtor = (window as unknown as {
        ImageCapture?: new (track: MediaStreamTrack) => { grabFrame: () => Promise<ImageBitmap> }
      }).ImageCapture
      if (ImageCaptureCtor) {
        try {
          const imageCapture = new ImageCaptureCtor(track)
          const bitmap = await imageCapture.grabFrame()
          const canvas = document.createElement('canvas')
          canvas.width = bitmap.width
          canvas.height = bitmap.height
          const ctx = canvas.getContext('2d')
          if (!ctx) throw new Error('canvas 2d context unavailable')
          ctx.drawImage(bitmap, 0, 0)
          blob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, 'image/png'),
          )
        } catch {
          // Fall through to the video-element path.
        }
      }
      if (!blob) {
        // Fallback: pump the stream into an off-DOM <video>, wait for
        // the first frame, paint to canvas, export.
        const video = document.createElement('video')
        video.srcObject = stream
        video.muted = true
        await video.play()
        // Allow one paint tick so the frame is real, not a black box.
        await new Promise((r) => requestAnimationFrame(() => r(null)))
        const canvas = document.createElement('canvas')
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('canvas 2d context unavailable')
        ctx.drawImage(video, 0, 0)
        blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/png'),
        )
      }
      if (!blob) throw new Error('Capture produced no image data')

      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const captured = new File([blob], `screenshot-${stamp}.png`, {
        type: 'image/png',
      })
      setFile(captured)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Capture failed'
      // NotAllowedError + AbortError happen when the operator cancels
      // the picker. Don't surface those as errors.
      if (
        err instanceof DOMException &&
        (err.name === 'NotAllowedError' || err.name === 'AbortError')
      ) {
        // user dismissed picker — silent
      } else {
        setCaptureError(msg)
      }
    } finally {
      if (stream) stream.getTracks().forEach((t) => t.stop())
      setCapturing(false)
    }
  }, [capturing])
  const [state, setState] = useState<SubmitState>({ kind: 'idle' })
  // Bug 9 (2026-05-09). Tracks whether the coordinator typed or pasted
  // in this open lifecycle. Once true, reopen does NOT re-prefill the
  // path-derived hint, even when textarea contents look "empty-ish"
  // mid-paste. Reset on close + reset. Pre-fix the hint could prepend
  // into an in-flight paste because the lazy useState initialiser
  // evaluated AFTER the keystroke that triggered open, racing with a
  // fast paste.
  const hasUserTypedRef = useRef(false)

  /**
   * Decide whether to apply the path-derived prefill hint. Only when
   * the textarea is empty AND the coordinator hasn't typed/pasted in
   * the current open lifecycle.
   */
  const maybePrefill = useCallback(() => {
    setText((cur) => {
      if (cur) return cur
      if (hasUserTypedRef.current) return cur
      return pathPrefillHint(pathname)
    })
  }, [pathname])

  // Global Cmd+K / Ctrl+K opens the brain-dump from any work surface
  // with a context-aware pre-fill (ARCH-20.5.5). Skipped when an
  // input/textarea/contenteditable already has focus — coordinators
  // typing in another field shouldn't be hijacked.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isShortcut = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'
      if (!isShortcut) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      const isEditable = tag === 'input' || tag === 'textarea' || target?.isContentEditable
      if (isEditable) return
      e.preventDefault()
      maybePrefill()
      setOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [maybePrefill])

  const reset = useCallback(() => {
    setText('')
    setFile(null)
    setState({ kind: 'idle' })
    hasUserTypedRef.current = false
  }, [])

  // Inline confirm for any propose-and-confirm intent (CSV preview,
  // client_note, knowledge_base_import, operational_note, availability,
  // analytics, vision storefront analytics, etc.). Pre-fix this only
  // handled CSV previews and pushed the coordinator to /agent/notifications
  // for everything else. 2026-05-08 (Isadora feedback) extended this to
  // every needs_clarification + entryId response.
  async function confirmImport(entryId: string) {
    setState({ kind: 'confirming', entryId })
    try {
      const res = await fetch(`/api/brain-dump/${entryId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm' }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      const data = (await res.json()) as {
        id: string
        status: string
        importSummary?: ImportSummaryShape
        nextHref?: string | null
        nextLabel?: string | null
        pdfRoute?: 'csv_import' | 'text_classifier'
        classifierIntent?: string
        classifierConfidence?: number
      }
      const headline = summarizeConfirmResult({
        intent: 'imported',
        importSummary: data.importSummary,
        pdfRoute: data.pdfRoute,
        classifierIntent: data.classifierIntent,
      })
      setState({
        kind: 'done',
        intent: 'imported',
        clarification: null,
        importSummary: data.importSummary ?? null,
        pendingConfirm: null,
        nextHref: data.nextHref ?? null,
        nextLabel: data.nextLabel ?? null,
        pdfRoute: data.pdfRoute ?? null,
        classifierIntent: data.classifierIntent ?? null,
        classifierConfidence: data.classifierConfidence ?? null,
        summaryHeadline: headline,
      })
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Confirm failed',
      })
    }
  }

  // Dismiss a parked propose-and-confirm entry. Mirror of confirmImport
  // but action='dismiss' — the resolve route stamps parse_status=dismissed
  // without writing anything. 2026-05-08.
  async function dismissEntry(entryId: string) {
    setState({ kind: 'confirming', entryId })
    try {
      const res = await fetch(`/api/brain-dump/${entryId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dismiss' }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      setState({
        kind: 'done',
        intent: 'dismissed',
        clarification: null,
        importSummary: null,
        pendingConfirm: null,
      })
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Dismiss failed',
      })
    }
  }

  const close = useCallback(() => {
    setOpen(false)
    // keep the last completion visible for a beat if the coordinator
    // reopens, but clear when they close the modal.
    setTimeout(reset, 250)
  }, [reset])

  async function handleSubmit() {
    if (!venueId || !text.trim()) return
    setState({ kind: 'submitting' })

    // File pre-processing is future work (OCR / CSV parse / PDF text).
    // For now, if a file is attached we upload it to the brain-dump
    // bucket and include the storage path as a reference in rawText so
    // the classifier can flag it for analytics/image handling later.
    let rawText = text.trim()
    let inputType: 'text' | 'image' | 'pdf' | 'csv' = 'text'
    if (file) {
      try {
        // Client-side size guard (GAP H4): reject before uploading so
        // the Vercel function never downloads a file it cannot process.
        // Mirror of the server-side FILE_SIZE_CAP_BYTES (5 MB).
        const MAX_BYTES = 5 * 1024 * 1024
        if (file.size > MAX_BYTES) {
          setState({
            kind: 'error',
            message: `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum size is 5 MB. Trim the file or paste the relevant section as text.`,
          })
          return
        }
        const supabase = createClient()
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
        const path = `${venueId}/${crypto.randomUUID()}-${safeName}`
        const { error: upErr } = await supabase.storage
          .from(BUCKET)
          .upload(path, file, { contentType: file.type || undefined })
        if (upErr) throw upErr
        // JSON-encoded marker so user-controlled filenames (parens,
        // brackets, quotes, etc.) don't collide with the marker's
        // outer delimiter. The route's extractAttachmentMeta parses
        // this structured form first, falling back to the legacy
        // free-text form for compatibility.
        const meta = JSON.stringify({ name: file.name, type: file.type || 'unknown', path })
        rawText = `${rawText}\n\n[Attached file: ${meta}]`
        if (file.type.startsWith('image/')) inputType = 'image'
        else if (file.type === 'application/pdf') inputType = 'pdf'
        else if (file.type === 'text/csv' || file.name.endsWith('.csv')) inputType = 'csv'
      } catch (err) {
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'File upload failed',
        })
        return
      }
    }

    try {
      const res = await fetch('/api/brain-dump', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawText, inputType }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      const data = (await res.json()) as {
        entryId?: string
        intent: string
        clarificationQuestion?: string | null
        importSummary?: ImportSummaryShape | null
        needsClarification?: boolean
        previewRows?: number
        nextHref?: string | null
        nextLabel?: string | null
        helpAnswer?: { body: string; links: Array<{ label: string; href: string }> } | null
        // Bug 17 (2026-05-09). PDF preview branch returns this when
        // the 50K-char cap was hit. The bubble surfaces an explicit
        // hint so the coordinator knows the rest of the file is
        // sitting in storage waiting on a follow-up.
        pdfTruncated?: boolean
      }
      // 2026-05-08 (Isadora feedback): inline-confirm every propose-and-
      // confirm intent, not just CSV previews. Any time the route returns
      // needsClarification + an entryId, surface Confirm/Dismiss in the
      // bubble. The resolve route already handles every parked shape
      // (Cases A-F).
      // Failure intents have nothing to confirm but still need to be
      // dismissable from the bubble — Isadora explicitly asked for
      // pdf_extract_failed to be resolvable inline, not via the
      // notifications page.
      const failureIntents = new Set([
        'pdf_extract_failed',
        'pdf_oversized',
        'url_google_doc_deferred',
        'json_parse_failed',
        'json_contract_violation',
        'duplicate_upload',
      ])
      const isFailureIntent =
        typeof data.intent === 'string' && failureIntents.has(data.intent)
      const canInlineConfirm =
        data.needsClarification === true &&
        typeof data.entryId === 'string' &&
        typeof data.intent === 'string' &&
        // Help-mode never goes through propose-and-confirm — it's a Q&A
        // surface. Skip pendingConfirm so the answer card renders instead.
        data.intent !== 'help_question' &&
        !isFailureIntent
      // Failure intents get an inline Dismiss-only card so the entry
      // does not vanish into /agent/notifications without a path back.
      const canDismissInline =
        data.needsClarification === true &&
        typeof data.entryId === 'string' &&
        isFailureIntent
      setState({
        kind: 'done',
        intent: data.intent ?? 'unknown',
        clarification: data.clarificationQuestion ?? null,
        importSummary: data.importSummary ?? null,
        pendingConfirm: canInlineConfirm
          ? {
              entryId: data.entryId!,
              intent: data.intent,
              previewRows: data.previewRows,
              confirmLabel: confirmLabelFor(data.intent),
              // Bug 17: pass through truncation flag so the bubble can
              // render a "this PDF was truncated" hint.
              pdfTruncated: data.pdfTruncated,
            }
          : canDismissInline
            ? {
                entryId: data.entryId!,
                intent: data.intent,
                dismissOnly: true,
              }
            : null,
        nextHref: data.nextHref ?? null,
        nextLabel: data.nextLabel ?? null,
        helpAnswer: data.helpAnswer ?? null,
      })
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Submit failed',
      })
    }
  }

  return (
    <>
      <button
        onClick={() => {
          // Pre-fill with the path-derived hint so the LLM classifier
          // has context. Only fires when the textarea is empty AND the
          // coordinator hasn't typed/pasted in this open lifecycle. The
          // hasUserTyped guard (Bug 9, 2026-05-09) protects an in-flight
          // paste from being stomped by a hint that fires async after
          // the lazy useState initialiser. ARCH-20.5.5.
          maybePrefill()
          setOpen(true)
        }}
        className="fixed bottom-6 right-6 z-40 w-14 h-14 rounded-full shadow-lg flex items-center justify-center bg-sage-600 hover:bg-sage-700 text-white transition-transform hover:scale-105"
        title={`Tell ${aiName} something (Cmd+K)`}
        aria-label={`Tell ${aiName} something (keyboard shortcut: Cmd K)`}
      >
        <Brain className="w-6 h-6" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={close}
        >
          <div
            className="bg-white rounded-t-2xl sm:rounded-xl shadow-2xl max-w-lg w-full p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div>
                <h2 className="font-heading text-lg font-semibold text-sage-900">
                  Tell {aiName} something
                </h2>
                <p className="text-xs text-sage-500 mt-0.5">
                  A note, an update, a date change, a stats screenshot. {aiName} routes it to the right place.
                </p>
              </div>
              <button
                onClick={close}
                className="p-1 rounded hover:bg-sage-100 text-sage-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {state.kind === 'done' ? (
              <div className="space-y-3 py-2">
                {state.helpAnswer ? (
                  // Help-mode answer: bubble-rendered Q&A with click-
                  // through link tiles. Different success card from
                  // the propose-and-confirm path. 2026-05-08 (Isadora
                  // feedback).
                  <div className="flex items-start gap-2 bg-sky-50 border border-sky-200 rounded-lg px-3 py-2">
                    <HelpCircle className="w-4 h-4 text-sky-600 mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-sky-900">Here's where that lives</p>
                      <p className="text-xs text-sky-800 mt-1 whitespace-pre-line">
                        {state.helpAnswer.body}
                      </p>
                      {state.helpAnswer.links.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {state.helpAnswer.links.map((l, i) => (
                            <Link
                              key={i}
                              href={l.href}
                              onClick={close}
                              className="inline-flex items-center gap-1 text-xs px-2.5 py-1 bg-white border border-sky-300 rounded-md text-sky-700 hover:bg-sky-100 hover:border-sky-400"
                            >
                              {l.label}
                              <ArrowRight className="w-3 h-3" />
                            </Link>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ) : state.pendingConfirm ? (
                  // Inline confirm card: any propose-and-confirm intent
                  // (CSV preview, client_note, knowledge_base_import,
                  // operational_note, availability, analytics, vision
                  // storefront analytics, etc.). Pre-fix only CSV
                  // previews surfaced here. 2026-05-08 (Isadora
                  // feedback) extended to every parked entry, plus
                  // dismiss-only failure intents (PDF parse failure,
                  // oversized payloads) so coordinators never have to
                  // navigate to /agent/notifications to clear an entry.
                  <div className={`flex items-start gap-2 ${state.pendingConfirm.dismissOnly ? 'bg-amber-50 border-amber-200' : 'bg-sage-50 border-sage-200'} border rounded-lg px-3 py-2`}>
                    {state.pendingConfirm.dismissOnly ? (
                      <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                    ) : (
                      <CheckCircle2 className="w-4 h-4 text-sage-600 mt-0.5 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className={`text-sm font-medium ${state.pendingConfirm.dismissOnly ? 'text-amber-900' : 'text-sage-900'}`}>
                        {state.pendingConfirm.intent.endsWith('_preview') &&
                        typeof state.pendingConfirm.previewRows === 'number'
                          ? `Detected ${state.pendingConfirm.intent.replace(/_preview$/, '').replace(/_/g, ' ')}, ${state.pendingConfirm.previewRows.toLocaleString()} rows`
                          : state.clarification
                            ? state.clarification
                            : `Sage parsed this as ${state.pendingConfirm.intent.replace(/_/g, ' ')}`}
                      </p>
                      {state.pendingConfirm.intent.endsWith('_preview') && (
                        <p className="text-xs text-sage-700 mt-1">
                          Confirm to import. {aiName} will cluster signals and match candidates against existing leads.
                        </p>
                      )}
                      {/* Bug 17 (2026-05-09): visible truncation hint
                          on PDF previews so a coordinator who dropped
                          a 200-page brochure knows the rest of the
                          file is in storage waiting on a follow-up. */}
                      {state.pendingConfirm.pdfTruncated && (
                        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-1">
                          Heads up: this PDF was truncated at 50K characters. The rest is in storage; ask {aiName} to summarise the remainder if you need it.
                        </p>
                      )}
                      <div className="flex gap-2 mt-2">
                        {!state.pendingConfirm.dismissOnly && (
                          <button
                            onClick={() => confirmImport(state.pendingConfirm!.entryId)}
                            className="text-xs px-3 py-1.5 bg-sage-600 text-white rounded-lg hover:bg-sage-700"
                          >
                            {state.pendingConfirm.confirmLabel ?? 'Confirm'}
                          </button>
                        )}
                        <button
                          onClick={() => dismissEntry(state.pendingConfirm!.entryId)}
                          className={`text-xs px-3 py-1.5 border rounded-lg ${state.pendingConfirm.dismissOnly ? 'border-amber-300 text-amber-800 hover:bg-amber-100' : 'border-sage-200 text-sage-400 hover:bg-sage-100 hover:text-sage-600'}`}
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  // Bug 12 (2026-05-09): the pre-fix amber clarification
                  // card with "Open Notifications" link is dead code
                  // post-rebuild. Every needsClarification + entryId
                  // path now populates pendingConfirm (confirm or
                  // dismiss-only); help_question populates helpAnswer.
                  // Pure clarification with no action is unreachable —
                  // the success card renders directly here.
                  <div className="flex items-start gap-2 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-emerald-900">
                        {state.summaryHeadline ?? 'Filed.'}
                      </p>
                      <p className="text-xs text-emerald-800 mt-1">
                        Classified as <strong>{state.intent.replace(/_/g, ' ')}</strong>
                        {state.pdfRoute === 'csv_import' && ' via spreadsheet shape detection'}
                        {state.pdfRoute === 'text_classifier' && state.classifierConfidence != null && ` (${state.classifierConfidence}% confidence)`}
                        .
                      </p>
                      {state.importSummary && (
                        <div className="mt-2 text-xs text-emerald-800 space-y-0.5">
                          <p>
                            {state.importSummary.inserted} new
                            {state.importSummary.updated > 0 && ` · ${state.importSummary.updated} updated`}
                            {' · '}{state.importSummary.skipped} skipped
                            {state.importSummary.errors.length > 0 &&
                              ` · ${state.importSummary.errors.length} error${state.importSummary.errors.length === 1 ? '' : 's'}`}
                          </p>
                          {/* Connective II / fix #7: partial-import errors are
                              now expandable inline. Vision + CSV imports
                              sometimes drop rows for constraint reasons —
                              the error strings explain why. Coordinator
                              gets visibility instead of a silent failure
                              count. */}
                          {state.importSummary.errors.length > 0 && (
                            <details className="mt-1">
                              <summary className="cursor-pointer text-[11px] text-amber-800 hover:text-amber-900">
                                See error details ({state.importSummary.errors.length})
                              </summary>
                              <ul className="mt-1 ml-3 space-y-0.5 list-disc list-inside text-[11px] text-amber-700">
                                {state.importSummary.errors.slice(0, 5).map((err, i) => (
                                  <li key={i} className="break-words">{err}</li>
                                ))}
                                {state.importSummary.errors.length > 5 && (
                                  <li className="italic">+ {state.importSummary.errors.length - 5} more</li>
                                )}
                              </ul>
                            </details>
                          )}
                          {state.importSummary.phase_b && (
                            <div className="mt-1 pt-1 border-t border-emerald-200 space-y-0.5 text-emerald-900">
                              <p>
                                <strong>{state.importSummary.phase_b.candidates_created}</strong> new candidates ·{' '}
                                <strong>{state.importSummary.phase_b.auto_linked_to_wedding}</strong> auto-linked to leads
                              </p>
                              {state.importSummary.phase_b.candidates_flagged_for_review > 0 && (
                                <p>
                                  {state.importSummary.phase_b.candidates_flagged_for_review} flagged for review
                                </p>
                              )}
                              {state.importSummary.phase_b.deferred_to_ai > 0 && (
                                <p>{state.importSummary.phase_b.deferred_to_ai} deferred to AI</p>
                              )}
                              {state.importSummary.phase_b.conflicts_flagged > 0 && (
                                <p className="text-amber-800">
                                  {state.importSummary.phase_b.conflicts_flagged} source conflict
                                  {state.importSummary.phase_b.conflicts_flagged === 1 ? '' : 's'} to review
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {/* Deep-link affordance: when the route returned a
                    nextHref for the routed/parked entry, show a small
                    "[label] →" link so the coordinator can open the
                    surface that owns this data. 2026-05-08 (Isadora
                    feedback). Hidden when the help-answer card already
                    rendered link tiles. */}
                {state.nextHref && state.nextLabel && !state.helpAnswer && !state.pendingConfirm && (
                  <Link
                    href={state.nextHref}
                    onClick={close}
                    className="inline-flex items-center gap-1 text-xs text-sage-700 hover:text-sage-900 underline-offset-2 hover:underline"
                  >
                    {state.nextLabel}
                    <ArrowRight className="w-3 h-3" />
                  </Link>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={reset}
                    className="flex-1 px-3 py-2 text-sm text-sage-700 border border-sage-200 rounded-lg hover:bg-sage-50"
                  >
                    Tell {aiName} something else
                  </button>
                  <button
                    onClick={close}
                    className="px-4 py-2 text-sm bg-sage-600 text-white rounded-lg hover:bg-sage-700"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : state.kind === 'confirming' ? (
              <div className="space-y-3 py-2">
                <div className="flex items-start gap-2 bg-sage-50 border border-sage-200 rounded-lg px-3 py-3">
                  <Loader2 className="w-4 h-4 text-sage-600 animate-spin mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-sage-900">Importing…</p>
                    <p className="text-xs text-sage-700 mt-1">
                      Inserting signals, clustering candidates, matching against existing leads. This can take a minute on large files.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <>
                <textarea
                  rows={4}
                  value={text}
                  onChange={(e) => {
                    // Bug 9: any keystroke counts as the user owning
                    // the field for this open lifecycle. Reopen will
                    // not re-prefill once this flips.
                    hasUserTypedRef.current = true
                    setText(e.target.value)
                  }}
                  onPaste={() => {
                    // Bug 9: paste fires before onChange but the new
                    // value isn't in `text` yet. Flip the ref now so a
                    // racing reopen-with-prefill can't prepend the
                    // hint while the paste lands.
                    hasUserTypedRef.current = true
                  }}
                  onKeyDown={() => {
                    // Bug 9: belt-and-suspenders. onKeyDown fires before
                    // onChange so the ref is set even if the keystroke
                    // is async-batched.
                    hasUserTypedRef.current = true
                  }}
                  placeholder={`Type anything — "Jamie was stressed about seating today", "May 1st cancelled", "Sarah nailed the Henderson walkthrough"`}
                  className="w-full px-3 py-2 border border-sage-200 rounded-lg text-sm"
                  autoFocus
                />
                <div className="flex items-center gap-2 flex-wrap">
                  <label className="flex items-center gap-1.5 px-3 py-2 text-xs text-sage-600 border border-dashed border-sage-200 rounded-lg cursor-pointer hover:bg-sage-50">
                    <Upload className="w-3.5 h-3.5" />
                    {file ? file.name : 'Attach file'}
                    <input
                      type="file"
                      onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                      className="hidden"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={captureTab}
                    disabled={capturing}
                    className="flex items-center gap-1.5 px-3 py-2 text-xs text-sage-600 border border-dashed border-sage-200 rounded-lg cursor-pointer hover:bg-sage-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Capture a screenshot of a browser tab or window without leaving this page"
                  >
                    {capturing ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Camera className="w-3.5 h-3.5" />
                    )}
                    {capturing ? 'Capturing…' : 'Capture tab'}
                  </button>
                  {file && (
                    <button
                      onClick={() => setFile(null)}
                      className="text-xs text-rose-600 hover:underline"
                    >
                      Remove
                    </button>
                  )}
                </div>
                {captureError && (
                  <p className="text-xs text-rose-600">
                    Screen capture failed: {captureError}. Try the Attach file path.
                  </p>
                )}
                {state.kind === 'error' && (
                  <p className="text-xs text-rose-600">{state.message}</p>
                )}
                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={close}
                    disabled={state.kind === 'submitting'}
                    className="px-4 py-2 text-sm text-sage-700 hover:bg-sage-100 rounded-lg"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSubmit}
                    disabled={state.kind === 'submitting' || !text.trim()}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm bg-sage-600 text-white rounded-lg hover:bg-sage-700 disabled:opacity-50"
                  >
                    {state.kind === 'submitting' ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Send className="w-4 h-4" />
                    )}
                    Send to {aiName}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}
