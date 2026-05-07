'use client'

/**
 * Super-admin → Consumer requests (Tier-C #116/#117/#118).
 *
 * CCPA / GDPR review queue. Lists pending and recent requests across
 * the org; admin clicks Execute or Deny. Execute runs the matching
 * helper (eraseCouple / eraseUser / exportCouple / exportUser) and
 * marks the row completed; Deny requires a justification per CCPA
 * 1798.130(a)(2).
 */

import { useState, useEffect, useCallback } from 'react'
import { Shield, Loader2, CheckCircle2, XCircle, Clock, AlertTriangle, Download } from 'lucide-react'

interface RequestRow {
  id: string
  venue_id: string
  requester_user_id: string | null
  requester_email: string
  requester_role: string
  request_type: 'erasure' | 'portability' | 'access'
  scope: 'self' | 'wedding' | 'org'
  status: 'pending' | 'processing' | 'completed' | 'denied' | 'expired'
  resolution_notes: string | null
  processed_by: string | null
  processed_at: string | null
  created_at: string
  expires_at: string
}

const STATUS_FILTERS: { label: string; value: string }[] = [
  { label: 'Pending', value: 'pending,processing' },
  { label: 'Completed', value: 'completed' },
  { label: 'Denied', value: 'denied' },
  { label: 'Expired', value: 'expired' },
  { label: 'All', value: '' },
]

export default function ConsumerRequestsPage() {
  const [rows, setRows] = useState<RequestRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<string>('pending,processing')
  const [busyId, setBusyId] = useState<string | null>(null)

  const fetchRows = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (filter) params.set('status', filter)
      const res = await fetch(`/api/admin/consumer-requests?${params.toString()}`)
      if (!res.ok) throw new Error(`Load failed (${res.status})`)
      const json = (await res.json()) as { data: RequestRow[] }
      setRows(json.data ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed')
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    fetchRows()
  }, [fetchRows])

  async function process(id: string, action: 'execute' | 'deny') {
    let notes: string | null = null
    if (action === 'deny') {
      notes = window.prompt('Reason for denial? (required, will be stored on the request)')
      if (!notes) return
    } else {
      const ok = window.confirm(
        'Execute this request? Erasure is irreversible. Portability returns a JSON payload you must email to the requester.',
      )
      if (!ok) return
    }
    setBusyId(id)
    try {
      const res = await fetch(`/api/admin/consumer-requests/${id}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, notes: notes ?? undefined }),
      })
      const body = await res.json()
      if (!res.ok) {
        alert(`Failed: ${body.error ?? res.status}`)
      } else if (body.payload) {
        // Portability result — surface as a download.
        const blob = new Blob([JSON.stringify(body.payload, null, 2)], {
          type: 'application/json',
        })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `consumer-request-${id}.json`
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
      }
      await fetchRows()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error')
    } finally {
      setBusyId(null)
    }
  }

  function statusPill(status: RequestRow['status']) {
    const map: Record<RequestRow['status'], { bg: string; text: string; icon: typeof Clock }> = {
      pending: { bg: 'bg-amber-50', text: 'text-amber-800', icon: Clock },
      processing: { bg: 'bg-sage-50', text: 'text-sage-800', icon: Loader2 },
      completed: { bg: 'bg-emerald-50', text: 'text-emerald-800', icon: CheckCircle2 },
      denied: { bg: 'bg-red-50', text: 'text-red-800', icon: XCircle },
      expired: { bg: 'bg-red-100', text: 'text-red-900', icon: AlertTriangle },
    }
    const cfg = map[status]
    const Icon = cfg.icon
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${cfg.bg} ${cfg.text}`}>
        <Icon className="w-3 h-3" />
        {status}
      </span>
    )
  }

  function isOverdue(row: RequestRow): boolean {
    if (row.status !== 'pending' && row.status !== 'processing') return false
    return new Date(row.expires_at).getTime() < Date.now()
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1 flex items-center gap-2">
          <Shield className="w-6 h-6 text-sage-700" />
          Consumer requests
        </h1>
        <p className="text-sage-600 max-w-2xl">
          CCPA &amp; GDPR consumer-rights review queue. Right-to-erasure, data
          portability, and access requests live here with their status. The
          45-day SLA tripwire flips unprocessed rows to <span className="font-semibold">expired</span>;
          treat those as a compliance breach.
        </p>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border ${
              filter === f.value
                ? 'bg-sage-700 text-white border-sage-700'
                : 'bg-surface text-sage-700 border-border hover:bg-sage-50'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-sage-600 text-sm flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="bg-sage-50 border border-sage-100 rounded-xl p-8 text-center text-sage-600">
          No requests in this view.
        </div>
      ) : (
        <div className="bg-white border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-sage-50 text-xs uppercase tracking-wide text-sage-700">
              <tr>
                <th className="text-left px-4 py-3 font-semibold">Requester</th>
                <th className="text-left px-4 py-3 font-semibold">Type / scope</th>
                <th className="text-left px-4 py-3 font-semibold">Status</th>
                <th className="text-left px-4 py-3 font-semibold">Created</th>
                <th className="text-left px-4 py-3 font-semibold">Expires</th>
                <th className="text-left px-4 py-3 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const overdue = isOverdue(row)
                const canAct = row.status === 'pending' || row.status === 'processing'
                return (
                  <tr key={row.id} className="border-t border-border hover:bg-sage-50/50">
                    <td className="px-4 py-3 align-top">
                      <div className="font-medium text-sage-900">{row.requester_email}</div>
                      <div className="text-xs text-sage-500">{row.requester_role}</div>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <div className="text-sage-900">{row.request_type}</div>
                      <div className="text-xs text-sage-500">{row.scope}</div>
                    </td>
                    <td className="px-4 py-3 align-top">
                      {statusPill(row.status)}
                      {overdue && (
                        <div className="mt-1 text-xs text-red-700 font-semibold">
                          OVERDUE
                        </div>
                      )}
                      {row.resolution_notes && (
                        <div className="mt-1 text-xs text-sage-600 max-w-xs">
                          {row.resolution_notes}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top text-xs text-sage-700">
                      {new Date(row.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 align-top text-xs text-sage-700">
                      {new Date(row.expires_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 align-top">
                      {canAct ? (
                        <div className="flex flex-col gap-1">
                          <button
                            onClick={() => process(row.id, 'execute')}
                            disabled={busyId === row.id}
                            className="inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium bg-sage-700 text-white hover:bg-sage-800 disabled:opacity-50"
                          >
                            {busyId === row.id ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : row.request_type === 'portability' ? (
                              <Download className="w-3 h-3" />
                            ) : (
                              <CheckCircle2 className="w-3 h-3" />
                            )}
                            Execute
                          </button>
                          <button
                            onClick={() => process(row.id, 'deny')}
                            disabled={busyId === row.id}
                            className="inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium bg-white text-red-700 border border-red-200 hover:bg-red-50 disabled:opacity-50"
                          >
                            <XCircle className="w-3 h-3" />
                            Deny
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-sage-500">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
