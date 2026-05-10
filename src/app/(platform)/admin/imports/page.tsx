'use client'

/**
 * Imports admin page (Wave 4 Phase 4c).
 *
 * Operator-facing list of every CSV/PDF the unified import-router has
 * persisted, with the per-skip-reason breakdown + a "Reprocess" button
 * that re-runs the file through the current adapter set.
 *
 * Data source: public.import_runs (migration 270). Venue-scoped via RLS
 * — the page reads through the browser supabase client which carries
 * the operator's session, so RLS naturally limits to their venue.
 *
 * The "Reprocess" button is the recovery path for historical mis-routes
 * (the HoneyBook-via-platform-signals case that motivated Phase 4c).
 * Clicking it re-reads the bytes from storage and runs them through the
 * current detector + adapter set; the same import_runs row gets updated
 * in-place with the new counts.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  Database,
  AlertCircle,
  Loader2,
  RefreshCw,
  FileSpreadsheet,
  Clock,
  CheckCircle2,
  XCircle,
  Eye,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'

interface ImportRunRow {
  id: string
  source_path: string | null
  storage_bucket: string | null
  storage_path: string | null
  filename: string | null
  mime_type: string | null
  file_size_bytes: number | null
  detected_shape: string | null
  adapter_used: string | null
  rows_attempted: number | null
  rows_inserted: number | null
  rows_updated: number | null
  rows_skipped: number | null
  skip_reasons: Record<string, number> | null
  errors: string[] | null
  status: string
  reconstruction_enqueued_count: number
  ingested_at: string
  completed_at: string | null
}

export default function ImportsAdminPage() {
  const venueId = useVenueId()
  const supabase = useMemo(() => createClient(), [])

  const [rows, setRows] = useState<ImportRunRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reprocessingId, setReprocessingId] = useState<string | null>(null)
  const [skipModalRow, setSkipModalRow] = useState<ImportRunRow | null>(null)

  const reload = useMemo(
    () => async () => {
      if (!venueId) return
      setLoading(true)
      setError(null)
      try {
        const { data, error: queryErr } = await supabase
          .from('import_runs')
          .select(
            'id, source_path, storage_bucket, storage_path, filename, mime_type, ' +
              'file_size_bytes, detected_shape, adapter_used, rows_attempted, ' +
              'rows_inserted, rows_updated, rows_skipped, skip_reasons, errors, ' +
              'status, reconstruction_enqueued_count, ingested_at, completed_at',
          )
          .eq('venue_id', venueId)
          .order('ingested_at', { ascending: false })
          .limit(100)
        if (queryErr) throw queryErr
        setRows(((data ?? []) as unknown) as ImportRunRow[])
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load imports')
      } finally {
        setLoading(false)
      }
    },
    [supabase, venueId],
  )

  useEffect(() => {
    void reload()
  }, [reload])

  const totals = useMemo(() => {
    const sum = rows.reduce(
      (acc, row) => {
        acc.imports += 1
        acc.rowsInserted += row.rows_inserted ?? 0
        acc.weddingsReconstructed += row.reconstruction_enqueued_count ?? 0
        if (row.status === 'failed') acc.failed += 1
        return acc
      },
      { imports: 0, rowsInserted: 0, weddingsReconstructed: 0, failed: 0 },
    )
    return sum
  }, [rows])

  const reprocess = async (importRunId: string) => {
    setReprocessingId(importRunId)
    try {
      const r = await fetch('/api/admin/imports/reprocess', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ importRunId }),
      })
      const j = (await r.json()) as { error?: string }
      if (!r.ok) {
        throw new Error(j.error ?? `reprocess failed (${r.status})`)
      }
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reprocess failed')
    } finally {
      setReprocessingId(null)
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-8">
      <header>
        <h1 className="text-2xl font-serif text-sage-900 flex items-center gap-3">
          <Database className="w-6 h-6 text-sage-700" />
          Imports
        </h1>
        <p className="text-sage-600 mt-2 text-sm max-w-2xl">
          Every CSV/PDF the unified import-router has persisted. Raw bytes are
          retained so a mis-routed import can be reprocessed against the
          current adapter set. Each completed run also enqueues identity
          reconstruction for every wedding the import touched.
        </p>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <Stat label="Past imports" value={totals.imports} />
        <Stat label="Rows ingested" value={totals.rowsInserted} />
        <Stat
          label="Weddings reconstructed"
          value={totals.weddingsReconstructed}
        />
        <Stat label="Failed runs" value={totals.failed} tone="danger" />
      </div>

      {error && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-rose-600 mt-0.5" />
          <div className="text-sm text-rose-800">{error}</div>
        </div>
      )}

      {loading && (
        <div className="text-sage-600 text-sm flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading imports…
        </div>
      )}

      {!loading && rows.length === 0 && (
        <div className="text-sm text-sage-500 italic">
          No imports on record yet. Drop a CSV via brain-dump or the
          /onboarding/crm-import flow to populate this list.
        </div>
      )}

      {!loading && rows.length > 0 && (
        <ul className="divide-y divide-border bg-surface rounded-lg border border-border">
          {rows.map((row) => {
            const reconstructionTotal = row.reconstruction_enqueued_count ?? 0
            const inserted = row.rows_inserted ?? 0
            const updated = row.rows_updated ?? 0
            const skipped = row.rows_skipped ?? 0
            return (
              <li
                key={row.id}
                className="p-4 flex flex-col sm:flex-row sm:items-center gap-4 text-sm"
              >
                <div className="flex items-start gap-3 flex-1 min-w-0">
                  <FileSpreadsheet className="w-5 h-5 text-sage-700 mt-0.5 flex-shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sage-900 font-medium truncate">
                      {row.filename ?? row.storage_path ?? row.id.slice(0, 8)}
                    </div>
                    <div className="text-sage-500 text-xs flex items-center gap-2 mt-1 flex-wrap">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {new Date(row.ingested_at).toLocaleString()}
                      </span>
                      {row.source_path && (
                        <span className="px-2 py-0.5 bg-sage-50 rounded text-sage-700">
                          {row.source_path}
                        </span>
                      )}
                      {row.detected_shape && (
                        <span className="px-2 py-0.5 bg-gold-50 rounded text-gold-700">
                          shape: {row.detected_shape}
                        </span>
                      )}
                      {row.adapter_used && (
                        <span className="px-2 py-0.5 bg-teal-50 rounded text-teal-700">
                          adapter: {row.adapter_used}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-4 text-xs">
                  <div className="text-sage-700">
                    <div>{inserted} inserted</div>
                    <div className="text-sage-500">
                      {updated} updated · {skipped} skipped
                    </div>
                  </div>
                  <div className="text-sage-700">
                    <div>{reconstructionTotal} reconstructed</div>
                  </div>
                  <StatusBadge status={row.status} />
                </div>

                <div className="flex items-center gap-2">
                  {row.skip_reasons && Object.keys(row.skip_reasons).length > 0 && (
                    <button
                      onClick={() => setSkipModalRow(row)}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-sage-300 hover:bg-sage-50"
                      title="Show skip-reason breakdown"
                    >
                      <Eye className="w-3 h-3" />
                      Skip reasons
                    </button>
                  )}
                  <button
                    onClick={() => void reprocess(row.id)}
                    disabled={reprocessingId === row.id}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-sage-300 hover:bg-sage-50 disabled:opacity-50"
                    title="Re-run this file through the current adapter set"
                  >
                    {reprocessingId === row.id ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <RefreshCw className="w-3 h-3" />
                    )}
                    Reprocess
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {skipModalRow && (
        <SkipReasonsModal
          row={skipModalRow}
          onClose={() => setSkipModalRow(null)}
        />
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: number
  tone?: 'default' | 'danger'
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        tone === 'danger'
          ? 'border-rose-200 bg-rose-50'
          : 'border-border bg-surface'
      }`}
    >
      <div
        className={`text-2xl font-serif ${
          tone === 'danger' ? 'text-rose-700' : 'text-sage-900'
        }`}
      >
        {value}
      </div>
      <div
        className={`text-xs mt-1 ${
          tone === 'danger' ? 'text-rose-600' : 'text-sage-500'
        }`}
      >
        {label}
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'completed') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 text-xs">
        <CheckCircle2 className="w-3 h-3" /> completed
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-rose-50 text-rose-700 text-xs">
        <XCircle className="w-3 h-3" /> failed
      </span>
    )
  }
  if (status === 'reprocessing') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-gold-50 text-gold-700 text-xs">
        <Loader2 className="w-3 h-3 animate-spin" /> reprocessing
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-sage-50 text-sage-700 text-xs">
      {status}
    </span>
  )
}

function SkipReasonsModal({
  row,
  onClose,
}: {
  row: ImportRunRow
  onClose: () => void
}) {
  const entries = Object.entries(row.skip_reasons ?? {})
  return (
    <div
      className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-warm-white border border-border rounded-lg max-w-md w-full p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-serif text-sage-900 mb-3">
          Skip reasons — {row.filename ?? row.id.slice(0, 8)}
        </h3>
        {entries.length === 0 ? (
          <div className="text-sm text-sage-500">No skip reasons recorded.</div>
        ) : (
          <ul className="text-sm divide-y divide-border">
            {entries.map(([reason, count]) => (
              <li key={reason} className="py-2 flex items-center justify-between">
                <span className="text-sage-900">{reason}</span>
                <span className="text-sage-700 font-mono">{count}</span>
              </li>
            ))}
          </ul>
        )}
        {row.errors && row.errors.length > 0 && (
          <div className="mt-4 pt-4 border-t border-border">
            <div className="text-xs text-sage-600 mb-2">Errors:</div>
            <ul className="text-xs text-rose-700 space-y-1">
              {row.errors.slice(0, 10).map((err, i) => (
                <li key={i} className="font-mono break-words">
                  {err}
                </li>
              ))}
            </ul>
          </div>
        )}
        <button
          onClick={onClose}
          className="mt-4 px-3 py-1.5 text-sm rounded border border-sage-300 hover:bg-sage-50"
        >
          Close
        </button>
      </div>
    </div>
  )
}
