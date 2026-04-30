'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Send, ArrowRight } from 'lucide-react'

interface Metrics {
  drafted: number
  sent: number
  discarded: number
  converted: number
  conversionRate: number
}

/**
 * Phase D Tier 2 Stage 3 — re-engagement ROI on /intel/sources.
 *
 * Shows the simple funnel: drafted → sent → converted (within
 * 60d). Self-hides when no rows exist (venue hasn't tried any
 * re-engagement yet). Links to the queue.
 */
export function ReEngagementROIPanel() {
  const [m, setM] = useState<Metrics | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetch('/api/intel/reengagement/metrics', { credentials: 'include' })
      .then((r) => r.ok ? r.json() : null)
      .then((j) => { if (!cancelled) setM(j) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  if (loading) return null
  if (!m || m.drafted === 0) return null

  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Send className="w-4 h-4 text-sage-600" />
          <h3 className="font-heading text-base font-semibold text-sage-900">
            Re-engagement performance
          </h3>
        </div>
        <Link
          href="/intel/reengagement"
          className="text-xs text-sage-500 hover:text-sage-700 flex items-center gap-1"
        >
          Open queue <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
      <div className="grid grid-cols-4 divide-x divide-border">
        <Stat label="Drafted" value={m.drafted} />
        <Stat label="Sent" value={m.sent} sub={m.discarded > 0 ? `${m.discarded} discarded` : undefined} />
        <Stat label="Converted (60d)" value={m.converted} />
        <Stat
          label="Conversion rate"
          value={m.sent > 0 ? `${(m.conversionRate * 100).toFixed(0)}%` : '—'}
          sub={m.sent === 0 ? 'no sent yet' : undefined}
          highlight={m.conversionRate > 0.1}
        />
      </div>
    </div>
  )
}

function Stat({ label, value, sub, highlight }: { label: string; value: number | string; sub?: string; highlight?: boolean }) {
  return (
    <div className="px-5 py-4">
      <p className="text-xs uppercase tracking-wider text-sage-500">{label}</p>
      <p className={`text-2xl font-semibold mt-1 ${highlight ? 'text-emerald-600' : 'text-sage-900'}`}>{value}</p>
      {sub && <p className="text-[11px] text-sage-500 mt-0.5">{sub}</p>}
    </div>
  )
}
