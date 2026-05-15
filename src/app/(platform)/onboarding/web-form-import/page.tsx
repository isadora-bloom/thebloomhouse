'use client'

/**
 * Web-form intake (T5-Rixey-HH).
 *
 * Day-2 onboarding-project sub-step. Coordinator picks a form provider
 * (Rixey calculator, Typeform, Jotform, Google Forms, custom), uploads
 * a CSV export, previews, optionally extracts the venue's package
 * catalog from the form schema, then commits.
 *
 * Independent from /onboarding/crm-import — a venue with both a
 * pricing calculator AND HoneyBook lands data through both paths.
 */

import { useEffect, useState } from 'react'
import {
  Upload, AlertCircle, CheckCircle2, Loader2, FileText, FormInput,
} from 'lucide-react'
import Link from 'next/link'
import { CsvFileInput } from '@/components/onboarding/CsvFileInput'

interface HintManifest {
  provider: string
  label: string
  description: string
  configuredColumns: {
    date: string | null
    contactEmail: string | null
    contactName: string | null
    partnerEmail: string | null
    partnerName: string | null
    weddingDate: string | null
    guestCount: string | null
    notes: string | null
    packages: string[]
    upgrades: string[]
    discounts: string[]
    calculatedTotal: string | null
  }
}

interface PreviewRow {
  partner1_first_name?: string | null
  partner1_last_name?: string | null
  partner1_email?: string | null
  partner2_first_name?: string | null
  partner2_last_name?: string | null
  wedding_date?: string | null
  guest_count_estimate?: number | null
  booking_value?: number | null
  inquiry_date?: string | null
}

const HINT_OVERRIDES_TEMPLATE = `{
  "contactEmailColumn": "Email",
  "contactNameColumn": "Full Name",
  "partnerEmailColumn": "Partner's Email",
  "partnerNameColumn": "Partner's Name",
  "dateColumn": "Submitted At",
  "weddingDateColumn": "Wedding Date",
  "guestCountColumn": "Guest Count",
  "notesColumn": "Anything else?"
}`

