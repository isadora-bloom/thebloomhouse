'use client'

/**
 * Wave 13 — review-solicitation pipeline dashboard.
 *
 * Lists every review_solicit_request for the active venue with status
 * + channel + drafted preview + (if matched) linked review id.
 * Coordinators can filter by status; clicking a row opens the wedding
 * detail / draft for approval.
 */

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { Loader2, MessageSquare, ExternalLink, CheckCircle, XCircle, Clock } from 'lucide-react'

type Status =
  | 'queued'
  | 'sent'
  | 'review_received'
  | 'declined'
  | 'no_response'

interface SolicitRow {
  id: string
  wedding_id: string
  venue_id: string
  status: Status
  target_channel: string
  review_link_url: string | null
  subject: string | null
  draft_id: string | null
  review_id: string | null
  generated_at: string
  sent_at: string | null
  response_received_at: string | null
  prompt_version: string | null
  cost_cents: number
}

const STATUS_FILTERS: Array<{ key: Status | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'queued', label: 'Drafted' },
  { key: 'sent', label: 'Sent' },
  { key: 'review_received', label: 'Review received' },
  { key: 'declined', label: 'Declined' },
  { key: 'no_response', label: 'No response' },
]

function statusBadgeClasses(s: Status): string {
  switch (s) {
    case 'queued':
      return 'bg-amber-50 text-amber-700 border-amber-200'
    case 'sent':
      return 'bg-blue-50 text-blue-700 border-blue-200'
    case 'review_received':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200'
    case 'declined':
      return 'bg-stone-50 text-stone-600 border-stone-200'
    case 'no_response':
      return 'bg-rose-50 text-rose-700 border-rose-200'
    default:
      return 'bg-stone-50 text-stone-600 border-stone-200'
  }
}

function statusIcon(s: Status) {
  switch (s) {
    case 'review_received':
      return <CheckCircle className="w-3.5 h-3.5" />
    case 'sent':
      return <MessageSquare className="w-3.5 h-3.5" />
    case 'queued':
      return <Clock className="w-3.5 h-3.5" />
    case 'declined':
      return <XCircle className="w-3.5 h-3.5" />
    case 'no_response':
      return <XCircle className="w-3.5 h-3.5" />
    default:
      return null
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  } catch {
    return iso
  }
}

export default function ReviewSolicitationsPage() {
  const venueId = useVenueId()
  const [statusFilter, setStatusFilter] = useState<Status | 'all'>('all')
  const [rows, setRows] = useState<SolicitRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [total, setTotal] = useState(0)

  const fetchRows = useCallback(async () => {
    if (!venueId) return
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ venueId })
      if (statusFilter !== 'all') params.set('status', statusFilter)
      const res = await fetch(`/api/admin/reviews/solicit/list?${params.toString()}`)
      if (!res.ok) {
        setError(`HTTP ${res.status}`)
        setRows([])
        setTotal(0)
        return
      }
      const data = await res.json()
      if (!data?.ok) {
        setError(data?.error ?? 'unknown error')
        setRows([])
        setTotal(0)
        return
      }
      setRows((data.rows ?? []) as SolicitRow[])
      setTotal(Number(data.total ?? 0))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [venueId, statusFilter])

  useEffect(() => {
    fetchRows()
  }, [fetchRows])

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-serif text-stone-900">Review solicitations</h1>
          <p className="text-sm text-stone-600 mt-1">
            Sage drafts a personalised review request after each event. Every
            draft goes to coordinator review before it sends.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setStatusFilter(f.key)}
            className={`px-3 py-1.5 text-sm rounded-full border transition-colors ${
              statusFilter === f.key
                ? 'bg-stone-900 text-white border-stone-900'
                : 'bg-white text-stone-700 border-stone-200 hover:border-stone-400'
            }`}
          >
            {f.label}
          </button>
        ))}
        <span className="ml-auto text-xs text-stone-500">
          {loading ? 'loading…' : `${total} total`}
        </span>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 text-red-800 px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {!loading && rows.length === 0 && !error && (
        <div className="rounded-md border border-dashed border-stone-300 px-6 py-12 text-center text-stone-600">
          <MessageSquare className="w-8 h-8 mx-auto text-stone-400" />
          <p className="mt-2 text-sm">
            No solicitations yet for this filter.
          </p>
          <p className="mt-1 text-xs text-stone-500">
            Sage drafts a solicitation when a wedding enters the post-event
            window (7+ days after the event).
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="bg-white border border-stone-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">Status</th>
                <th className="text-left px-4 py-2.5 font-medium">Channel</th>
                <th className="text-left px-4 py-2.5 font-medium">Subject</th>
                <th className="text-left px-4 py-2.5 font-medium">Drafted</th>
                <th className="text-left px-4 py-2.5 font-medium">Sent</th>
                <th className="text-left px-4 py-2.5 font-medium">Cost</th>
                <th className="text-left px-4 py-2.5 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-stone-50">
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-xs ${statusBadgeClasses(
                        r.status,
                      )}`}
                    >
                      {statusIcon(r.status)}
                      {r.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-stone-700">{r.target_channel}</td>
                  <td className="px-4 py-3 max-w-md">
                    <div className="truncate" title={r.subject ?? ''}>
                      {r.subject ?? <em className="text-stone-400">no subject</em>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-stone-600">
                    {formatDate(r.generated_at)}
                  </td>
                  <td className="px-4 py-3 text-stone-600">{formatDate(r.sent_at)}</td>
                  <td className="px-4 py-3 text-stone-600 tabular-nums">
                    ${(Number(r.cost_cents) / 100).toFixed(3)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/intel/clients/${r.wedding_id}`}
                      className="inline-flex items-center gap-1 text-xs text-stone-600 hover:text-stone-900"
                    >
                      open <ExternalLink className="w-3 h-3" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-6 text-sm text-stone-500">
          <Loader2 className="w-4 h-4 animate-spin mr-2" /> loading…
        </div>
      )}
    </div>
  )
}
