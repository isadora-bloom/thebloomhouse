'use client'

/**
 * Tour-scheduler import (T5-Rixey-II).
 *
 * Day-2 onboarding-project sub-step. Coordinator picks a scheduling
 * tool (Calendly / Acuity / Square Appointments / generic .ics /
 * custom), uploads the export, reviews the per-event-type
 * classification (tour vs post-booking touchpoint vs other), optionally
 * overrides the heuristic per event type, then commits.
 *
 * Why dedicated UI (vs reusing /onboarding/crm-import):
 *   The tour-scheduler import has an extra preview step — coordinator
 *   confirms which event-type names map to tours vs post-booking
 *   touchpoints. /onboarding/crm-import is for HoneyBook / Dubsado /
 *   Aisle Planner / generic CRM exports where every row is a lead.
 *   The two flows are conceptually distinct enough that a single page
 *   trying to do both would be confusing.
 *
 * Wire:
 *   POST /api/onboarding/crm-import with adapter='tour_scheduler' and
 *   provider=<calendly|acuity|...>. The route + adapter handle the rest.
 */

import { useEffect, useState } from 'react'
import {
  Upload, AlertCircle, CheckCircle2, Loader2, FileText, Calendar,
  ChevronRight,
} from 'lucide-react'

type ProviderHint =
  | 'calendly'
  | 'acuity'
  | 'square_appointments'
  | 'generic_ical'
  | 'custom'

interface ProviderManifest {
  hint: ProviderHint
  label: string
  description: string
  ready: boolean
}

const PROVIDERS: ProviderManifest[] = [
  {
    hint: 'calendly',
    label: 'Calendly',
    description: 'Validated against the Rixey export. Account → Export → Scheduled events.',
    ready: true,
  },
  {
    hint: 'acuity',
    label: 'Acuity Scheduling',
    description: 'Reports → Appointments → Export CSV. Scaffold only — use Generic CSV in the meantime.',
    ready: false,
  },
  {
    hint: 'square_appointments',
    label: 'Square Appointments',
    description: 'Dashboard → Appointments → Export. Scaffold only.',
    ready: false,
  },
  {
    hint: 'generic_ical',
    label: 'Generic .ics (any RFC-5545 calendar)',
    description: 'Universal fallback for any tool that exports an .ics calendar. Scaffold only.',
    ready: false,
  },
  {
    hint: 'custom',
    label: 'Custom (column-mapping)',
    description: 'Use the Generic CSV adapter at /onboarding/crm-import with a hand-built mapping.',
    ready: false,
  },
]

type EventBucket = 'tour' | 'post_booking_touchpoint' | 'other_interaction'

interface EventTypeTally {
  name: string
  count: number
  defaultBucket: EventBucket
}

interface PreviewRow {
  source_id?: string | null
  partner1_first_name?: string | null
  partner1_last_name?: string | null
  partner1_email?: string | null
  wedding_date?: string | null
  status?: string | null
  guest_count_estimate?: number | null
  source?: string | null
  source_detail?: string | null
  tours?: Array<{ scheduled_at: string; outcome?: string | null; tour_type?: string | null }>
  interactions?: Array<{ subject?: string | null; occurred_at?: string }>
}

const BUCKET_LABEL: Record<EventBucket, string> = {
  tour: 'Tour',
  post_booking_touchpoint: 'Post-booking',
  other_interaction: 'Other',
}

const BUCKET_COLOR: Record<EventBucket, string> = {
  tour: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  post_booking_touchpoint: 'bg-sage-100 text-sage-800 border-sage-200',
  other_interaction: 'bg-amber-100 text-amber-800 border-amber-200',
}

/** Mirror the keyword heuristic in src/lib/services/crm-import/tour-scheduler.ts.
 *  Used to render the default bucket on the per-event-type override panel
 *  WITHOUT making a server roundtrip. */
