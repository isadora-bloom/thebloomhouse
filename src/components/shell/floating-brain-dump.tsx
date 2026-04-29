'use client'

/**
 * Floating "Tell Sage something" capture button — Phase 2.5 Task 26.
 *
 * Mounts on every platform page (not standalone routes). On click: opens a
 * modal with a free-text area + optional file drop-zone. Submits to
 * /api/brain-dump which classifies + routes.
 *
 * White-label: button + modal copy read ai_name from the current venue's
 * venue_ai_config. A venue that renamed to "Ivy" sees "Tell Ivy
 * something". Per memory the couple portal does this via useCoupleContext
 * — the platform side doesn't have an analogous context yet, so we fetch
 * ai_name once when the component mounts and venueId resolves.
 */

import { useCallback, useEffect, useState } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import { Brain, X, Loader2, Send, CheckCircle2, AlertCircle, Upload } from 'lucide-react'
import { useVenueId } from '@/lib/hooks/use-venue-id'

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
    }
  | { kind: 'error'; message: string }

const BUCKET = 'brain-dump'

function getSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

export function FloatingBrainDump() {
  const venueId = useVenueId()
  const [aiName, setAiName] = useState<string>('Sage')
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [state, setState] = useState<SubmitState>({ kind: 'idle' })

  // Resolve the venue's AI assistant name once. Fallback to Sage on miss.
  useEffect(() => {
    if (!venueId) return
    const supabase = getSupabase()
    ;(async () => {
      const { data } = await supabase
        .from('venue_ai_config')
        .select('ai_name')
        .eq('venue_id', venueId)
        .maybeSingle()
      const name = (data?.ai_name as string | null)?.trim()
      if (name) setAiName(name)
    })()
  }, [venueId])

  const reset = useCallback(() => {
    setText('')
    setFile(null)
    setState({ kind: 'idle' })
  }, [])

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
        rawText = `${rawText}\n\n[Attached file: ${file.name} (${file.type || 'unknown'}) stored at ${path}]`
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
        intent: string
        clarificationQuestion?: string | null
        importSummary?: ImportSummaryShape | null
      }
      setState({
        kind: 'done',
        intent: data.intent ?? 'unknown',
        clarification: data.clarificationQuestion ?? null,
        importSummary: data.importSummary ?? null,
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
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-40 w-14 h-14 rounded-full shadow-lg flex items-center justify-center bg-sage-600 hover:bg-sage-700 text-white transition-transform hover:scale-105"
        title={`Tell ${aiName} something`}
        aria-label={`Tell ${aiName} something`}
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
                {state.clarification ? (
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
