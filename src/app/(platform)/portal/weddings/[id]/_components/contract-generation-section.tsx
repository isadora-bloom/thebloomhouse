'use client'

/**
 * The fifth collapsed section on the wedding page: the contract the venue
 * sends, rather than the ones the couple uploads.
 *
 * The section above this one lists what the couple has put in. This one is
 * the other direction. It builds a contract out of the wedding's own
 * package figures, shows it before anything leaves the building, emails it,
 * and then keeps the trail: sent, opened, signed, with the name they typed
 * and when.
 *
 * Every timestamp on this panel is a real event column. Nothing here reads
 * the row's write time, because "when did they sign" and "when was this
 * record created" are different questions and only one of them was asked.
 *
 * Reads and writes go through /api/portal/contracts/*, which carry the
 * same venue scope the rest of this page's routes do.
 */

import { useCallback, useEffect, useState } from 'react'
import { FileSignature, Loader2, Send, Eye, Ban, AlertCircle } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import {
  asContractStatus,
  canSend,
  canVoid,
  statusLabel,
  statusTrailLine,
  type ContractStatus,
} from '@/lib/services/contracts/status'

export const CONTRACT_SECTION_ICON = FileSignature

export const CONTRACT_SECTION_COPY = {
  heading: 'Your contract',
  subheading:
    "Built from what they booked. Preview it, send it, and see where it got to.",
}

interface GeneratedContractRow {
  id: string
  filename: string
  status: string | null
  template_key: string | null
  file_url: string | null
  sent_at: string | null
  viewed_at: string | null
  signed_at: string | null
  signed_name: string | null
}

/** Pill colours by state. Signed is the only green thing on the panel. */
function pillClass(status: ContractStatus | null): string {
  switch (status) {
    case 'signed':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200'
    case 'sent':
    case 'viewed':
      return 'bg-amber-50 text-amber-700 border-amber-200'
    case 'void':
      return 'bg-gray-100 text-gray-500 border-gray-200'
    default:
      return 'bg-sage-50 text-sage-700 border-sage-200'
  }
}

