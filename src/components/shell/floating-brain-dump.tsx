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

import { useCallback, useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { createBrowserClient } from '@supabase/ssr'
import { Brain, X, Loader2, Send, CheckCircle2, AlertCircle, Upload } from 'lucide-react'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { useAiName } from '@/lib/hooks/use-ai-name'

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
      // When the route returns needsClarification with a CSV-preview
      // intent, we surface an inline Confirm button so the coordinator
      // doesn't have to navigate to /agent/notifications. Set when
      // intent ends in '_preview' and entryId is present.
      pendingConfirm?: { entryId: string; previewRows: number; intent: string } | null
    }
  | { kind: 'confirming'; entryId: string }
  | { kind: 'error'; message: string }

const BUCKET = 'brain-dump'

function getSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
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
  const [state, setState] = useState<SubmitState>({ kind: 'idle' })

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
      setText((cur) => (cur ? cur : pathPrefillHint(pathname)))
      setOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pathname])

  const reset = useCallback(() => {
    setText('')
    setFile(null)
    setState({ kind: 'idle' })
  }, [])

  // Inline confirm for parked CSV previews. Avoids forcing the
  // coordinator to navigate to /agent/notifications for every large
  // CSV upload — the same pipeline that runs small CSVs inline runs
  // here when called.
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
      const data = (await res.json()) as { id: string; status: string; importSummary?: ImportSummaryShape }
      setState({
        kind: 'done',
        intent: 'imported',
        clarification: null,
        importSummary: data.importSummary ?? null,
        pendingConfirm: null,
      })
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Confirm failed',
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
        const supabase = getSupabase()
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
      }
      // Detect a large-CSV preview parked for confirmation. The route's
      // CSV fast-path produces intents like 'platform_activity_preview',
      // 'leads_preview', etc. when row count > LARGE_CSV_ROW_THRESHOLD.
      const isCsvPreview =
        data.needsClarification === true &&
        typeof data.intent === 'string' &&
        data.intent.endsWith('_preview') &&
        typeof data.entryId === 'string' &&
        typeof data.previewRows === 'number'
      setState({
        kind: 'done',
        intent: data.intent ?? 'unknown',
        clarification: data.clarificationQuestion ?? null,
        importSummary: data.importSummary ?? null,
        pendingConfirm: isCsvPreview
          ? { entryId: data.entryId!, previewRows: data.previewRows!, intent: data.intent }
          : null,
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
          // has context. Only fires when the textarea is empty (don't
          // stomp on a coordinator's in-progress draft from another
          // open + close + reopen cycle). ARCH-20.5.5.
          setText((cur) => (cur ? cur : pathPrefillHint(pathname)))
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
                {state.pendingConfirm ? (
                  // Inline confirm path: large CSV detected, parked
                  // for confirmation. Coordinator confirms here
                  // instead of navigating to Notifications.
                  <div className="flex items-start gap-2 bg-sage-50 border border-sage-200 rounded-lg px-3 py-2">
                    <CheckCircle2 className="w-4 h-4 text-sage-600 mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-sage-900">
                        Detected {state.pendingConfirm.intent.replace(/_preview$/, '').replace(/_/g, ' ')} ·{' '}
                        {state.pendingConfirm.previewRows.toLocaleString()} rows
                      </p>
                      <p className="text-xs text-sage-700 mt-1">
                        Confirm to import. {aiName} will cluster signals + match candidates against existing leads.
                      </p>
                      <div className="flex gap-2 mt-2">
                        <button
                          onClick={() => confirmImport(state.pendingConfirm!.entryId)}
                          className="text-xs px-3 py-1.5 bg-sage-600 text-white rounded-lg hover:bg-sage-700"
                        >
                          Confirm import
                        </button>
                        <button
                          onClick={reset}
                          className="text-xs px-3 py-1.5 border border-sage-200 rounded-lg text-sage-700 hover:bg-sage-100"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  </div>
                ) : state.clarification ? (
                  <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-amber-900">Needs clarification</p>
                      <p className="text-xs text-amber-800 mt-1">{state.clarification}</p>
                      <p className="text-xs text-amber-700 mt-2">
                        Check the Notifications page to resolve.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-2 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-emerald-900">Filed.</p>
                      <p className="text-xs text-emerald-800 mt-1">
                        Classified as <strong>{state.intent.replace(/_/g, ' ')}</strong>.
                      </p>
                      {state.importSummary && (
                        <div className="mt-2 text-xs text-emerald-800 space-y-0.5">
                          <p>
                            {state.importSummary.inserted} new · {state.importSummary.skipped} skipped
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
                  onChange={(e) => setText(e.target.value)}
                  placeholder={`Type anything — "Jamie was stressed about seating today", "May 1st cancelled", "Sarah nailed the Henderson walkthrough"`}
                  className="w-full px-3 py-2 border border-sage-200 rounded-lg text-sm"
                  autoFocus
                />
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 px-3 py-2 text-xs text-sage-600 border border-dashed border-sage-200 rounded-lg cursor-pointer hover:bg-sage-50">
                    <Upload className="w-3.5 h-3.5" />
                    {file ? file.name : 'Attach file'}
                    <input
                      type="file"
                      onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                      className="hidden"
                    />
                  </label>
                  {file && (
                    <button
                      onClick={() => setFile(null)}
                      className="text-xs text-rose-600 hover:underline"
                    >
                      Remove
                    </button>
                  )}
                </div>
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
