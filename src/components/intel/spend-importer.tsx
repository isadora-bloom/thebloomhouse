'use client'

/**
 * Spend Importer — Phase 3 Task 33.
 *
 * Three-way coordinator input for marketing_spend:
 *   1. Manual form — source + month + amount
 *   2. CSV paste — Google Ads / Facebook / WeddingWire export
 *   3. Free text — "spent $400 on Instagram in March for the spring push"
 *
 * All three funnel through POST /api/intel/spend. Two-step flow: preview
 * first, confirm on second POST. Coordinator sees the rows before
 * anything lands.
 */

import { useState } from 'react'
import { DollarSign, Upload, FileText, Plus, Trash2, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react'

type Mode = 'rows' | 'csv' | 'text'

interface DraftRow {
  source: string
  month: string
  amount: string
  campaign: string
}

interface PreviewRow {
  source: string
  month: string
  amount: number
  campaign?: string | null
}

function emptyRow(): DraftRow {
  return { source: '', month: '', amount: '', campaign: '' }
}

function thisMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

export function SpendImporter({ onImported }: { onImported?: () => void }) {
  const [mode, setMode] = useState<Mode>('rows')
  const [rows, setRows] = useState<DraftRow[]>([{ ...emptyRow(), month: thisMonth() }])
  const [csv, setCsv] = useState('')
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<PreviewRow[] | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)

  async function submit(asPreview: boolean) {
    setBusy(true)
    setErrors([])
    setSuccess(null)

    const endpoint = asPreview
      ? '/api/intel/spend?preview=true'
      : '/api/intel/spend'

    const body: Record<string, unknown> = { mode }
    if (mode === 'rows') {
      body.rows = rows
        .filter((r) => r.source.trim() && r.month.trim() && r.amount.trim())
        .map((r) => ({
          source: r.source,
          month: r.month,
          amount: Number(r.amount),
          campaign: r.campaign || undefined,
        }))
    } else if (mode === 'csv') {
      body.csv = csv
    } else if (mode === 'text') {
      body.text = text
    }

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        setErrors([data.error ?? `HTTP ${res.status}`])
        setBusy(false)
        return
      }
      if (asPreview) {
        setPreview((data.rowsPreview as PreviewRow[]) ?? [])
        if (Array.isArray(data.errors)) setErrors(data.errors)
      } else {
        setSuccess(
          `Imported ${data.inserted ?? 0} new + ${data.updated ?? 0} updated (${data.skipped ?? 0} skipped).`
        )
        setPreview(null)
        setRows([{ ...emptyRow(), month: thisMonth() }])
        setCsv('')
        setText('')
        if (Array.isArray(data.errors)) setErrors(data.errors)
        if (onImported) onImported()
      }
    } catch (err) {
      setErrors([err instanceof Error ? err.message : 'Network error'])
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-white border border-sage-200 rounded-xl p-5 shadow-sm space-y-4">
      <div className="flex items-center gap-2">
        <DollarSign className="w-5 h-5 text-sage-600" />
        <h2 className="font-heading text-base font-semibold text-sage-900">Log marketing spend</h2>
      </div>

      <div className="flex gap-1 bg-sage-50 rounded-lg p-1">
        {(['rows', 'csv', 'text'] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => { setMode(m); setPreview(null); setErrors([]); setSuccess(null) }}
            className={`flex-1 px-3 py-1.5 text-xs font-medium rounded flex items-center justify-center gap-1.5 ${
              mode === m ? 'bg-white text-sage-900 shadow-sm' : 'text-sage-600 hover:text-sage-800'
            }`}
          >
            {m === 'rows' && <Plus className="w-3 h-3" />}
            {m === 'csv' && <Upload className="w-3 h-3" />}
            {m === 'text' && <FileText className="w-3 h-3" />}
            {m === 'rows' ? 'Form' : m === 'csv' ? 'CSV paste' : 'Free text'}
          </button>
        ))}
      </div>

      {mode === 'rows' && (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-12 gap-2">
              <input
                className="col-span-3 px-2 py-1.5 text-sm border border-sage-200 rounded"
                placeholder="Source (e.g. the_knot)"
                value={r.source}
                onChange={(e) => setRows((p) => p.map((x, j) => (j === i ? { ...x, source: e.target.value } : x)))}
              />
              <input
                type="date"
                className="col-span-3 px-2 py-1.5 text-sm border border-sage-200 rounded"
                value={r.month}
                onChange={(e) => setRows((p) => p.map((x, j) => (j === i ? { ...x, month: e.target.value } : x)))}
              />
              <input
                type="number"
                step="0.01"
                className="col-span-2 px-2 py-1.5 text-sm border border-sage-200 rounded"
                placeholder="Amount"
                value={r.amount}
                onChange={(e) => setRows((p) => p.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
              />
              <input
                className="col-span-3 px-2 py-1.5 text-sm border border-sage-200 rounded"
                placeholder="Campaign (optional)"
                value={r.campaign}
                onChange={(e) => setRows((p) => p.map((x, j) => (j === i ? { ...x, campaign: e.target.value } : x)))}
              />
              <button
                type="button"
                onClick={() => setRows((p) => p.filter((_, j) => j !== i))}
                className="col-span-1 p-1.5 text-rose-600 hover:bg-rose-50 rounded"
                disabled={rows.length === 1}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setRows((p) => [...p, { ...emptyRow(), month: thisMonth() }])}
            className="text-xs text-sage-700 hover:underline"
          >
            + Add row
          </button>
        </div>
      )}

      {mode === 'csv' && (
        <div>
          <textarea
            rows={6}
            className="w-full px-3 py-2 border border-sage-200 rounded font-mono text-xs"
            placeholder="Paste a CSV export. Header must include source (or platform/channel), month (or date/period), and amount (or spend/cost/total)."
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
          />
          <p className="text-xs text-sage-500 mt-1">
            Tip: Google Ads exports work as-is. For WeddingWire, paste the monthly breakdown table.
          </p>
        </div>
      )}

      {mode === 'text' && (
        <div>
          <textarea
            rows={4}
            className="w-full px-3 py-2 border border-sage-200 rounded text-sm"
            placeholder='Describe what you spent — "$500 on Instagram in March for the spring campaign" — and Sage will extract the rows.'
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
      )}

      {preview && preview.length > 0 && (
        <div className="border border-sage-200 rounded-lg p-3 bg-sage-50/50 space-y-2">
          <p className="text-xs font-medium text-sage-900">
            Preview — {preview.length} row{preview.length === 1 ? '' : 's'}:
          </p>
          <div className="text-xs space-y-0.5 font-mono">
            {preview.map((r, i) => (
              <div key={i} className="flex justify-between">
                <span>{r.source} · {r.month}{r.campaign ? ` · ${r.campaign}` : ''}</span>
                <span>${r.amount.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {errors.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800 space-y-1">
          {errors.map((e, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{e}</span>
            </div>
          ))}
        </div>
      )}

      {success && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs text-emerald-800 flex items-center gap-1.5">
          <CheckCircle2 className="w-4 h-4" />
          {success}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        {!preview ? (
          <button
            type="button"
            onClick={() => submit(true)}
            disabled={busy}
            className="px-4 py-2 text-sm text-sage-700 border border-sage-200 rounded-lg hover:bg-sage-50 disabled:opacity-50 flex items-center gap-1.5"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            Preview
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setPreview(null)}
              className="px-4 py-2 text-sm text-sage-700 hover:bg-sage-100 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => submit(false)}
              disabled={busy || preview.length === 0}
              className="px-4 py-2 text-sm bg-sage-600 text-white rounded-lg hover:bg-sage-700 disabled:opacity-50 flex items-center gap-1.5"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              Import
            </button>
          </>
        )}
      </div>
    </div>
  )
}