export default function WebFormImportPage() {
  const [hints, setHints] = useState<HintManifest[]>([])
  const [provider, setProvider] = useState<string>('rixey_calculator')
  const [csv, setCsv] = useState('')
  const [showHintOverrides, setShowHintOverrides] = useState(false)
  const [hintOverridesText, setHintOverridesText] = useState(HINT_OVERRIDES_TEMPLATE)

  const [preview, setPreview] = useState<PreviewRow[] | null>(null)
  const [previewTotal, setPreviewTotal] = useState(0)
  const [errors, setErrors] = useState<string[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [success, setSuccess] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch('/api/onboarding/web-form-import')
      .then((r) => r.json())
      .then((data) => setHints(data.hints ?? []))
      .catch(() => setHints([]))
  }, [])

  const hint = hints.find((h) => h.provider === provider)

  function clearMessages() {
    setErrors([])
    setWarnings([])
    setSuccess(null)
  }

  async function submit(asPreview: boolean) {
    clearMessages()
    if (!csv.trim()) { setErrors(['csv content is empty']); return }

    let hintOverrides: Record<string, unknown> | undefined
    if (showHintOverrides) {
      try {
        hintOverrides = JSON.parse(hintOverridesText) as Record<string, unknown>
        if (typeof hintOverrides !== 'object' || Array.isArray(hintOverrides) || hintOverrides == null) {
          throw new Error('hint-overrides must be a JSON object')
        }
      } catch (err) {
        setErrors([`hint-overrides JSON is invalid: ${err instanceof Error ? err.message : 'parse error'}`])
        return
      }
    }

    setBusy(true)
    try {
      const res = await fetch('/api/onboarding/web-form-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          formProvider: provider,
          csv,
          hintOverrides,
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
          `Imported ${data.weddings_inserted} submissions · `
          + `${data.interactions_inserted} timeline entries.`,
        )
        setPreview(null)
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
          <FormInput className="w-6 h-6 text-sage-700" />
          <h1 className="font-heading text-2xl font-semibold text-sage-900">Import web-form submissions</h1>
        </div>
        <p className="text-sm text-sage-600 max-w-2xl">
          Upload submissions from your own pricing calculator or web form (Typeform, Jotform, Google Forms,
          or a custom HTML form). Each submission becomes a wedding row + a timeline entry + a tangential
          signal for funnel analytics. Tagged{' '}
          <code className="bg-sage-50 px-1 rounded text-xs">confidence_flag=imported_high</code>{' '}
          (first-party data) and{' '}
          <code className="bg-sage-50 px-1 rounded text-xs">source_provenance=web_form_import</code>.
        </p>
        <p className="text-xs text-sage-500 max-w-2xl">
          This is independent from <Link href="/onboarding/crm-import" className="underline">CRM import</Link>.
          A venue with both a calculator AND HoneyBook can use both paths.
        </p>
      </header>

      <section className="bg-white border border-sage-200 rounded-xl p-5 shadow-sm space-y-4">
        <div className="space-y-2">
          <label className="text-xs font-medium text-sage-700">Form provider</label>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {hints.map((h) => (
              <button
                key={h.provider}
                type="button"
                onClick={() => { setProvider(h.provider); setPreview(null); clearMessages() }}
                className={`text-left p-3 rounded border transition-colors ${
                  provider === h.provider
                    ? 'border-sage-700 bg-sage-50'
                    : 'border-sage-200 hover:bg-sage-50'
                }`}
                title={h.description}
              >
                <p className="text-sm font-medium text-sage-900">{h.label}</p>
                <p className="text-[10px] text-sage-500 mt-1 line-clamp-2">{h.description}</p>
              </button>
            ))}
          </div>
        </div>

        {hint && (
          <div className="bg-sage-50/40 border border-sage-200 rounded-lg p-3 space-y-1">
            <p className="text-xs font-medium text-sage-900">Looking for these columns:</p>
            <ul className="text-[11px] text-sage-700 grid grid-cols-2 gap-x-4">
              {hint.configuredColumns.contactEmail && <li><strong>Email:</strong> {hint.configuredColumns.contactEmail}</li>}
              {hint.configuredColumns.contactName && <li><strong>Name:</strong> {hint.configuredColumns.contactName}</li>}
              {hint.configuredColumns.partnerEmail && <li><strong>Partner email:</strong> {hint.configuredColumns.partnerEmail}</li>}
              {hint.configuredColumns.partnerName && <li><strong>Partner name:</strong> {hint.configuredColumns.partnerName}</li>}
              {hint.configuredColumns.date && <li><strong>Submitted:</strong> {hint.configuredColumns.date}</li>}
              {hint.configuredColumns.weddingDate && <li><strong>Wedding date:</strong> {hint.configuredColumns.weddingDate}</li>}
              {hint.configuredColumns.guestCount && <li><strong>Guests:</strong> {hint.configuredColumns.guestCount}</li>}
              {hint.configuredColumns.notes && <li><strong>Notes:</strong> {hint.configuredColumns.notes}</li>}
              {hint.configuredColumns.calculatedTotal && <li><strong>Total:</strong> {hint.configuredColumns.calculatedTotal}</li>}
            </ul>
            <p className="text-[10px] text-sage-500 mt-1">
              Column matching is case-insensitive with substring fallback.
            </p>
          </div>
        )}

        <div>
          <button
            type="button"
            onClick={() => setShowHintOverrides((v) => !v)}
            className="text-[11px] text-sage-700 underline hover:no-underline"
          >
            {showHintOverrides ? 'Hide' : 'Show'} column-mapping overrides
          </button>
        </div>

        {showHintOverrides && (
          <div className="space-y-2">
            <label className="text-xs font-medium text-sage-700">Hint overrides (JSON)</label>
            <p className="text-[10px] text-sage-500">
              Override the built-in column names. Keys are FormHint fields (contactEmailColumn,
              contactNameColumn, dateColumn, weddingDateColumn, guestCountColumn, notesColumn,
              partnerEmailColumn, partnerNameColumn, packageColumns, upgradeColumns, discountColumns,
              calculatedTotalColumn, etc.).
            </p>
            <textarea
              rows={10}
              value={hintOverridesText}
              onChange={(e) => setHintOverridesText(e.target.value)}
              className="w-full px-3 py-2 text-xs font-mono border border-sage-200 rounded"
            />
          </div>
        )}

        <div className="space-y-2">
          <label className="text-xs font-medium text-sage-700">CSV file</label>
          <div className="flex flex-wrap items-center gap-2">
            <CsvFileInput
              onText={(text) => { setCsv(text); setPreview(null) }}
              onError={(m) => setErrors([m])}
            />
            {csv.trim() && (
              <span className="text-[11px] text-sage-500">
                {csv.split(/\r?\n/).filter((l) => l.trim()).length} line(s) loaded
              </span>
            )}
          </div>
          <details className="text-xs">
            <summary className="cursor-pointer text-sage-500 hover:text-sage-700">
              or paste the CSV text instead
            </summary>
            <textarea
              rows={8}
              value={csv}
              onChange={(e) => { setCsv(e.target.value); setPreview(null) }}
              placeholder="Paste the CSV export (with a header row). Uploading the file above is recommended."
              className="mt-2 w-full px-3 py-2 text-xs font-mono border border-sage-200 rounded"
            />
          </details>
        </div>

        <div className="flex items-center justify-between gap-2">
          <Link
            href="/onboarding/extract-packages"
            className="text-[11px] text-sage-700 underline hover:no-underline"
          >
            Or extract your package catalog from this form first &rarr;
          </Link>
          <div className="flex items-center gap-2">
            {!preview ? (
              <button
                type="button"
                onClick={() => submit(true)}
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
                  Import {previewTotal} submissions
                </button>
              </>
            )}
          </div>
        </div>

        {preview && preview.length > 0 && (
          <div className="border border-sage-200 rounded-lg p-3 bg-sage-50/40 max-h-96 overflow-auto">
            <p className="text-xs font-medium text-sage-900 mb-2">
              Preview &mdash; showing {preview.length} of {previewTotal} submission{previewTotal === 1 ? '' : 's'}
            </p>
            <table className="w-full text-xs">
              <thead className="text-left text-sage-600 sticky top-0 bg-sage-50">
                <tr>
                  <th className="font-medium pb-1 pr-2">Couple</th>
                  <th className="font-medium pb-1 pr-2">Email</th>
                  <th className="font-medium pb-1 pr-2">Submitted</th>
                  <th className="font-medium pb-1 pr-2">Date wanted</th>
                  <th className="font-medium pb-1 pr-2">Guests</th>
                  <th className="font-medium pb-1 text-right">Calc total</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((r, i) => (
                  <tr key={i} className="border-t border-sage-100">
                    <td className="py-1 pr-2">
                      {[r.partner1_first_name, r.partner1_last_name].filter(Boolean).join(' ') || '—'}
                      {(r.partner2_first_name || r.partner2_last_name) && (
                        <span className="text-sage-500">
                          {' & '}{[r.partner2_first_name, r.partner2_last_name].filter(Boolean).join(' ')}
                        </span>
                      )}
                    </td>
                    <td className="py-1 pr-2">{r.partner1_email ?? '—'}</td>
                    <td className="py-1 pr-2">{r.inquiry_date?.slice(0, 10) ?? '—'}</td>
                    <td className="py-1 pr-2">{r.wedding_date ?? '—'}</td>
                    <td className="py-1 pr-2">{r.guest_count_estimate ?? '—'}</td>
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
