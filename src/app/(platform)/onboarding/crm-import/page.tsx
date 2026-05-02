'use client'

/**
 * CRM-import (T5-followup-Y / Pattern I closure).
 *
 * Day-3 onboarding-project sub-step. Coordinator picks an adapter,
 * uploads a CSV (or in the case of generic_csv, also configures a
 * column-mapping JSON), previews the parsed rows, and commits.
 *
 * For now generic_csv is the only ready adapter; HoneyBook / Dubsado /
 * Aisle Planner show as scaffold-only and direct the coordinator to
 * use the generic adapter with a hand-built mapping.
 */

import { useEffect, useState } from 'react'
import {
  Upload, AlertCircle, CheckCircle2, Loader2, FileText, Database,
} from 'lucide-react'

interface AdapterManifest {
  name: string
  label: string
  description: string
  ready: boolean
}

interface PreviewRow {
  source_id?: string | null
  partner1_first_name?: string | null
  partner1_last_name?: string | null
  partner1_email?: string | null
  wedding_date?: string | null
  status?: string | null
  booking_value?: number | null
}

const DEFAULT_MAPPING_TEMPLATE = `{
  "partner1_first_name": "First Name",
  "partner1_last_name":  "Last Name",
  "partner1_email":      "Email",
  "partner1_phone":      "Phone",
  "wedding_date":        "Event Date",
  "guest_count_estimate":"Guest Count",
  "booking_value":       "Booking Total",
  "status":              "Lead Status",
  "source":              "Lead Source",
  "inquiry_date":        "Created Date",
  "booked_at":           "Booked Date",
  "notes":               "Notes"
}`

