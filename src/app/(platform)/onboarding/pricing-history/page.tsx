'use client'

/**
 * Pricing-history reconstruction (T5-followup-Y / Pattern I closure).
 *
 * Coordinator surface for entering historical package pricing changes
 * so pricing_history has data BEFORE the venue starts marketing on
 * Bloom. Without this, the elasticity-confound check + Stream J's
 * provenance work both sit on a blank table and silently treat every
 * post-onboarding spike as the first signal.
 *
 * Two input modes:
 *   1. Single-row form — coordinator types one historical change at a time.
 *   2. CSV bulk upload — paste a CSV with package_name, effective_date,
 *      prior_price (optional), new_price.
 *
 * Both write to pricing_history with source_provenance='manual_form' /
 * 'manual_csv' and confidence_flag='imported_high' (since the
 * coordinator types it themselves).
 *
 * Existing rows render below with delete (manual rows only — trigger
 * rows are append-only so the audit trail stays intact).
 */

import { useEffect, useState, useCallback } from 'react'
import {
  DollarSign, Plus, Upload, Trash2, AlertCircle, CheckCircle2, Loader2, Calendar, FileText,
} from 'lucide-react'

interface PricingRow {
  id: string
  field_name: string
  old_value: { value?: number } | null
  new_value: { value?: number } | null
  context: string | null
  notes: string | null
  source_provenance: string | null
  confidence_flag: string | null
  changed_at: string
}

interface PreviewRow {
  package_name: string
  effective_date: string
  prior_price: number | null
  new_price: number
}

type Mode = 'form' | 'csv'

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function dollarsToCents(dollars: string): number {
  const n = Number(dollars.replace(/[$,\s]/g, ''))
  if (!Number.isFinite(n)) return NaN
  return Math.round(n * 100)
}

