'use client'

/**
 * Couple Portal → Privacy & data (Tier-C #116/#117).
 *
 * Two affordances:
 *   - Download my data (CCPA right-to-portability) — synchronous JSON
 *     download. POSTs to /api/couple/me/export, browser saves the
 *     response body as a file.
 *   - Request account deletion (CCPA right-to-erasure) — queued for
 *     admin review. POSTs to /api/couple/me/erase. Confirmed via a
 *     two-step modal so we don't lose work to a misclick.
 *
 * The actual erasure does NOT execute here. The venue admin reviews
 * the request and runs it within the 45-day CCPA SLA. This page only
 * surfaces the request id + status so the couple can track.
 */

import { useState, useEffect, useCallback } from 'react'
import { Download, Trash2, Loader2, ShieldCheck, Clock, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

interface MyRequest {
  id: string
  request_type: 'erasure' | 'portability' | 'access'
  status: 'pending' | 'processing' | 'completed' | 'denied' | 'expired'
  created_at: string
  expires_at: string
  resolution_notes: string | null
}

export default function CouplePrivacyPage() {
  const [requests, setRequests] = useState<MyRequest[]>([])
  const [loadingRequests, setLoadingRequests] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const fetchRequests = useCallback(async () => {
    setLoadingRequests(true)
    try {
      const supabase = createClient()
      const { data: user } = await supabase.auth.getUser()
      if (!user.user) {
        setRequests([])
        return
      }
      const { data } = await supabase
        .from('consumer_requests')
        .select('id, request_type, status, created_at, expires_at, resolution_notes')
        .eq('requester_user_id', user.user.id)
        .order('created_at', { ascending: false })
      setRequests((data as MyRequest[] | null) ?? [])
    } finally {
      setLoadingRequests(false)
    }
  }, [])

  useEffect(() => {
    fetchRequests()
  }, [fetchRequests])

  async function handleExport() {
    setExporting(true)
    setMessage(null)
    try {
      const res = await fetch('/api/couple/me/export', { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setMessage({ kind: 'err', text: body.error ?? `Export failed (${res.status})` })
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `bloom-data-export-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      setMessage({ kind: 'ok', text: 'Your data export was downloaded.' })
      await fetchRequests()
    } catch (err) {
      setMessage({ kind: 'err', text: err instanceof Error ? err.message : 'Network error' })
    } finally {
      setExporting(false)
    }
  }

  async function handleErase() {
    setRequesting(true)
    setMessage(null)
    setConfirmDelete(false)
    try {
      const res = await fetch('/api/couple/me/erase', { method: 'POST' })
      const body = await res.json()
      if (!res.ok) {
        setMessage({ kind: 'err', text: body.error ?? `Request failed (${res.status})` })
        return
      }
      setMessage({
        kind: 'ok',
        text: body.alreadyOpen
          ? 'You already have an open erasure request.'
          : body.message ?? 'Erasure request submitted.',
      })
      await fetchRequests()
    } catch (err) {
      setMessage({ kind: 'err', text: err instanceof Error ? err.message : 'Network error' })
    } finally {
      setRequesting(false)
    }
  }

  function statusPill(status: MyRequest['status']) {
    const cfg = {
      pending: { bg: 'bg-amber-50', text: 'text-amber-800', icon: Clock, label: 'Pending review' },
      processing: { bg: 'bg-sage-50', text: 'text-sage-800', icon: Loader2, label: 'In progress' },
      completed: { bg: 'bg-emerald-50', text: 'text-emerald-800', icon: CheckCircle2, label: 'Completed' },
      denied: { bg: 'bg-red-50', text: 'text-red-800', icon: XCircle, label: 'Denied' },
      expired: { bg: 'bg-red-100', text: 'text-red-900', icon: AlertTriangle, label: 'Expired' },
    }[status]
    const Icon = cfg.icon
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${cfg.bg} ${cfg.text}`}>
        <Icon className="w-3 h-3" />
        {cfg.label}
      </span>
    )
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1 flex items-center gap-2">
          <ShieldCheck className="w-6 h-6 text-sage-700" />
          Privacy &amp; data
        </h1>
        <p className="text-sage-600">
          Your wedding data lives in Bloom. You can download a copy any time, or
          ask us to delete it. Both rights are guaranteed under CCPA and GDPR;
          we honour them within 45 days.
        </p>
      </div>

      {message && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            message.kind === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-red-50 border-red-200 text-red-900'
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {/* Export card */}
        <div className="bg-white border border-border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-2">
            <Download className="w-5 h-5 text-sage-700" />
            <h2 className="font-heading text-lg font-semibold text-sage-900">
              Download my data
            </h2>
          </div>
          <p className="text-sm text-sage-600 mb-4">
            A JSON file with everything we hold about your wedding: profile,
            checklist, planning notes, timeline, budget, messages, sage chat,
            and the email thread with your venue. Limit one per 30 days.
          </p>
          <button
            onClick={handleExport}
            disabled={exporting}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sage-700 text-white hover:bg-sage-800 text-sm font-medium disabled:opacity-50"
          >
            {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {exporting ? 'Building…' : 'Download'}
          </button>
        </div>

        {/* Erase card */}
        <div className="bg-white border border-border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-2">
            <Trash2 className="w-5 h-5 text-red-700" />
            <h2 className="font-heading text-lg font-semibold text-sage-900">
              Request deletion
            </h2>
          </div>
          <p className="text-sm text-sage-600 mb-4">
            Sends a request to your venue admin to remove your data. They review
            and complete it within 45 days. Your wedding record stays as the
            venue&apos;s business record but personal fields (notes, messages,
            chat) are redacted or deleted.
          </p>
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <button
                onClick={handleErase}
                disabled={requesting}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 text-sm font-medium disabled:opacity-50"
              >
                {requesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                Yes, request deletion
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-4 py-2 rounded-lg border border-border text-sage-700 hover:bg-sage-50 text-sm font-medium"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-red-200 text-red-700 hover:bg-red-50 text-sm font-medium"
            >
              <Trash2 className="w-4 h-4" />
              Request account deletion
            </button>
          )}
        </div>
      </div>

      {/* Request history */}
      <div>
        <h2 className="font-heading text-xl font-semibold text-sage-900 mb-3">
          Your requests
        </h2>
        {loadingRequests ? (
          <div className="text-sage-600 text-sm flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading…
          </div>
        ) : requests.length === 0 ? (
          <div className="text-sm text-sage-500">No requests yet.</div>
        ) : (
          <ul className="divide-y divide-border bg-white border border-border rounded-xl">
            {requests.map((r) => (
              <li key={r.id} className="px-4 py-3 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-sage-900 capitalize">
                    {r.request_type === 'portability' ? 'Data download' : r.request_type}
                  </div>
                  <div className="text-xs text-sage-500">
                    Submitted {new Date(r.created_at).toLocaleDateString()}
                    {r.resolution_notes && r.status !== 'completed' ? ` · ${r.resolution_notes}` : ''}
                  </div>
                </div>
                {statusPill(r.status)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