export default function CrmImportPage() {
  const [adapters, setAdapters] = useState<AdapterManifest[]>([])
  const [selectedAdapter, setSelectedAdapter] = useState<string>('generic_csv')
  const [csv, setCsv] = useState('')
  const [mappingText, setMappingText] = useState(DEFAULT_MAPPING_TEMPLATE)

  const [preview, setPreview] = useState<PreviewRow[] | null>(null)
  const [previewTotal, setPreviewTotal] = useState(0)
  const [errors, setErrors] = useState<string[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [success, setSuccess] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch('/api/onboarding/crm-import')
      .then((r) => r.json())
      .then((data) => setAdapters(data.adapters ?? []))
      .catch(() => setAdapters([]))
  }, [])

  const adapter = adapters.find((a) => a.name === selectedAdapter)
  const showMapping = selectedAdapter === 'generic_csv'

  function clearMessages() {
    setErrors([])
    setWarnings([])
    setSuccess(null)
  }

  async function submit(asPreview: boolean) {
    clearMessages()
    if (!csv.trim()) { setErrors(['csv content is empty']); return }

    let columnMapping: Record<string, string> | undefined
    if (showMapping) {
      try {
        columnMapping = JSON.parse(mappingText) as Record<string, string>
        if (typeof columnMapping !== 'object' || Array.isArray(columnMapping) || columnMapping == null) {
          throw new Error('mapping must be a JSON object')
        }
      } catch (err) {
        setErrors([`column-mapping JSON is invalid: ${err instanceof Error ? err.message : 'parse error'}`])
        return
      }
    }

    setBusy(true)
    try {
      const res = await fetch('/api/onboarding/crm-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adapter: selectedAdapter,
          csv,
          columnMapping,
          preview: asPreview,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setErrors(data.errors ?? [data.error ?? `HTTP ${res.status}`])
        if (Array.isArray(data.warnings)) setWarnings(data.warnings)
        setPreview(null)
        return
      }
      if (Array.isArray(data.warnings)) setWarnings(data.warnings)
      if (asPreview) {
        setPreview(data.rows ?? [])
        setPreviewTotal(data.total ?? 0)
      } else {
        setSuccess(
          `Imported ${data.weddings_inserted} weddings · ` +
          `${data.interactions_inserted} interactions · ` +
          `${data.tours_inserted} tours · ` +
          `${data.lost_deals_inserted} lost deals`
        )
        setPreview(null)
        setCsv('')
        if (data.errors?.length) setErrors(data.errors)
      }
    } catch (err) {
      setErrors([err instanceof Error ? err.message : 'Network error'])
    } finally { setBusy(false) }
  }

  return (
    <div className="p-8 max-w-4xl space-y-6">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <Database className="w-6 h-6 text-sage-700" />
          <h1 className="font-heading text-2xl font-semibold text-sage-900">Import CRM lead history</h1>
        </div>
        <p className="text-sm text-sage-600 max-w-2xl">
          Upload your existing CRM export so the Forensic Record isn&apos;t a
          blank slate. Imported rows are tagged with confidence_flag&nbsp;=
          <code className="bg-sage-50 px-1 rounded text-xs">imported_medium</code> + crm_source so downstream intel can
          distinguish them from live pipeline data.
        </p>
      </header>

      <section className="bg-white border border-sage-200 rounded-xl p-5 shadow-sm space-y-4">
        <div className="space-y-2">
          <label className="text-xs font-medium text-sage-700">Provider</label>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {adapters.map((a) => (
              <button
                key={a.name}
                type="button"
                onClick={() => { setSelectedAdapter(a.name); setPreview(null); clearMessages() }}
                disabled={!a.ready && a.name !== selectedAdapter}
                className={`text-left p-3 rounded border transition-colors ${
                  selectedAdapter === a.name
                    ? 'border-sage-700 bg-sage-50'
                    : a.ready
                      ? 'border-sage-200 hover:bg-sage-50'
                      : 'border-sage-100 bg-sage-50/40 opacity-60 cursor-not-allowed'
                }`}
                title={a.description}
              >
                <p className="text-sm font-medium text-sage-900">{a.label}</p>
                <p className="text-[10px] text-sage-500 mt-1 line-clamp-2">{a.description}</p>
                {!a.ready && <p className="text-[10px] text-amber-700 mt-1 font-medium">Scaffold only</p>}
              </button>
            ))}
          </div>
          {adapter && !adapter.ready && (
            <p className="text-xs text-amber-700">
              The {adapter.label} adapter is scaffold-only. Use Generic CSV with a custom column mapping until a dev wires it up.
            </p>
          )}
        </div>

        {showMapping && (
          <div className="space-y-2">
            <label className="text-xs font-medium text-sage-700">Column mapping (JSON)</label>
            <p className="text-[10px] text-sage-500">
              Map Bloom field names → your CSV header names. Unmapped fields are dropped.
            </p>
            <textarea
              rows={10}
              value={mappingText}
              onChange={(e) => setMappingText(e.target.value)}
              className="w-full px-3 py-2 text-xs font-mono border border-sage-200 rounded"
            />
          </div>
        )}

        <div className="space-y-2">
          <label className="text-xs font-medium text-sage-700">CSV content</label>
          <textarea
            rows={8}
            value={csv}
            onChange={(e) => { setCsv(e.target.value); setPreview(null) }}
            placeholder="Paste the CSV export (with a header row)."
            className="w-full px-3 py-2 text-xs font-mono border border-sage-200 rounded"
          />
        </div>

        <div className="flex items-center justify-end gap-2">
          {!preview ? (
            <button
              type="button"
              onClick={() => submit(true)}
              disabled={busy || !adapter?.ready}
              className="inline-flex items-center gap-1.5 rounded border border-sage-200 hover:bg-sage-50 text-sage-700 text-sm font-medium px-3 py-2 disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
              Preview
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="text-sm text-sage-700 hover:bg-sage-50 px-3 py-2 rounded"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => submit(false)}
                disabled={busy || preview.length === 0}
                className="inline-flex items-center gap-1.5 rounded bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white text-sm font-medium px-3 py-2"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                Import {previewTotal} rows
              </button>
            </>
          )}
        </div>

        {preview && preview.length > 0 && (
          <div className="border border-sage-200 rounded-lg p-3 bg-sage-50/40 max-h-96 overflow-auto">
            <p className="text-xs font-medium text-sage-900 mb-2">
              Preview — showing {preview.length} of {previewTotal} row{previewTotal === 1 ? '' : 's'}
            </p>
            <table className="w-full text-xs">
              <thead className="text-left text-sage-600 sticky top-0 bg-sage-50">
                <tr>
                  <th className="font-medium pb-1 pr-2">Couple</th>
                  <th className="font-medium pb-1 pr-2">Email</th>
                  <th className="font-medium pb-1 pr-2">Wedding date</th>
                  <th className="font-medium pb-1 pr-2">Status</th>
                  <th className="font-medium pb-1 text-right">Booking</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((r, i) => (
                  <tr key={i} className="border-t border-sage-100">
                    <td className="py-1 pr-2">
                      {[r.partner1_first_name, r.partner1_last_name].filter(Boolean).join(' ') || '—'}
                    </td>
                    <td className="py-1 pr-2">{r.partner1_email ?? '—'}</td>
                    <td className="py-1 pr-2">{r.wedding_date ?? '—'}</td>
                    <td className="py-1 pr-2">{r.status ?? '—'}</td>
                    <td className="py-1 text-right">
                      {r.booking_value != null
                        ? (r.booking_value / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

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

      {warnings.length > 0 && (
        <div className="bg-amber-50/50 border border-amber-200 rounded-lg p-3 text-xs text-amber-700 space-y-1">
          <p className="font-medium">Warnings:</p>
          {warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
              <span>{w}</span>
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
    </div>
  )
}