function centsToDollars(cents: number | null | undefined): string {
  if (cents == null) return ''
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

export default function PricingHistoryPage() {
  const [mode, setMode] = useState<Mode>('form')

  // Single-row form state
  const [packageName, setPackageName] = useState('')
  const [effectiveDate, setEffectiveDate] = useState(todayIso())
  const [priorPrice, setPriorPrice] = useState('')
  const [newPrice, setNewPrice] = useState('')
  const [notes, setNotes] = useState('')

  // CSV state
  const [csv, setCsv] = useState('')
  const [csvPreview, setCsvPreview] = useState<PreviewRow[] | null>(null)

  // Shared
  const [rows, setRows] = useState<PricingRow[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [success, setSuccess] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const fetchRows = useCallback(async () => {
    try {
      const res = await fetch('/api/onboarding/pricing-history')
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setErrors([data.error ?? `HTTP ${res.status}`])
        return
      }
      const data = await res.json()
      setRows(data.rows ?? [])
    } catch (err) {
      setErrors([err instanceof Error ? err.message : 'Failed to load rows'])
    }
  }, [])

  useEffect(() => { fetchRows() }, [fetchRows])

  function clearMessages() {
    setErrors([])
    setSuccess(null)
  }

  async function submitSingle() {
    clearMessages()
    if (!packageName.trim()) { setErrors(['package_name is required']); return }
    if (!effectiveDate) { setErrors(['effective_date is required']); return }
    const newCents = dollarsToCents(newPrice)
    if (!Number.isFinite(newCents) || newCents <= 0) {
      setErrors(['new_price must be > 0']); return
    }
    let priorCents: number | null = null
    if (priorPrice.trim()) {
      priorCents = dollarsToCents(priorPrice)
      if (!Number.isFinite(priorCents) || (priorCents as number) <= 0) {
        setErrors(['prior_price must be > 0 (or leave empty)']); return
      }
    }

    setBusy(true)
    try {
      const res = await fetch('/api/onboarding/pricing-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'single',
          package_name: packageName.trim(),
          effective_date: effectiveDate,
          prior_price: priorCents,
          new_price: newCents,
          notes: notes.trim() || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setErrors([data.error ?? `HTTP ${res.status}`])
        return
      }
      setSuccess(`Logged ${packageName.trim()} change.`)
      setPackageName('')
      setPriorPrice('')
      setNewPrice('')
      setNotes('')
      setEffectiveDate(todayIso())
      await fetchRows()
    } catch (err) {
      setErrors([err instanceof Error ? err.message : 'Network error'])
    } finally { setBusy(false) }
  }

  async function previewCsv() {
    clearMessages()
    if (!csv.trim()) { setErrors(['csv content is empty']); return }
    setBusy(true)
    try {
      const res = await fetch('/api/onboarding/pricing-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'csv', csv, preview: true }),
      })
      const data = await res.json()
      if (!res.ok) {
        setErrors(data.details ?? [data.error ?? `HTTP ${res.status}`])
        setCsvPreview(null)
        return
      }
      setCsvPreview(data.preview ?? [])
      if (data.errors?.length) setErrors(data.errors)
    } catch (err) {
      setErrors([err instanceof Error ? err.message : 'Network error'])
    } finally { setBusy(false) }
  }

  async function commitCsv() {
    clearMessages()
    setBusy(true)
    try {
      const res = await fetch('/api/onboarding/pricing-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'csv', csv }),
      })
      const data = await res.json()
      if (!res.ok) {
        setErrors(data.details ?? [data.error ?? `HTTP ${res.status}`])
        return
      }
      setSuccess(`Imported ${data.inserted ?? 0} pricing-history rows.`)
      setCsv('')
      setCsvPreview(null)
      await fetchRows()
    } catch (err) {
      setErrors([err instanceof Error ? err.message : 'Network error'])
    } finally { setBusy(false) }
  }

  async function deleteRow(id: string) {
    if (!window.confirm('Delete this row? This is only allowed on coordinator-entered rows.')) return
    clearMessages()
    setBusy(true)
    try {
      const res = await fetch(`/api/onboarding/pricing-history?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) {
        setErrors([data.error ?? `HTTP ${res.status}`])
        return
      }
      await fetchRows()
    } catch (err) {
      setErrors([err instanceof Error ? err.message : 'Network error'])
    } finally { setBusy(false) }
  }

  const manualRowsCount = rows.filter((r) =>
    r.source_provenance === 'manual_form' || r.source_provenance === 'manual_csv'
  ).length

  return (
    <div className="p-8 max-w-4xl space-y-6">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <DollarSign className="w-6 h-6 text-sage-700" />
          <h1 className="font-heading text-2xl font-semibold text-sage-900">Pricing-history reconstruction</h1>
        </div>
        <p className="text-sm text-sage-600 max-w-2xl">
          Walk back through your historical package pricing changes so the
          elasticity intelligence has data to work with. New venues are otherwise
          a blank pricing-history slate — the first post-onboarding spike or
          dip looks like the first signal.
        </p>
        <p className="text-xs text-sage-500">
          Manual rows logged: <strong>{manualRowsCount}</strong> (Day-3 onboarding sub-step completes at 5+).
        </p>
      </header>

      <div className="flex gap-1 bg-sage-50 rounded-lg p-1 max-w-md">
        {(['form', 'csv'] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => { setMode(m); clearMessages(); setCsvPreview(null) }}
            className={`flex-1 px-3 py-2 text-xs font-medium rounded flex items-center justify-center gap-1.5 ${
              mode === m ? 'bg-white text-sage-900 shadow-sm' : 'text-sage-600 hover:text-sage-800'
            }`}
          >
            {m === 'form' ? <Plus className="w-3 h-3" /> : <Upload className="w-3 h-3" />}
            {m === 'form' ? 'Single row' : 'CSV bulk upload'}
          </button>
        ))}
      </div>

      {mode === 'form' && (
        <section className="bg-white border border-sage-200 rounded-xl p-5 shadow-sm space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-sage-700">Package / Field name</label>
              <input
                type="text"
                placeholder="e.g. Saturday Peak Package"
                value={packageName}
                onChange={(e) => setPackageName(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-sage-200 rounded"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-sage-700 flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                Effective date
              </label>
              <input
                type="date"
                value={effectiveDate}
                onChange={(e) => setEffectiveDate(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-sage-200 rounded"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-sage-700">Prior price (optional)</label>
              <input
                type="text"
                placeholder="e.g. 4500"
                value={priorPrice}
                onChange={(e) => setPriorPrice(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-sage-200 rounded"
              />
              <p className="text-[10px] text-sage-500">In dollars. Leave empty if unknown.</p>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-sage-700">New price</label>
              <input
                type="text"
                placeholder="e.g. 5200"
                value={newPrice}
                onChange={(e) => setNewPrice(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-sage-200 rounded"
              />
              <p className="text-[10px] text-sage-500">In dollars.</p>
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-sage-700">Notes (optional)</label>
            <textarea
              rows={2}
              placeholder="What drove the change? (matched competitor pricing / renovation / Q1 review / etc.)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-sage-200 rounded"
            />
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={submitSingle}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white text-sm font-medium px-4 py-2"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Log change
            </button>
          </div>
        </section>
      )}

      {mode === 'csv' && (
        <section className="bg-white border border-sage-200 rounded-xl p-5 shadow-sm space-y-3">
          <p className="text-xs text-sage-700">
            Header row: <code className="text-xs bg-sage-50 px-1 rounded">package_name,effective_date,prior_price,new_price</code>
          </p>
          <p className="text-[10px] text-sage-500">
            Dates as <code>yyyy-mm-dd</code>. Prices in dollars. <code>prior_price</code> is optional but speeds up elasticity analysis.
          </p>
          <textarea
            rows={8}
            value={csv}
            onChange={(e) => { setCsv(e.target.value); setCsvPreview(null) }}
            placeholder={`package_name,effective_date,prior_price,new_price\nSaturday Peak,2025-03-01,4500,5200\nFriday Off-Peak,2025-04-15,3200,3500`}
            className="w-full px-3 py-2 text-xs font-mono border border-sage-200 rounded"
          />
          <div className="flex justify-end gap-2">
            {!csvPreview ? (
              <button
                type="button"
                onClick={previewCsv}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded border border-sage-200 hover:bg-sage-50 text-sage-700 text-sm font-medium px-3 py-2 disabled:opacity-50"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                Preview
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setCsvPreview(null)}
                  className="text-sm text-sage-700 hover:bg-sage-50 px-3 py-2 rounded"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={commitCsv}
                  disabled={busy || csvPreview.length === 0}
                  className="inline-flex items-center gap-1.5 rounded bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white text-sm font-medium px-3 py-2"
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                  Import {csvPreview.length} rows
                </button>
              </>
            )}
          </div>

          {csvPreview && (
            <div className="border border-sage-200 rounded-lg p-3 bg-sage-50/40 max-h-72 overflow-auto">
              <p className="text-xs font-medium text-sage-900 mb-2">
                Preview — {csvPreview.length} row{csvPreview.length === 1 ? '' : 's'}
              </p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-sage-600">
                    <th className="font-medium pb-1">Package</th>
                    <th className="font-medium pb-1">Effective</th>
                    <th className="font-medium pb-1 text-right">Prior</th>
                    <th className="font-medium pb-1 text-right">New</th>
                  </tr>
                </thead>
                <tbody>
                  {csvPreview.map((r, i) => (
                    <tr key={i} className="border-t border-sage-100">
                      <td className="py-1">{r.package_name}</td>
                      <td className="py-1">{r.effective_date}</td>
                      <td className="py-1 text-right">{r.prior_price != null ? centsToDollars(r.prior_price) : '—'}</td>
                      <td className="py-1 text-right font-medium">{centsToDollars(r.new_price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
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

      <section className="bg-white border border-sage-200 rounded-xl p-5 shadow-sm space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-heading text-base font-semibold text-sage-900">Existing rows</h2>
          <span className="text-xs text-sage-500">{rows.length} total</span>
        </div>
        {rows.length === 0 ? (
          <p className="text-sm text-sage-500 italic">No pricing-history rows yet. Log changes above.</p>
        ) : (
          <div className="overflow-auto max-h-96">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-white">
                <tr className="text-left text-sage-600 border-b border-sage-200">
                  <th className="font-medium py-2">Package / Field</th>
                  <th className="font-medium py-2">Effective</th>
                  <th className="font-medium py-2 text-right">Prior</th>
                  <th className="font-medium py-2 text-right">New</th>
                  <th className="font-medium py-2">Source</th>
                  <th className="font-medium py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isManual = r.source_provenance === 'manual_form' || r.source_provenance === 'manual_csv'
                  const oldCents = r.old_value?.value ?? null
                  const newCents = r.new_value?.value ?? null
                  return (
                    <tr key={r.id} className="border-b border-sage-100">
                      <td className="py-2">
                        {r.field_name}
                        {r.notes && <p className="text-[10px] text-sage-500 mt-0.5">{r.notes}</p>}
                      </td>
                      <td className="py-2">{new Date(r.changed_at).toISOString().slice(0, 10)}</td>
                      <td className="py-2 text-right">{oldCents != null ? centsToDollars(oldCents) : '—'}</td>
                      <td className="py-2 text-right font-medium">{newCents != null ? centsToDollars(newCents) : '—'}</td>
                      <td className="py-2">
                        <span className="inline-block text-[10px] px-1.5 py-0.5 rounded bg-sage-50 text-sage-700">
                          {r.source_provenance ?? r.context ?? 'legacy'}
                        </span>
                      </td>
                      <td className="py-2 text-right">
                        {isManual && (
                          <button
                            type="button"
                            onClick={() => deleteRow(r.id)}
                            className="p-1 text-rose-600 hover:bg-rose-50 rounded"
                            disabled={busy}
                            title="Delete (manual rows only)"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