export function ContractGenerationSection({
  weddingId,
  weddingStatus,
}: {
  weddingId: string
  weddingStatus: string | null
}) {
  const [rows, setRows] = useState<GeneratedContractRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [previewHtml, setPreviewHtml] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const booked = ['contracted', 'booked', 'completed'].includes(weddingStatus ?? '')

  const fetchRows = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/portal/contracts/status?weddingId=${encodeURIComponent(weddingId)}`,
      )
      const data = await res.json()
      if (!res.ok) {
        setError(data?.error ?? 'Could not read the contracts for this wedding.')
        return
      }
      setRows((data.contracts ?? []) as GeneratedContractRow[])
      setError(null)
    } catch {
      setError('Could not read the contracts for this wedding.')
    } finally {
      setLoading(false)
    }
  }, [weddingId])

  useEffect(() => {
    void fetchRows()
  }, [fetchRows])

  async function post(url: string, body: unknown, key: string) {
    setBusy(key)
    setNotice(null)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        setNotice(data?.error ?? 'That did not work. Try again in a moment.')
        return null
      }
      return data
    } catch {
      setNotice('That did not work. Check your connection and try again.')
      return null
    } finally {
      setBusy(null)
    }
  }

  async function handlePreview() {
    const data = await post(
      '/api/portal/contracts/generate',
      { weddingId, preview: true },
      'preview',
    )
    if (data?.html) setPreviewHtml(data.html as string)
  }

  async function handleGenerate() {
    const data = await post('/api/portal/contracts/generate', { weddingId }, 'generate')
    if (data?.contractId) {
      setPreviewHtml(null)
      setNotice('Contract built. Nothing has been sent yet.')
      await fetchRows()
    }
  }

  async function handleSend(contractId: string) {
    const data = await post(
      '/api/portal/contracts/send',
      { contractId },
      `send:${contractId}`,
    )
    if (data?.sent) {
      setNotice(
        data.note ??
          `Sent to ${(data.recipients as string[] | undefined)?.join(', ') || 'the couple'}.`,
      )
      await fetchRows()
    }
  }

  async function handleVoid(contractId: string) {
    const data = await post(
      '/api/portal/contracts/status',
      { contractId, action: 'void' },
      `void:${contractId}`,
    )
    if (data?.voided) {
      setNotice('Withdrawn. The link the couple had no longer opens.')
      await fetchRows()
    }
  }

  if (loading) {
    return <div className="h-24 rounded-lg bg-sage-50 animate-pulse" />
  }

  if (error) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Could not read this wedding's contracts"
        subtitle={error}
        variant="dashed"
      />
    )
  }

  return (
    <div className="space-y-5">
      {!booked && (
        <p className="text-sm text-sage-600 bg-sage-50 border border-sage-200 rounded-lg px-4 py-3">
          A contract is built from what the couple booked, so this wedding needs to be
          booked first. Until then there is no package and no total to put on the page.
        </p>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={handlePreview}
          disabled={!booked || busy !== null}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm font-medium text-sage-800 hover:bg-sage-50 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy === 'preview' ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Eye className="w-4 h-4" />
          )}
          Preview
        </button>
        <button
          type="button"
          onClick={handleGenerate}
          disabled={!booked || busy !== null}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-sage-700 text-white text-sm font-semibold hover:bg-sage-800 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy === 'generate' ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <FileSignature className="w-4 h-4" />
          )}
          Build a contract
        </button>
      </div>

      {notice && (
        <p className="text-sm text-sage-700 bg-sage-50 border border-sage-200 rounded-lg px-4 py-3">
          {notice}
        </p>
      )}

      {previewHtml && (
        <div className="border border-border rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 bg-sage-50 border-b border-border">
            <span className="text-xs font-semibold text-sage-700 uppercase tracking-wide">
              Preview — nothing saved
            </span>
            <button
              type="button"
              onClick={() => setPreviewHtml(null)}
              className="text-xs text-sage-600 hover:text-sage-900"
            >
              Close
            </button>
          </div>
          <div
            className="p-5 max-h-96 overflow-y-auto bg-white"
            // Server-built markup: the venue's plain-text template, escaped
            // on the way out. See renderContractHtml.
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon={FileSignature}
          title="No contract built yet"
          subtitle="Nothing has been generated for this wedding. Preview one first if you want to read it before it exists."
          variant="dashed"
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => {
            const status = asContractStatus(row.status)
            const trail = statusTrailLine({
              status,
              sent_at: row.sent_at,
              viewed_at: row.viewed_at,
              signed_at: row.signed_at,
              signed_name: row.signed_name,
            })
            const sendable = canSend(status)
            const voidable = canVoid(status)
            return (
              <li
                key={row.id}
                className="flex items-start gap-4 border border-border rounded-xl px-4 py-3 bg-white"
              >
                <FileSignature className="w-4 h-4 text-sage-500 shrink-0 mt-1" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sage-900 truncate">
                      {row.filename}
                    </span>
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase border ${pillClass(status)}`}
                    >
                      {statusLabel(status)}
                    </span>
                  </div>
                  <p className="text-xs text-sage-500 mt-1">
                    {trail ?? 'Built, not sent.'}
                  </p>
                  {row.file_url && (
                    <a
                      href={row.file_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block mt-1 text-xs text-sage-600 underline"
                    >
                      Open the file
                    </a>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleSend(row.id)}
                    disabled={!sendable.ok || busy !== null}
                    title={sendable.ok ? 'Email this to the couple' : sendable.reason}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-xs font-medium text-sage-800 hover:bg-sage-50 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {busy === `send:${row.id}` ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Send className="w-3.5 h-3.5" />
                    )}
                    {status === 'draft' ? 'Send' : 'Send again'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleVoid(row.id)}
                    disabled={!voidable.ok || busy !== null}
                    title={voidable.ok ? 'Withdraw this contract' : voidable.reason}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-sage-500 hover:text-red-600 hover:bg-red-50 disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <Ban className="w-3.5 h-3.5" />
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
