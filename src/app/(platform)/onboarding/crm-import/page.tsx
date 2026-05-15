'use client'

/**
 * CRM-import (T5-followup-Y / Pattern I closure).
 *
 * Day-3 onboarding-project sub-step. Coordinator picks an adapter,
 * uploads a CSV, previews the parsed rows, and commits.
 *
 * Universal-importer additions (2026-05-15):
 *   - Smart import (ai_mapped) - for ANY unrecognised CSV. The server
 *     runs an LLM to PROPOSE a column mapping; this UI renders a
 *     confirm/correct table and re-submits the confirmed mapping.
 *   - Storefront activity (storefront_activity) - The Knot / WeddingWire
 *     funnel exports. Rows become discovery-funnel signals, not couples.
 *   - Website pixel (site_visitors) - visitor + pageview exports. An
 *     optional second file (site_visits) attaches browsing history.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  Upload, AlertCircle, CheckCircle2, Loader2, FileText, Database, Wand2,
} from 'lucide-react'
import { CsvFileInput } from '@/components/onboarding/CsvFileInput'

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

interface ProposedMappingDetail {
  bloom_field: string
  csv_header: string
  confidence: number
  reason: string
}

interface ProposedMapping {
  mapping: Record<string, string>
  detail: ProposedMappingDetail[]
  unmapped_headers: string[]
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

// Bloom fields the AI-mapped confirm/correct table offers in its
// per-column dropdown. Mirrors AI_MAPPABLE_FIELDS in ai-mapped.ts.
const AI_MAPPABLE_FIELDS = [
  'partner1_first_name', 'partner1_last_name', 'partner1_email', 'partner1_phone',
  'partner2_first_name', 'partner2_last_name', 'partner2_email', 'partner2_phone',
  'wedding_date', 'guest_count_estimate', 'booking_value', 'amount_paid',
  'deposit_amount', 'tax_amount', 'gratuity_amount', 'refunded_amount',
  'package_name', 'status', 'source', 'source_detail', 'inquiry_date',
  'booked_at', 'lost_at', 'lost_reason', 'notes',
]

export default function CrmImportPage() {
  const [adapters, setAdapters] = useState<AdapterManifest[]>([])
  const [selectedAdapter, setSelectedAdapter] = useState<string>('generic_csv')
  const [csv, setCsv] = useState('')
  // site-visitors adapter: optional second file (per-pageview detail).
  const [visitsCsv, setVisitsCsv] = useState('')
  const [mappingText, setMappingText] = useState(DEFAULT_MAPPING_TEMPLATE)

  const [preview, setPreview] = useState<PreviewRow[] | null>(null)
  const [previewTotal, setPreviewTotal] = useState(0)
  const [errors, setErrors] = useState<string[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [success, setSuccess] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // AI-mapped flow: the proposed mapping awaiting coordinator confirmation.
  // confirmedMapping is the (possibly edited) bloom_field -> csv_header map
  // the coordinator approves before committing.
  const [proposedMapping, setProposedMapping] = useState<ProposedMapping | null>(null)
  const [confirmedMapping, setConfirmedMapping] = useState<Record<string, string>>({})

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
  const showMapping = selectedAdapter === 'generic_csv'
  const isAiMapped = selectedAdapter === 'ai_mapped'
  const isStorefront = selectedAdapter === 'storefront_activity'
  const isSiteVisitors = selectedAdapter === 'site_visitors'
  const isHoneybook = selectedAdapter === 'honeybook'

  // Headers from the loaded CSV - used to populate the AI-mapped
  // confirm/correct table's per-field column picker.
  const csvHeaders = useMemo(() => {
    const firstLine = csv.split(/\r?\n/).find((l) => l.trim()) ?? ''
    if (!firstLine) return [] as string[]
    // Light split - good enough for the dropdown; the server parses
    // properly. Handles the common no-embedded-comma header case.
    return firstLine.split(/[,\t]/).map((h) => h.replace(/^"|"$/g, '').trim())
  }, [csv])

  function clearMessages() {
    setErrors([])
    setWarnings([])
    setSuccess(null)
    setSkippedRows([])
    setWriteErrors([])
    setSchemaHint(null)
  }

  function resetForAdapterChange(name: string) {
    setSelectedAdapter(name)
    setPreview(null)
    setProposedMapping(null)
    setConfirmedMapping({})
    clearMessages()
  }

  /**
   * action: 'preview' | 'import' | 'propose' | 'commit-confirmed'.
   *   propose          - AI-mapped: ask the server for a column mapping.
   *   commit-confirmed - AI-mapped: import using the confirmed mapping.
   *   preview / import - every other adapter.
   */
  async function submit(action: 'preview' | 'import' | 'propose' | 'commit-confirmed') {
    clearMessages()
    if (!csv.trim() && !(isSiteVisitors && visitsCsv.trim())) {
      setErrors(['csv content is empty'])
      return
    }

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

    const body: Record<string, unknown> = {
      adapter: selectedAdapter,
      csv,
      columnMapping,
      preview: action === 'preview',
    }
    if (isSiteVisitors && visitsCsv.trim()) body.visitsCsvText = visitsCsv
    if (action === 'commit-confirmed') {
      body.confirmedMapping = confirmedMapping
      body.preview = false
    }

    setBusy(true)
    try {
      const res = await fetch('/api/onboarding/crm-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()

      // AI-mapped proposal - the server returns a proposed mapping that
      // the coordinator must confirm before anything commits.
      if (data.proposal_only) {
        if (data.proposed_mapping) {
          const pm = data.proposed_mapping as ProposedMapping
          setProposedMapping(pm)
          setConfirmedMapping({ ...pm.mapping })
        }
        if (Array.isArray(data.warnings)) setWarnings(data.warnings)
        if (Array.isArray(data.errors) && data.errors.length) setErrors(data.errors)
        setPreview(null)
        return
      }

      if (!res.ok) {
        setErrors(data.errors ?? [data.error ?? `HTTP ${res.status}`])
        if (Array.isArray(data.warnings)) setWarnings(data.warnings)
        setPreview(null)
        return
      }
      if (Array.isArray(data.warnings)) setWarnings(data.warnings)

      if (data.preview) {
        setPreview(data.rows ?? [])
        setPreviewTotal(data.total ?? 0)
      } else {
        setSuccess(
          (data.message ?? `Imported ${data.weddings_inserted} of ${data.total_rows}.`) +
          ` (${data.weddings_inserted} new · ${data.weddings_matched_existing ?? 0} matched existing · ` +
          `${data.interactions_inserted} interactions/signals · ${data.tours_inserted} tours · ` +
          `${data.lost_deals_inserted} lost deals)`
        )
        setSkippedRows(Array.isArray(data.skipped_invalid) ? data.skipped_invalid : [])
        setWriteErrors(Array.isArray(data.write_errors) ? data.write_errors : [])
        setSchemaHint(typeof data.schema_hint === 'string' ? data.schema_hint : null)
        if (data.ok) {
          setPreview(null)
          setProposedMapping(null)
          setCsv('')
          setVisitsCsv('')
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
          <h1 className="font-heading text-2xl font-semibold text-sage-900">Import venue data</h1>
        </div>
        <p className="text-sm text-sage-600 max-w-2xl">
          Upload any structured export - CRM history, marketplace activity, website
          visitors - so the Forensic Record isn&apos;t a blank slate. If your file
          shape isn&apos;t recognised, use <strong>Smart import</strong>: Bloom proposes
          a column mapping with AI and you confirm it before anything is saved.
        </p>
      </header>

      <div className="rounded-xl border border-sage-300 bg-sage-50 p-4 text-sm text-sage-800">
        <p className="font-medium text-sage-900">Upload your booked couples first.</p>
        <p className="mt-1 text-sage-700">
          Your CRM export of booked clients should be the <strong>first</strong> thing
          you import - those couples are the anchors Bloom reconstructs everything else
          from. Connect Gmail, Calendly, storefront and website-pixel exports
          <em> after</em> this import finishes.
        </p>
      </div>

      <section className="bg-white border border-sage-200 rounded-xl p-5 shadow-sm space-y-4">
        <div className="space-y-2">
          <label className="text-xs font-medium text-sage-700">Provider</label>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {adapters.map((a) => (
              <button
                key={a.name}
                type="button"
                onClick={() => resetForAdapterChange(a.name)}
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
                <p className="text-sm font-medium text-sage-900 flex items-center gap-1">
                  {a.name === 'ai_mapped' && <Wand2 className="w-3.5 h-3.5 text-sage-600" />}
                  {a.label}
                </p>
                <p className="text-[10px] text-sage-500 mt-1 line-clamp-3">{a.description}</p>
                {!a.ready && <p className="text-[10px] text-amber-700 mt-1 font-medium">Scaffold only</p>}
              </button>
            ))}
          </div>
          {adapter && !adapter.ready && (
            <p className="text-xs text-amber-700">
              The {adapter.label} adapter is scaffold-only. Use Smart import (AI column
              mapping) or Generic CSV instead.
            </p>
          )}
        </div>

        {isAiMapped && (
          <div className="rounded-lg bg-sage-50/60 border border-sage-200 p-3 text-[11px] text-sage-700 space-y-1">
            <p className="font-medium text-sage-900 flex items-center gap-1">
              <Wand2 className="w-3.5 h-3.5" /> How Smart import works
            </p>
            <p>
              Upload your file and Bloom sends the header row plus a few sample rows
              to AI, which proposes which columns map to which Bloom fields. You review
              and correct the proposed mapping before anything is imported. Every
              original column is preserved even if it isn&apos;t mapped.
            </p>
          </div>
        )}

        {showMapping && (
          <div className="space-y-2">
            <label className="text-xs font-medium text-sage-700">Column mapping (JSON)</label>
            <p className="text-[10px] text-sage-500">
              Map Bloom field names → your CSV header names. Unmapped fields are dropped.
              Not sure? Use <strong>Smart import</strong> instead and let AI propose the mapping.
            </p>
            <textarea
              rows={10}
              value={mappingText}
              onChange={(e) => setMappingText(e.target.value)}
              className="w-full px-3 py-2 text-xs font-mono border border-sage-200 rounded"
            />
          </div>
        )}

        {isStorefront && (
          <div className="rounded-lg bg-sage-50/60 border border-sage-200 p-3 text-[11px] text-sage-700 space-y-1">
            <p className="font-medium text-sage-900">Storefront activity</p>
            <p>
              Export your storefront-activity report from The Knot or WeddingWire - every
              view, save, message, and click. Visitor names are partial (&quot;Jayden P.&quot;)
              so rows become discovery-funnel signals, not couples. <strong>Messages</strong> are
              flagged as real inquiries. For the leads export (couples who actually inquired),
              use the The Knot adapter.
            </p>
          </div>
        )}

        {isSiteVisitors && (
          <div className="rounded-lg bg-sage-50/60 border border-sage-200 p-3 text-[11px] text-sage-700 space-y-1">
            <p className="font-medium text-sage-900">Website pixel</p>
            <p>
              Upload your <code className="bg-white px-1 rounded">site_visitors</code> export
              (one row per visitor). Identified visitors (email present) attach to couples
              with their first-touch UTM recorded as the acquisition channel. Optionally add
              the <code className="bg-white px-1 rounded">site_visits</code> file below to
              attach each couple&apos;s full browsing history.
            </p>
          </div>
        )}

        {isHoneybook && (
          <div className="space-y-2 bg-sage-50/40 border border-sage-200 rounded-lg p-3">
            <p className="text-xs font-medium text-sage-900">HoneyBook export instructions</p>
            <ol className="list-decimal list-inside text-[11px] text-sage-700 space-y-1">
              <li>In HoneyBook, go to <strong>Settings → Reports → Projects</strong>.</li>
              <li>Click <strong>Export as CSV</strong>.</li>
              <li>Open the CSV and paste the contents into the box below.</li>
            </ol>
          </div>
        )}

        <div className="space-y-2">
          <label className="text-xs font-medium text-sage-700">
            {isSiteVisitors ? 'site_visitors CSV' : 'CSV file'}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <CsvFileInput
              onText={(text) => {
                clearMessages()
                setCsv(text)
                setPreview(null)
                setProposedMapping(null)
                // Auto-route by header signature. Without this an
                // operator can upload a Knot storefront file under the
                // wrong adapter and mint a junk wedding per row.
                const firstLine = (text.split(/\r?\n/).find((l) => l.trim()) ?? '')
                  .toLowerCase()
                let detected: string | null = null
                if (firstLine.includes('action taken')) detected = 'storefront_activity'
                else if (
                  firstLine.includes('visitor_id') &&
                  (firstLine.includes('first_seen_at') || firstLine.includes('pageview_count'))
                ) detected = 'site_visitors'
                else if (firstLine.includes('project name')) detected = 'honeybook'
                if (detected && detected !== selectedAdapter) {
                  resetForAdapterChange(detected)
                  setCsv(text)
                  setWarnings([
                    `Detected a ${detected === 'storefront_activity'
                      ? 'storefront-activity export'
                      : detected === 'site_visitors'
                        ? 'website-visitor export'
                        : 'HoneyBook export'} — switched the provider to match.`,
                  ])
                }
              }}
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
              onChange={(e) => { setCsv(e.target.value); setPreview(null); setProposedMapping(null) }}
              placeholder="Paste the CSV export (with a header row)."
              className="mt-2 w-full px-3 py-2 text-xs font-mono border border-sage-200 rounded"
            />
          </details>
        </div>

        {isSiteVisitors && (
          <div className="space-y-2">
            <label className="text-xs font-medium text-sage-700">
              site_visits CSV (optional - per-pageview detail)
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <CsvFileInput
                label="Choose site_visits file"
                onText={(text) => { setVisitsCsv(text) }}
                onError={(m) => setErrors([m])}
              />
              {visitsCsv.trim() && (
                <span className="text-[11px] text-sage-500">
                  {visitsCsv.split(/\r?\n/).filter((l) => l.trim()).length} pageview line(s)
                </span>
              )}
            </div>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center justify-end gap-2">
          {isAiMapped ? (
            // Smart-import flow: propose -> confirm -> commit.
            proposedMapping ? (
              <>
                <button
                  type="button"
                  onClick={() => { setProposedMapping(null); setConfirmedMapping({}) }}
                  className="text-sm text-sage-700 hover:bg-sage-50 px-3 py-2 rounded"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => submit('commit-confirmed')}
                  disabled={busy || Object.keys(confirmedMapping).length === 0}
                  className="inline-flex items-center gap-1.5 rounded bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white text-sm font-medium px-3 py-2"
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                  Confirm mapping &amp; import
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => submit('propose')}
                disabled={busy || !csv.trim()}
                className="inline-flex items-center gap-1.5 rounded bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white text-sm font-medium px-3 py-2"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                Analyse file with AI
              </button>
            )
          ) : !preview ? (
            <button
              type="button"
              onClick={() => submit('preview')}
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
                onClick={() => submit('import')}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white text-sm font-medium px-3 py-2"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                Import
              </button>
            </>
          )}
        </div>

        {/* AI-mapped: confirm / correct table */}
        {isAiMapped && proposedMapping && (
          <div className="border border-sage-200 rounded-lg p-3 bg-sage-50/40 space-y-3">
            <p className="text-xs font-medium text-sage-900">
              AI proposed this column mapping. Review and correct it, then import.
            </p>
            <table className="w-full text-xs">
              <thead className="text-left text-sage-600">
                <tr>
                  <th className="font-medium pb-1 pr-2">Bloom field</th>
                  <th className="font-medium pb-1 pr-2">Your column</th>
                  <th className="font-medium pb-1 pr-2">Confidence</th>
                  <th className="font-medium pb-1">Why</th>
                </tr>
              </thead>
              <tbody>
                {AI_MAPPABLE_FIELDS
                  .filter((f) => confirmedMapping[f] || proposedMapping.mapping[f])
                  .map((field) => {
                    const detail = proposedMapping.detail.find((d) => d.bloom_field === field)
                    return (
                      <tr key={field} className="border-t border-sage-100">
                        <td className="py-1 pr-2 font-mono text-sage-800">{field}</td>
                        <td className="py-1 pr-2">
                          <select
                            value={confirmedMapping[field] ?? ''}
                            onChange={(e) => {
                              const next = { ...confirmedMapping }
                              if (e.target.value) next[field] = e.target.value
                              else delete next[field]
                              setConfirmedMapping(next)
                            }}
                            className="border border-sage-200 rounded px-1 py-0.5 text-xs"
                          >
                            <option value="">(not mapped)</option>
                            {csvHeaders.map((h) => (
                              <option key={h} value={h}>{h}</option>
                            ))}
                          </select>
                        </td>
                        <td className="py-1 pr-2">
                          {detail ? (
                            <span className={
                              detail.confidence >= 80 ? 'text-emerald-700'
                                : detail.confidence >= 50 ? 'text-amber-700'
                                  : 'text-red-700'
                            }>
                              {detail.confidence}%
                            </span>
                          ) : '-'}
                        </td>
                        <td className="py-1 text-sage-500">{detail?.reason ?? 'manually mapped'}</td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>

            {/* Add an extra mapping for a field the AI did not propose. */}
            <details className="text-[11px]">
              <summary className="cursor-pointer text-sage-500 hover:text-sage-700">
                map another field
              </summary>
              <div className="mt-2 flex flex-wrap gap-2">
                {AI_MAPPABLE_FIELDS
                  .filter((f) => !confirmedMapping[f] && !proposedMapping.mapping[f])
                  .map((field) => (
                    <button
                      key={field}
                      type="button"
                      onClick={() => setConfirmedMapping({
                        ...confirmedMapping,
                        [field]: csvHeaders[0] ?? '',
                      })}
                      className="font-mono text-[10px] border border-sage-200 rounded px-1.5 py-0.5 hover:bg-sage-100"
                    >
                      + {field}
                    </button>
                  ))}
              </div>
            </details>

            {proposedMapping.unmapped_headers.length > 0 && (
              <p className="text-[11px] text-sage-500">
                Columns not mapped to a field (still preserved in the record):{' '}
                {proposedMapping.unmapped_headers.join(', ')}
              </p>
            )}
          </div>
        )}

        {/* Standard preview table */}
        {preview && preview.length > 0 && (
          <div className="border border-sage-200 rounded-lg p-3 bg-sage-50/40 max-h-96 overflow-auto">
            <p className="text-xs font-medium text-sage-900 mb-2">
              Preview - showing {preview.length} of {previewTotal} row{previewTotal === 1 ? '' : 's'}
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
                      {[r.partner1_first_name, r.partner1_last_name].filter(Boolean).join(' ') || '-'}
                    </td>
                    <td className="py-1 pr-2">{r.partner1_email ?? '-'}</td>
                    <td className="py-1 pr-2">{r.wedding_date ?? '-'}</td>
                    <td className="py-1 pr-2">{r.status ?? '-'}</td>
                    <td className="py-1 text-right">
                      {r.booking_value != null
                        ? (r.booking_value / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
                        : '-'}
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
          <p className="font-medium">Notes:</p>
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

      {schemaHint && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-xs text-red-900 flex items-start gap-1.5">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Database is behind</p>
            <p>{schemaHint}</p>
          </div>
        </div>
      )}

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

      {skippedRows.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800 space-y-1">
          <p className="font-medium">
            {skippedRows.length} row{skippedRows.length === 1 ? '' : 's'} skipped - data didn&apos;t validate:
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