function defaultBucket(name: string): EventBucket {
  const post = [
    /\bwalkthrough\b/i, /\bdrop\s*off\b/i, /\bplanning\s*meeting\b/i,
    /\bonboarding\b/i, /\bmid[-\s]*way\b/i, /\bvendor\s*meeting\b/i,
    /\brehearsal\b/i, /\bpost[-\s]*book(ing|ed)\b/i, /\bcheck[-\s]*in\b/i,
  ]
  const tour = [
    /\btour\b/i, /\bphone\s*call\b/i, /\bdiscovery\b/i,
    /\bsite\s*visit\b/i, /\bvenue\s*visit\b/i, /\binitial\s*consultation\b/i,
  ]
  const other = [/\bbootcamp\b/i, /\bcoaching\b/i, /\bservice\b/i, /\b1:1\b/i, /\bcourse\b/i]
  for (const re of post) if (re.test(name)) return 'post_booking_touchpoint'
  for (const re of tour) if (re.test(name)) return 'tour'
  for (const re of other) if (re.test(name)) return 'other_interaction'
  return 'other_interaction'
}

/** Pull the per-event-type tally line out of the warnings payload the
 *  adapter sets ("Event type tally:\n  X × N → bucket\n  ..."). Lets us
 *  render the override-config panel without a separate tally endpoint. */
function extractEventTypeTally(warnings: string[]): EventTypeTally[] {
  const tallyWarn = warnings.find((w) => w.startsWith('Event type tally:'))
  if (!tallyWarn) return []
  const lines = tallyWarn.split('\n').slice(1).map((l) => l.trim()).filter(Boolean)
  const out: EventTypeTally[] = []
  for (const line of lines) {
    // Format: "<name> × <count> → <bucket>"
    const m = line.match(/^(.+?)\s+×\s+(\d+)\s+→\s+(tour|post_booking_touchpoint|other_interaction)$/)
    if (!m) continue
    out.push({
      name: m[1].trim(),
      count: Number.parseInt(m[2] ?? '0', 10),
      defaultBucket: m[3] as EventBucket,
    })
  }
  return out
}

