'use client'

/**
 * Wave 15 — per-wedding evidence-overrides admin page.
 *
 * Anchor docs:
 *   - bloom-constitution.md (operator override > inferred state; audit
 *     history preserved via active=false)
 *
 * Lists every active + retired override on a wedding. Operator can
 * restore (un-dismiss) a row, flipping active back to true so the next
 * reconstruction re-includes the evidence.
 *
 * The page is intentionally read-mostly. Dismissing happens from the
 * ReconstructedIdentityPanel (in-context). Restoring happens here.
 */

import { useEffect, useState, useCallback, use } from 'react'
import Link from 'next/link'
import {
  ShieldOff,
  RotateCcw,
  AlertCircle,
  ArrowLeft,
  Loader2,
} from 'lucide-react'

interface OverrideRow {
  id: string
  evidence_kind: string
  evidence_ref: { table?: string; id?: string; field_path?: string }
  override_action: 'dismiss' | 'unlink' | 'correct_value'
  correction_value: unknown
  reason: string | null
  created_at: string
  updated_at: string
  created_by: string | null
  active: boolean
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'unknown'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 'unknown'
  const diff = Date.now() - t
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return `${Math.floor(d / 30)}mo ago`
}

export default function EvidenceOverridesPage({
  params,
}: {
  params: Promise<{ weddingId: string }>
}) {
  const { weddingId } = use(params)
  const [active, setActive] = useState<OverrideRow[]>([])
  const [retired, setRetired] = useState<OverrideRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [restoring, setRestoring] = useState<Set<string>>(new Set())

  const fetchRows = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [activeRes, retiredRes] = await Promise.all([
        fetch(
          `/api/admin/identity/evidence/list?weddingId=${encodeURIComponent(weddingId)}&active=true`,
          { cache: 'no-store' },
        ),
        fetch(
          `/api/admin/identity/evidence/list?weddingId=${encodeURIComponent(weddingId)}&active=false`,
          { cache: 'no-store' },
        ),
      ])
      const activeBody = (await activeRes.json()) as {
        ok: boolean
        overrides?: OverrideRow[]
        error?: string
      }
      const retiredBody = (await retiredRes.json()) as {
        ok: boolean
        overrides?: OverrideRow[]
        error?: string
      }
      if (!activeRes.ok || !activeBody.ok) {
        setError(activeBody.error || `HTTP ${activeRes.status}`)
        return
      }
      setActive(activeBody.overrides ?? [])
      setRetired(retiredBody.overrides ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error')
    } finally {
      setLoading(false)
    }
  }, [weddingId])

  useEffect(() => {
    void fetchRows()
  }, [fetchRows])

  async function restore(row: OverrideRow) {
    setRestoring((s) => {
      const n = new Set(s)
      n.add(row.id)
      return n
    })
    try {
      const res = await fetch('/api/admin/identity/evidence/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overrideId: row.id }),
      })
      const body = (await res.json()) as { ok: boolean; error?: string }
      if (!res.ok || !body.ok) {
        setError(body.error || `HTTP ${res.status}`)
        return
      }
      await fetchRows()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error')
    } finally {
      setRestoring((s) => {
        const n = new Set(s)
        n.delete(row.id)
        return n
      })
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="mb-6 flex items-center gap-3">
        <Link
          href={`/intel/clients/${weddingId}`}
          className="inline-flex items-center gap-1.5 text-sm text-sage-600 hover:text-sage-900"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to lead
        </Link>
      </div>

      <div className="mb-6">
        <h1 className="font-heading text-2xl font-semibold text-sage-900 flex items-center gap-2">
          <ShieldOff className="w-6 h-6 text-sage-500" />
          Evidence overrides
        </h1>
        <p className="text-sm text-sage-600 mt-1">
          Wedding {weddingId}. Active overrides exclude evidence from
          reconstruction + timeline. Retired overrides are audit history
          (Constitution: never hard-delete) and can be restored to re-flip
          to active.
        </p>
      </div>

      {error && (
        <div className="mb-4 px-4 py-2 bg-rose-50 border border-rose-200 rounded-md text-sm text-rose-700 flex items-center gap-2">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-sm text-sage-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading...
        </div>
      )}

      {!loading && (
        <>
          <section className="mb-8">
            <h2 className="font-heading text-lg font-semibold text-sage-900 mb-3">
              Active ({active.length})
            </h2>
            {active.length === 0 ? (
              <div className="text-sm text-sage-400 italic">
                No active overrides on this wedding.
              </div>
            ) : (
              <div className="space-y-2">
                {active.map((row) => (
                  <OverrideCard
                    key={row.id}
                    row={row}
                    onRestore={() => restore(row)}
                    busy={restoring.has(row.id)}
                  />
                ))}
              </div>
            )}
          </section>

          <section>
            <h2 className="font-heading text-lg font-semibold text-sage-900 mb-3">
              Retired audit history ({retired.length})
            </h2>
            {retired.length === 0 ? (
              <div className="text-sm text-sage-400 italic">
                No retired overrides.
              </div>
            ) : (
              <div className="space-y-2">
                {retired.map((row) => (
                  <OverrideCard
                    key={row.id}
                    row={row}
                    onRestore={() => restore(row)}
                    busy={restoring.has(row.id)}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function OverrideCard({
  row,
  onRestore,
  busy,
}: {
  row: OverrideRow
  onRestore: () => void
  busy: boolean
}) {
  return (
    <div
      className={`flex items-start gap-3 px-4 py-3 rounded-md border ${
        row.active
          ? 'border-sage-200 bg-sage-50/40'
          : 'border-sage-100 bg-sage-50/10 opacity-70'
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="text-sm text-sage-900 flex items-center gap-2 flex-wrap">
          <span className="font-medium capitalize">
            {row.override_action.replace(/_/g, ' ')}
          </span>
          <span className="text-xs text-sage-500 uppercase">
            {row.evidence_kind}
          </span>
          {row.evidence_ref?.table && (
            <span className="font-mono text-[10px] text-sage-500">
              {row.evidence_ref.table}:{row.evidence_ref.id?.slice(0, 8)}
            </span>
          )}
          <span className="ml-auto text-[10px] text-sage-500">
            {relativeTime(row.created_at)}
          </span>
        </div>
        {row.reason && (
          <div className="mt-1 text-xs text-sage-600 italic">
            &ldquo;{row.reason}&rdquo;
          </div>
        )}
        {!row.active && (
          <div className="mt-1 text-[10px] text-sage-400">
            restored {relativeTime(row.updated_at)}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onRestore}
        disabled={busy}
        className="flex-shrink-0 inline-flex items-center gap-1.5 px-2 py-1 text-[11px] border border-sage-300 text-sage-700 rounded hover:bg-sage-50 disabled:opacity-50"
        title={
          row.active
            ? 'Retire this override (audit history preserved)'
            : 'Re-activate this override'
        }
      >
        {busy ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <RotateCcw className="w-3 h-3" />
        )}
        {row.active ? 'Retire' : 'Re-activate'}
      </button>
    </div>
  )
}
