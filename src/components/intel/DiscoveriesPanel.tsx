'use client'

/**
 * DiscoveriesPanel — Wave 7A embeddable preview panel.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 7A pattern discovery — THE differentiator
 *     vs every other CRM)
 *   - bloom-wave4-5-6-master-plan.md (Wave 7A spec)
 *   - bloom-data-integrity-sweep.md (aggregate ≠ disclose)
 *
 * Why a separate panel from the dashboard
 * ---------------------------------------
 * The /intel landing surface needs a top-3-pending widget — coordinators
 * see "what unknown-unknowns surfaced this week" without leaving their
 * existing flow. Full triage happens on /intel/discoveries.
 */

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import {
  Sparkles,
  ArrowUpRight,
  Loader2,
  AlertCircle,
  Lightbulb,
} from 'lucide-react'

interface DiscoveryRow {
  id: string
  hypothesis_title: string
  hypothesis_text: string
  hypothesis_category: string
  confidence_0_100: number
  validation_status: string
  created_at: string
}

interface PanelResponse {
  ok: boolean
  count?: number
  discoveries?: DiscoveryRow[]
  error?: string
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'unknown'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 'unknown'
  const diffMs = Date.now() - t
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

function confidenceColor(conf: number): string {
  if (conf >= 80) return 'text-emerald-700 bg-emerald-50 border-emerald-200'
  if (conf >= 60) return 'text-amber-700 bg-amber-50 border-amber-200'
  if (conf >= 40) return 'text-sage-700 bg-sage-50 border-sage-200'
  return 'text-slate-600 bg-slate-50 border-slate-200'
}

function humaniseCategory(category: string): string {
  return category
    .split('_')
    .map((s) => (s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)))
    .join(' ')
}

export function DiscoveriesPanel() {
  const [data, setData] = useState<PanelResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        status: 'pending',
        limit: '3',
      })
      const res = await fetch(
        `/api/admin/intel/discoveries/list?${params.toString()}`,
        { cache: 'no-store' },
      )
      const body = (await res.json()) as PanelResponse
      if (!res.ok || !body.ok) {
        setError(body.error || `HTTP ${res.status}`)
        return
      }
      setData(body)
      setError(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error'
      setError(msg)
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    fetchData().finally(() => setLoading(false))
  }, [fetchData])

  if (loading) {
    return (
      <div className="bg-surface border border-border rounded-xl p-4 shadow-sm">
        <div className="flex items-center gap-2 text-sage-500 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading discoveries...
        </div>
      </div>
    )
  }

  const discoveries = data?.discoveries ?? []

  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm">
      <div className="px-5 py-3 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Lightbulb className="w-4 h-4 text-sage-500" />
          <h3 className="font-heading text-sm font-semibold text-sage-900">
            Discoveries
          </h3>
          <span className="text-[10px] text-sage-400 font-mono">
            unknown-unknowns
          </span>
        </div>
        <Link
          href="/intel/discoveries"
          className="inline-flex items-center gap-0.5 text-[11px] text-sage-600 hover:text-sage-800"
        >
          all
          <ArrowUpRight className="w-3 h-3" />
        </Link>
      </div>
      {error && (
        <div className="px-5 py-3 text-xs text-rose-700 flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5" />
          {error}
        </div>
      )}
      {discoveries.length === 0 ? (
        <div className="px-5 py-4 text-xs text-sage-500">
          <p>No pending discoveries — run the engine to surface patterns the team doesn&rsquo;t know to look for.</p>
          <Link
            href="/intel/discoveries"
            className="inline-flex items-center gap-1 mt-2 text-sage-700 hover:text-sage-900"
          >
            <Sparkles className="w-3 h-3" />
            Open discoveries
          </Link>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {discoveries.map((d) => (
            <li key={d.id} className="px-5 py-3">
              <Link
                href="/intel/discoveries"
                className="block hover:bg-sage-50/40 -mx-2 px-2 py-1 rounded"
              >
                <div className="flex items-start gap-2 flex-wrap">
                  <span className="text-sm font-medium text-sage-900 flex-1 min-w-[200px] leading-snug">
                    {d.hypothesis_title}
                  </span>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded border ${confidenceColor(d.confidence_0_100)}`}
                  >
                    {d.confidence_0_100}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] text-sage-500 italic">
                    {humaniseCategory(d.hypothesis_category)}
                  </span>
                  <span className="text-[10px] text-sage-400">
                    {relativeTime(d.created_at)}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default DiscoveriesPanel
