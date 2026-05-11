'use client'

/**
 * Wave 25 — Wedding MBA presentation export trigger.
 *
 * Pops a small menu on the per-source page. Operator picks a format,
 * the endpoint generates the export + persists a frozen snapshot, the
 * UI returns the share-token + download URL.
 */

import { useState } from 'react'
import { Download, ExternalLink, Copy, Check } from 'lucide-react'
import type { ChannelSlug } from '@/lib/services/channel-intel-hub/types'

interface Props {
  venueId: string
  channelSlug: ChannelSlug
  windowDays: number
}

interface ExportResponse {
  ok: boolean
  share_token?: string
  download_url?: string
  content_type?: string
  error?: string
}

export function SourcePresentationExport({ venueId, channelSlug, windowDays }: Props) {
  const [busy, setBusy] = useState<null | 'pdf' | 'csv' | 'json'>(null)
  const [result, setResult] = useState<ExportResponse | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function doExport(format: 'pdf' | 'csv' | 'json') {
    setBusy(format)
    setError(null)
    setResult(null)
    setCopied(false)
    try {
      const res = await fetch(
        `/api/admin/intel/channels/${channelSlug}/export?venueId=${venueId}&format=${format}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ windowDays }),
        },
      )
      const json = (await res.json()) as ExportResponse
      if (!res.ok || !json.ok) {
        setError(json.error ?? `HTTP ${res.status}`)
        return
      }
      setResult(json)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  function copyShareLink() {
    if (!result?.download_url) return
    const fullUrl =
      typeof window !== 'undefined' ? window.location.origin + result.download_url : result.download_url
    navigator.clipboard.writeText(fullUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
  }

  return (
    <div className="bg-white border border-stone-200 rounded-xl p-5 shadow-sm">
      <h3 className="text-lg font-serif text-stone-900 mb-1">Wedding MBA presentation export</h3>
      <p className="text-sm text-stone-500 mb-4">
        Generate a reproducible link to the story arc + CAC reveal + calibration band.
        The snapshot is frozen at export time — the link shows the same numbers months
        later, even if the underlying data shifts.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => doExport('pdf')}
          disabled={busy !== null}
          className="inline-flex items-center gap-1 px-3 py-2 bg-sage-600 text-white rounded-md text-sm hover:bg-sage-700 disabled:opacity-50"
        >
          <Download className="w-4 h-4" />
          {busy === 'pdf' ? 'Generating…' : 'PDF / print'}
        </button>
        <button
          onClick={() => doExport('csv')}
          disabled={busy !== null}
          className="inline-flex items-center gap-1 px-3 py-2 bg-stone-700 text-white rounded-md text-sm hover:bg-stone-800 disabled:opacity-50"
        >
          <Download className="w-4 h-4" />
          {busy === 'csv' ? 'Generating…' : 'CSV'}
        </button>
        <button
          onClick={() => doExport('json')}
          disabled={busy !== null}
          className="inline-flex items-center gap-1 px-3 py-2 bg-stone-500 text-white rounded-md text-sm hover:bg-stone-600 disabled:opacity-50"
        >
          <Download className="w-4 h-4" />
          {busy === 'json' ? 'Generating…' : 'JSON'}
        </button>
      </div>

      {error && (
        <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">
          {error}
        </div>
      )}

      {result?.share_token && result.download_url && (
        <div className="mt-4 p-3 bg-emerald-50 border border-emerald-200 rounded">
          <div className="text-sm text-emerald-900 mb-2">
            Export ready. Share-token <code className="font-mono">{result.share_token}</code>.
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              href={result.download_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 px-3 py-1.5 bg-white border border-emerald-300 text-emerald-800 rounded text-sm hover:bg-emerald-100"
            >
              <ExternalLink className="w-4 h-4" />
              Open
            </a>
            <button
              onClick={copyShareLink}
              className="inline-flex items-center gap-1 px-3 py-1.5 bg-white border border-emerald-300 text-emerald-800 rounded text-sm hover:bg-emerald-100"
            >
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copied ? 'Copied' : 'Copy share link'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