export default function TourSchedulerImportPage() {
  const [provider, setProvider] = useState<ProviderHint>('calendly')
  const [csv, setCsv] = useState('')
  const [overrides, setOverrides] = useState<Record<string, EventBucket>>({})
  const [tally, setTally] = useState<EventTypeTally[]>([])

  const [preview, setPreview] = useState<PreviewRow[] | null>(null)
  const [previewTotal, setPreviewTotal] = useState(0)
  const [errors, setErrors] = useState<string[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [success, setSuccess] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Reset preview/messages whenever the inputs change.
  useEffect(() => {
    setPreview(null)
    setErrors([])
    setWarnings([])
    setSuccess(null)
  }, [provider, csv])

  function clearMessages() {
    setErrors([])
    setWarnings([])
    setSuccess(null)
  }

  const selectedProvider = PROVIDERS.find((p) => p.hint === provider)
  const isReady = selectedProvider?.ready ?? false

  async function submit(asPreview: boolean) {
    clearMessages()
    if (!csv.trim()) { setErrors(['csv content is empty']); return }
    if (!isReady) {
      setErrors([`Provider '${provider}' is scaffold-only — pick Calendly or use the Generic CSV adapter at /onboarding/crm-import.`])
      return
    }

    setBusy(true)
    try {
      const res = await fetch('/api/onboarding/crm-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adapter: 'tour_scheduler',
          provider,
          csv,
          // The override map is keyed by Event Type Name and the value
          // is the desired bucket — the adapter consumes columnMapping
          // for this since the AdapterConfig contract already has the
          // field. (Technical reuse, not a perfect semantic match —
          // documented at the adapter's parseTourScheduler call site.)
          columnMapping: Object.keys(overrides).length > 0 ? overrides : undefined,
          preview: asPreview,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setErrors(data.errors ?? [data.error ?? `HTTP ${res.status}`])
        if (Array.isArray(data.warnings)) {
          setWarnings(data.warnings)
          // Even on error, the tally line might be present (parser ran
          // far enough to bucket events before erroring on a row).
          const t = extractEventTypeTally(data.warnings)
          if (t.length > 0) setTally(t)
        }
        setPreview(null)
        return
      }
      if (Array.isArray(data.warnings)) {
        setWarnings(data.warnings)
        const t = extractEventTypeTally(data.warnings)
        if (t.length > 0) setTally(t)
      }
      if (asPreview) {
        setPreview(data.rows ?? [])
        setPreviewTotal(data.total ?? 0)
      } else {
        setSuccess(
          `Imported ${data.weddings_inserted} weddings · ` +
          `${data.tours_inserted} tours · ` +
          `${data.interactions_inserted} interactions`
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
          <Calendar className="w-6 h-6 text-sage-700" />
          <h1 className="font-heading text-2xl font-semibold text-sage-900">Import tour scheduler history</h1>
        </div>
        <p className="text-sm text-sage-600 max-w-2xl">
          Backfill historical tour bookings + post-booking touchpoints
          from your scheduling tool. Each event type is bucketed as a
          tour, a post-booking touchpoint, or a service interaction;
          you can override the default bucketing per event type below
          before committing.
        </p>
      </header>

      <section className="bg-white border border-sage-200 rounded-xl p-5 shadow-sm space-y-4">
        <div className="space-y-2">
          <label className="text-xs font-medium text-sage-700">Scheduling tool</label>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {PROVIDERS.map((p) => (
              <button
                key={p.hint}
                type="button"
                onClick={() => { setProvider(p.hint); setOverrides({}); setTally([]) }}
                disabled={!p.ready && p.hint !== provider}
                className={`text-left p-3 rounded border transition-colors ${
                  provider === p.hint
                    ? 'border-sage-700 bg-sage-50'
                    : p.ready
                      ? 'border-sage-200 hover:bg-sage-50'
                      : 'border-sage-100 bg-sage-50/40 opacity-60 cursor-not-allowed'
                }`}
                title={p.description}
              >
                <p className="text-sm font-medium text-sage-900">{p.label}</p>
                <p className="text-[10px] text-sage-500 mt-1 line-clamp-2">{p.description}</p>
                {!p.ready && <p className="text-[10px] text-amber-700 mt-1 font-medium">Scaffold only</p>}
              </button>
            ))}
          </div>
        </div>

        {provider === 'calendly' && (
          <div className="space-y-2 bg-sage-50/40 border border-sage-200 rounded-lg p-3">
            <p className="text-xs font-medium text-sage-900">Calendly export instructions</p>
            <ol className="list-decimal list-inside text-[11px] text-sage-700 space-y-1">
              <li>In Calendly, go to <strong>Account → Export</strong>.</li>
              <li>Select the date range you want to import (recommend 12 months).</li>
              <li>Download the CSV and paste the contents into the box below.</li>
            </ol>
            <p className="text-[11px] text-sage-700">
              Required columns: <code className="bg-white px-1 rounded">Event Type Name</code>,{' '}
              <code className="bg-white px-1 rounded">Start Date &amp; Time</code>,{' '}
              <code className="bg-white px-1 rounded">Invitee Email</code>. The standard Calendly
              export includes all columns by default.
            </p>
          </div>
        )}

        <div className="space-y-2">
          <label className="text-xs font-medium text-sage-700">CSV content</label>
          <textarea
            rows={8}
            value={csv}
            onChange={(e) => { setCsv(e.target.value) }}
            placeholder="Paste the scheduler export CSV (with a header row)."
            className="w-full px-3 py-2 text-xs font-mono border border-sage-200 rounded"
          />
        </div>

        <div className="flex items-center justify-end gap-2">
          {!preview ? (
            <button
              type="button"
              onClick={() => submit(true)}
              disabled={busy || !isReady}
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
                Import {previewTotal} couples
              </button>
            </>
          )}
        </div>
      </section>

      {tally.length > 0 && (
        <section className="bg-white border border-sage-200 rounded-xl p-5 shadow-sm space-y-3">
          <div>
            <h2 className="text-sm font-medium text-sage-900 flex items-center gap-2">
              <ChevronRight className="w-4 h-4" />
              Event-type classification
            </h2>
            <p className="text-xs text-sage-500 mt-1">
              Each event type is bucketed by a keyword heuristic. Override per
              event type below if the default is wrong; your override is saved
              for this import only.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-sage-600">
                <tr>
                  <th className="font-medium pb-2 pr-3">Event type</th>
                  <th className="font-medium pb-2 pr-3 text-right">Count</th>
                  <th className="font-medium pb-2 pr-3">Default</th>
                  <th className="font-medium pb-2">Override</th>
                </tr>
              </thead>
              <tbody>
                {tally.map((t) => {
                  const current = overrides[t.name] ?? t.defaultBucket
                  return (
                    <tr key={t.name} className="border-t border-sage-100">
                      <td className="py-2 pr-3 font-medium text-sage-900 max-w-[20rem]">
                        <div className="truncate" title={t.name}>{t.name}</div>
                      </td>
                      <td className="py-2 pr-3 text-right text-sage-600">{t.count}</td>
                      <td className="py-2 pr-3">
                        <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] border ${BUCKET_COLOR[t.defaultBucket]}`}>
                          {BUCKET_LABEL[t.defaultBucket]}
                        </span>
                      </td>
                      <td className="py-2">
                        <select
                          value={current}
                          onChange={(e) => {
                            const next = { ...overrides }
                            const val = e.target.value as EventBucket
                            if (val === t.defaultBucket) delete next[t.name]
                            else next[t.name] = val
                            setOverrides(next)
                          }}
                          className="border border-sage-200 rounded px-1 py-0.5 text-[11px] bg-white"
                        >
                          <option value="tour">Tour</option>
                          <option value="post_booking_touchpoint">Post-booking</option>
                          <option value="other_interaction">Other</option>
                        </select>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {Object.keys(overrides).length > 0 && (
            <p className="text-[11px] text-sage-600">
              {Object.keys(overrides).length} override(s) applied. Click <strong>Preview</strong> again to see updated bucketing.
            </p>
          )}
        </section>
      )}

      {preview && preview.length > 0 && (
        <section className="bg-white border border-sage-200 rounded-xl p-5 shadow-sm space-y-3">
          <h2 className="text-sm font-medium text-sage-900">
            Preview — showing {preview.length} of {previewTotal} couple{previewTotal === 1 ? '' : 's'}
          </h2>
          <div className="border border-sage-100 rounded-lg max-h-96 overflow-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-sage-600 sticky top-0 bg-sage-50">
                <tr>
                  <th className="font-medium p-2">Couple</th>
                  <th className="font-medium p-2">Email</th>
                  <th className="font-medium p-2">Wedding date</th>
                  <th className="font-medium p-2">Guests</th>
                  <th className="font-medium p-2">Source</th>
                  <th className="font-medium p-2">Status</th>
                  <th className="font-medium p-2 text-right">Tours</th>
                  <th className="font-medium p-2 text-right">Touches</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((r, i) => (
                  <tr key={i} className="border-t border-sage-100">
                    <td className="p-2">
                      {[r.partner1_first_name, r.partner1_last_name].filter(Boolean).join(' ') || '—'}
                    </td>
                    <td className="p-2">{r.partner1_email ?? '—'}</td>
                    <td className="p-2">{r.wedding_date ?? '—'}</td>
                    <td className="p-2 text-right">{r.guest_count_estimate ?? '—'}</td>
                    <td className="p-2">
                      <span className="text-[10px]">{r.source ?? '—'}</span>
                      {r.source_detail && (
                        <span className="text-[10px] text-sage-400 block truncate max-w-[10rem]" title={r.source_detail}>
                          {r.source_detail}
                        </span>
                      )}
                    </td>
                    <td className="p-2">{r.status ?? '—'}</td>
                    <td className="p-2 text-right">{r.tours?.length ?? 0}</td>
                    <td className="p-2 text-right">{r.interactions?.length ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {errors.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800 space-y-1">
          {errors.map((e, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span className="whitespace-pre-wrap">{e}</span>
            </div>
          ))}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="bg-amber-50/50 border border-amber-200 rounded-lg p-3 text-xs text-amber-700 space-y-1">
          <p className="font-medium">Notes:</p>
          {warnings.filter((w) => !w.startsWith('Event type tally:')).map((w, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
              <span className="whitespace-pre-wrap">{w}</span>
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
