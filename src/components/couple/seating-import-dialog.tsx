'use client'

import { useRef, useState } from 'react'
import {
  Upload,
  X,
  CheckCircle,
  AlertCircle,
  Loader2,
  ChevronDown,
  ChevronUp,
  Users,
  FileSpreadsheet,
} from 'lucide-react'
import type { ParsedSeatingChart, ImportedTable } from '@/lib/services/couple-portal/seating-import'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  weddingId: string
  onComplete: () => void  // called after successful commit
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

type Step = 'idle' | 'parsing' | 'preview' | 'committing' | 'done' | 'error'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SeatingImportDialog({ weddingId, onComplete }: Props) {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>('idle')
  const [chart, setChart] = useState<ParsedSeatingChart | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [replaceExisting, setReplaceExisting] = useState(false)
  const [expandedTable, setExpandedTable] = useState<string | null>(null)
  const [commitResult, setCommitResult] = useState<{
    tablesCreated: number
    guestsCreated: number
    guestsUpdated: number
    allergiesCreated: number
  } | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  function reset() {
    setStep('idle')
    setChart(null)
    setErrorMsg(null)
    setReplaceExisting(false)
    setExpandedTable(null)
    setCommitResult(null)
  }

  function close() {
    setOpen(false)
    reset()
  }

  async function handleFile(file: File) {
    setStep('parsing')
    setErrorMsg(null)

    const fd = new FormData()
    fd.append('file', file)
    fd.append('action', 'parse')

    try {
      const res = await fetch('/api/couple/seating/import', {
        method: 'POST',
        body: fd,
        credentials: 'include',
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Parse failed')
      setChart(json.chart)
      setStep('preview')
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to parse file')
      setStep('error')
    }
  }

  async function handleCommit() {
    if (!chart) return
    setStep('committing')

    const fd = new FormData()
    fd.append('action', 'commit')
    fd.append('chart', JSON.stringify(chart))
    fd.append('replaceExisting', String(replaceExisting))

    try {
      const res = await fetch('/api/couple/seating/import', {
        method: 'POST',
        body: fd,
        credentials: 'include',
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Commit failed')
      setCommitResult(json)
      setStep('done')
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save seating chart')
      setStep('error')
    }
  }

  // ---- Trigger button ----
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-lg border border-sage-200 bg-white px-3 py-2 text-sm font-medium text-sage-700 shadow-sm hover:bg-sage-50 transition-colors"
      >
        <FileSpreadsheet size={15} />
        Import from spreadsheet
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={step === 'parsing' || step === 'committing' ? undefined : close}
          />

          {/* Dialog */}
          <div className="relative z-10 w-full max-w-2xl rounded-2xl bg-white shadow-2xl flex flex-col max-h-[90vh]">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Import Seating Chart</h2>
                <p className="text-sm text-gray-500 mt-0.5">
                  Upload your Excel or CSV seating chart — we'll map it automatically
                </p>
              </div>
              {step !== 'parsing' && step !== 'committing' && (
                <button onClick={close} className="text-gray-400 hover:text-gray-600 transition-colors">
                  <X size={20} />
                </button>
              )}
            </div>

            {/* Body */}
            <div className="overflow-y-auto flex-1 px-6 py-5">
              {/* IDLE */}
              {step === 'idle' && (
                <DropZone onFile={handleFile} fileInputRef={fileInputRef} />
              )}

              {/* PARSING */}
              {step === 'parsing' && (
                <div className="flex flex-col items-center gap-4 py-12 text-center">
                  <Loader2 size={36} className="text-sage-500 animate-spin" />
                  <p className="text-gray-600 font-medium">Reading your spreadsheet…</p>
                  <p className="text-sm text-gray-400">
                    We're detecting columns and extracting guest assignments
                  </p>
                </div>
              )}

              {/* PREVIEW */}
              {step === 'preview' && chart && (
                <PreviewPanel
                  chart={chart}
                  replaceExisting={replaceExisting}
                  setReplaceExisting={setReplaceExisting}
                  expandedTable={expandedTable}
                  setExpandedTable={setExpandedTable}
                />
              )}

              {/* COMMITTING */}
              {step === 'committing' && (
                <div className="flex flex-col items-center gap-4 py-12 text-center">
                  <Loader2 size={36} className="text-sage-500 animate-spin" />
                  <p className="text-gray-600 font-medium">Saving your seating chart…</p>
                </div>
              )}

              {/* DONE */}
              {step === 'done' && commitResult && (
                <div className="flex flex-col items-center gap-4 py-10 text-center">
                  <CheckCircle size={44} className="text-green-500" />
                  <p className="text-lg font-semibold text-gray-900">Seating chart imported</p>
                  <div className="flex flex-wrap justify-center gap-3 text-sm text-gray-600">
                    <Stat label="Tables" value={commitResult.tablesCreated} />
                    <Stat label="New guests" value={commitResult.guestsCreated} />
                    <Stat label="Updated" value={commitResult.guestsUpdated} />
                    {commitResult.allergiesCreated > 0 && (
                      <Stat label="Allergy records" value={commitResult.allergiesCreated} />
                    )}
                  </div>
                  <p className="text-sm text-gray-400 mt-2">
                    Head to your seating chart to see the results and make any adjustments.
                  </p>
                </div>
              )}

              {/* ERROR */}
              {step === 'error' && (
                <div className="flex flex-col items-center gap-4 py-10 text-center">
                  <AlertCircle size={44} className="text-red-400" />
                  <p className="text-lg font-semibold text-gray-900">Something went wrong</p>
                  <p className="text-sm text-gray-500 max-w-md">{errorMsg}</p>
                  <button
                    onClick={reset}
                    className="mt-2 text-sm text-sage-600 underline hover:text-sage-800"
                  >
                    Try again
                  </button>
                </div>
              )}
            </div>

            {/* Footer actions */}
            {(step === 'preview' || step === 'done') && (
              <div className="border-t border-gray-100 px-6 py-4 flex justify-between items-center gap-3">
                {step === 'preview' ? (
                  <>
                    <button
                      onClick={close}
                      className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleCommit}
                      className="rounded-lg bg-sage-600 px-5 py-2 text-sm font-medium text-white hover:bg-sage-700 transition-colors"
                    >
                      Import {chart?.total_guests} guests
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => { close(); onComplete() }}
                    className="ml-auto rounded-lg bg-sage-600 px-5 py-2 text-sm font-medium text-white hover:bg-sage-700 transition-colors"
                  >
                    View seating chart
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Drop zone
// ---------------------------------------------------------------------------

function DropZone({
  onFile,
  fileInputRef,
}: {
  onFile: (f: File) => void
  fileInputRef: React.RefObject<HTMLInputElement | null>
}) {
  const [dragging, setDragging] = useState(false)

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) onFile(file)
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => fileInputRef.current?.click()}
      className={`
        relative flex flex-col items-center gap-4 rounded-xl border-2 border-dashed
        cursor-pointer py-14 transition-colors
        ${dragging ? 'border-sage-400 bg-sage-50' : 'border-gray-200 bg-gray-50 hover:border-sage-300 hover:bg-sage-50/50'}
      `}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        className="hidden"
        onChange={(e) => { if (e.target.files?.[0]) onFile(e.target.files[0]) }}
      />
      <Upload size={32} className="text-gray-400" />
      <div className="text-center">
        <p className="font-medium text-gray-700">Drop your seating chart here</p>
        <p className="text-sm text-gray-400 mt-1">or click to browse — .xlsx, .xls, or .csv</p>
      </div>
      <div className="text-xs text-gray-400 text-center max-w-xs">
        Works with any layout — Google Sheets exports, Excel templates, or your own format.
        Just needs a column for the table and a column for the guest name.
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Preview panel
// ---------------------------------------------------------------------------

function PreviewPanel({
  chart,
  replaceExisting,
  setReplaceExisting,
  expandedTable,
  setExpandedTable,
}: {
  chart: ParsedSeatingChart
  replaceExisting: boolean
  setReplaceExisting: (v: boolean) => void
  expandedTable: string | null
  setExpandedTable: (v: string | null) => void
}) {
  return (
    <div className="space-y-4">
      {/* Summary strip */}
      <div className="flex flex-wrap gap-3">
        <Pill label={`${chart.tables.length} tables`} />
        <Pill label={`${chart.total_guests} guests`} />
        {chart.tables.filter((t) => t.notes).length > 0 && (
          <Pill label={`${chart.tables.filter((t) => t.notes).length} table notes`} />
        )}
        {chart.tables.some((t) => t.guests.some((g) => g.dietary_restrictions)) && (
          <Pill label="Dietary info found" accent />
        )}
      </div>

      {/* Warnings */}
      {chart.warnings.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 space-y-1">
          {chart.warnings.map((w, i) => <p key={i}>⚠ {w}</p>)}
        </div>
      )}

      {/* Global notes */}
      {chart.global_notes && (
        <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3">
          <p className="text-xs font-semibold text-blue-600 mb-1 uppercase tracking-wide">Seating Notes</p>
          <p className="text-sm text-blue-800 whitespace-pre-wrap">{chart.global_notes}</p>
        </div>
      )}

      {/* Replace toggle */}
      <label className="flex items-start gap-3 cursor-pointer rounded-lg border border-gray-100 bg-gray-50 px-4 py-3">
        <input
          type="checkbox"
          checked={replaceExisting}
          onChange={(e) => setReplaceExisting(e.target.checked)}
          className="mt-0.5 rounded border-gray-300 accent-sage-600"
        />
        <div>
          <p className="text-sm font-medium text-gray-700">Clear existing tables first</p>
          <p className="text-xs text-gray-400 mt-0.5">
            Removes any tables and seat assignments already in your seating chart before importing.
            Guest dietary and care notes won't be deleted — only seat assignments.
          </p>
        </div>
      </label>

      {/* Table list */}
      <div className="space-y-2">
        {chart.tables.map((table) => (
          <TablePreviewRow
            key={table.table_name}
            table={table}
            expanded={expandedTable === table.table_name}
            onToggle={() =>
              setExpandedTable(expandedTable === table.table_name ? null : table.table_name)
            }
          />
        ))}
      </div>
    </div>
  )
}

function TablePreviewRow({
  table,
  expanded,
  onToggle,
}: {
  table: ImportedTable
  expanded: boolean
  onToggle: () => void
}) {
  const allergyCount = table.guests.filter((g) => g.dietary_restrictions).length

  return (
    <div className="rounded-lg border border-gray-100 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          <span className="font-medium text-gray-800 text-sm">{table.table_name}</span>
          <span className="text-xs text-gray-400 flex items-center gap-1">
            <Users size={12} />
            {table.guests.length}
          </span>
          {allergyCount > 0 && (
            <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">
              {allergyCount} dietary
            </span>
          )}
          {table.notes && (
            <span className="text-xs bg-blue-100 text-blue-600 px-2 py-0.5 rounded-full">
              has notes
            </span>
          )}
        </div>
        {expanded ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
      </button>

      {expanded && (
        <div className="border-t border-gray-100 divide-y divide-gray-50">
          {table.notes && (
            <div className="px-4 py-2 bg-blue-50">
              <p className="text-xs text-blue-700 italic">{table.notes}</p>
            </div>
          )}
          {table.guests.map((guest, i) => (
            <div key={i} className="px-4 py-2.5 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-800">{guest.full_name}</p>
                {guest.relationship && (
                  <p className="text-xs text-gray-400">{guest.relationship}</p>
                )}
                {guest.coordinator_notes && (
                  <p className="text-xs text-amber-600 mt-0.5 italic">{guest.coordinator_notes}</p>
                )}
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                {guest.dietary_restrictions && (
                  <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">
                    {guest.dietary_restrictions}
                  </span>
                )}
                {guest.rsvp_status && guest.rsvp_status !== 'pending' && (
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    guest.rsvp_status === 'attending' ? 'bg-green-100 text-green-700' :
                    guest.rsvp_status === 'declined' ? 'bg-red-100 text-red-700' :
                    'bg-gray-100 text-gray-600'
                  }`}>
                    {guest.rsvp_status}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function Pill({ label, accent }: { label: string; accent?: boolean }) {
  return (
    <span className={`text-xs font-medium px-3 py-1 rounded-full border ${
      accent
        ? 'border-amber-200 bg-amber-50 text-amber-700'
        : 'border-sage-200 bg-sage-50 text-sage-700'
    }`}>
      {label}
    </span>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className="text-2xl font-bold text-gray-900">{value}</span>
      <span className="text-xs text-gray-500">{label}</span>
    </div>
  )
}
