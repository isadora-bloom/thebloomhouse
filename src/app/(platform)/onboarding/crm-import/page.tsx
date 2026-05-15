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
  "amount_paid":         "Amount Paid",
  "deposit_amount":      "Deposit",
  "tax_amount":          "Tax",
  "gratuity_amount":     "Gratuity",
  "refunded_amount":     "Refunded",
  "package_name":        "Package",
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
  // Post-import breakdown: rows skipped pre-commit + deduped write
  // failures + a migration hint when the schema is behind.
  const [skippedRows, setSkippedRows] = useState<
    Array<{ row: number; reasons: string[] }>
  >([])
  const [writeErrors, setWriteErrors] = useState<
    Array<{ message: string; count: number }>
  >([])
  const [schemaHint, setSchemaHint] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/onboarding/crm-import')
      .then((r) => r.json())
      .then((data) => setAdapters(data.adapters ?? []))
      .catch(() => setAdapters([]))
  }, [])

  const adapter = adapters.find((a) => a.name === selectedAdapter)
  // Generic CSV needs a hand-built mapping; provider-specific adapters
  // (HoneyBook, Dubsado, Aisle Planner) embed their column mapping in
  // the adapter itself, so the UI hides the mapping textarea for them.
  const showMapping = selectedAdapter === 'generic_csv'
  const isHoneybook = selectedAdapter === 'honeybook'

  function clearMessages() {
    setErrors([])
    setWarnings([])
    setSuccess(null)
    setSkippedRows([])
    setWriteErrors([])
    setSchemaHint(null)
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
        // The route always returns 200 now — a partial import is a
        // success. data.message is the plain-language summary; the
        // breakdowns explain exactly what didn't make it and why.
        setSuccess(
          (data.message ?? `Imported ${data.weddings_inserted} of ${data.total_rows}.`) +
          ` (${data.weddings_inserted} weddings · ${data.interactions_inserted} interactions · ` +
          `${data.tours_inserted} tours · ${data.lost_deals_inserted} lost deals)`
        )
        setSkippedRows(Array.isArray(data.skipped_invalid) ? data.skipped_invalid : [])
        setWriteErrors(Array.isArray(data.write_errors) ? data.write_errors : [])
        setSchemaHint(typeof data.schema_hint === 'string' ? data.schema_hint : null)
        // Only clear the CSV when everything imported — leave it loaded
        // so the coordinator can fix + re-run if some rows failed.
        if (data.ok) {
          setPreview(null)
          setCsv('')
        }
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

      {/* Upload-order guidance. The Backwards Tracer anchors on booked
          couples — if Gmail / Calendly / storefront data is imported
          before any booked couples exist, reconstruction cold-starts
          and the signals have nothing to attach to. */}
      <div className="rounded-xl border border-sage-300 bg-sage-50 p-4 text-sm text-sage-800">
        <p className="font-medium text-sage-900">Upload your booked couples first.</p>
        <p className="mt-1 text-sage-700">
          This step — your CRM export of booked clients — should be the
          <strong> first</strong> thing you import. Those couples are the
          anchors Bloom reconstructs everything else from. Connect Gmail,
          Calendly and storefront exports <em>after</em> this import
          finishes. Include every column your CRM offers: revenue, deposit,
          booked date, guest count and package are all read and recorded.
        </p>
      </div>

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

        {isHoneybook && (
          <div className="space-y-2 bg-sage-50/40 border border-sage-200 rounded-lg p-3">
            <p className="text-xs font-medium text-sage-900">HoneyBook export instructions</p>
            <ol className="list-decimal list-inside text-[11px] text-sage-700 space-y-1">
              <li>In HoneyBook, go to <strong>Settings → Reports → Projects</strong>.</li>
              <li>Click <strong>Export as CSV</strong> (top-right of the report).</li>
              <li>Open the CSV and paste the contents into the box below.</li>
            </ol>
            <p className="text-[11px] text-sage-700">
              Required columns: <code className="bg-white px-1 rounded">Project Name</code>,{' '}
              <code className="bg-white px-1 rounded">Project Date</code>,{' '}
              <code className="bg-white px-1 rounded">Client Email</code>.
            </p>
            <p className="text-[11px] text-sage-700">
              Optional but recommended: <code className="bg-white px-1 rounded">Project Status</code>,{' '}
              <code className="bg-white px-1 rounded">Total</code>,{' '}
              <code className="bg-white px-1 rounded">Inquiry Date</code>,{' '}
              <code className="bg-white px-1 rounded">Booking Date</code>,{' '}
              <code className="bg-white px-1 rounded">Source</code>,{' '}
              <code className="bg-white px-1 rounded">Tags</code>,{' '}
              <code className="bg-white px-1 rounded">Notes</code>.
            </p>
            <p className="text-[11px] text-sage-700">
              Column-name detection is case-insensitive and accepts common variants
              (e.g. <em>Event Date</em> = <em>Project Date</em>).
            </p>
            <a
              href="/samples/honeybook-sample.csv"
              download
              className="inline-block text-[11px] text-sage-800 underline hover:no-underline"
            >
              Download a sample HoneyBook CSV (5 fake rows)
            </a>
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
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs text-emerald-800 flex items-start gap-1.5">
          <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{success}</span>
        </div>
      )}

      {/* Schema / migration hint — a failed write that traces to an
          un-applied migration gets one clear line, not a wall of
          Postgres errors. */}
      {schemaHint && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-xs text-red-900 flex items-start gap-1.5">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Database is behind</p>
            <p>{schemaHint}</p>
          </div>
        </div>
      )}

      {/* Deduped write failures — 112 identical errors collapse to one
          line with a count. */}
      {writeErrors.length > 0 && (
        <div className="bg-red-50/70 border border-red-200 rounded-lg p-3 text-xs text-red-800 space-y-1">
          <p className="font-medium">Could not be saved:</p>
          {writeErrors.map((e, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
              <span>
                {e.count > 1 && <strong>{e.count}× </strong>}
                {e.message}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Rows skipped because their data did not validate. The good
          rows still imported — these are listed so the coordinator can
          fix the source CSV and re-run for just these. */}
      {skippedRows.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800 space-y-1">
          <p className="font-medium">
            {skippedRows.length} row{skippedRows.length === 1 ? '' : 's'} skipped — data didn&apos;t validate:
          </p>
          <div className="max-h-48 overflow-y-auto space-y-1">
            {skippedRows.map((s) => (
              <div key={s.row} className="flex items-start gap-1.5">
                <span className="font-mono shrink-0">Row {s.row}:</span>
                <span>{s.reasons.join('; ')}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
