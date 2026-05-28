'use client'

/**
 * Coordinator-side read-only block surfacing pending contract→budget
 * extractions for a wedding.
 *
 * 2026-05-26. After R1#5 the couple-side analyze pipeline can drop
 * 1-30 draft budget items per contract. Coordinators previously had
 * no visibility into how many drafts a couple was sitting on. This
 * widget shows a small counter + a list of the most recent drafts.
 */

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Loader2, FileText } from 'lucide-react'

interface DraftRow {
  id: string
  item_name: string
  budgeted: number
  payment_due_date: string | null
  source_contract_id: string | null
  created_at: string
}

function formatCurrency(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  return `$${Math.round(n).toLocaleString()}`
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const PREVIEW_LIMIT = 5

export function WeddingExtractionSummary({ weddingId }: { weddingId: string }) {
  const [drafts, setDrafts] = useState<DraftRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!weddingId) return
    let cancelled = false
    const supabase = createClient()
    supabase
      .from('budget_items')
      .select('id, item_name, budgeted, payment_due_date, source_contract_id, created_at')
      .eq('wedding_id', weddingId)
      .eq('auto_extracted', true)
      .is('extraction_confirmed_at', null)
      .order('created_at', { ascending: false })
      .limit(PREVIEW_LIMIT + 1) // +1 to detect "more available"
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) {
          console.warn('[WeddingExtractionSummary] load failed:', error)
          setLoading(false)
          return
        }
        setDrafts((data ?? []) as DraftRow[])
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [weddingId])

  // Empty state — don't render at all. The widget should disappear
  // when there are no drafts so it doesn't add clutter to the page.
  if (!loading && drafts.length === 0) return null

  const hasMore = drafts.length > PREVIEW_LIMIT
  const visible = drafts.slice(0, PREVIEW_LIMIT)
  const totalDollars = drafts.reduce((sum, d) => sum + (Number(d.budgeted) || 0), 0)

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-4 space-y-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-amber-600" />
          <h3 className="text-sm font-semibold text-amber-900">
            {loading ? 'Loading extracted payments…' : (
              <>
                {drafts.length}{hasMore ? '+' : ''} payment{drafts.length === 1 ? '' : 's'} awaiting couple review
              </>
            )}
          </h3>
        </div>
        {!loading && totalDollars > 0 && (
          <span className="text-xs tabular-nums text-amber-700">
            {formatCurrency(totalDollars)}{hasMore ? '+' : ''} total
          </span>
        )}
      </div>
      <p className="text-xs text-amber-700">
        These were auto-extracted from contracts the couple uploaded. They appear as drafts in
        the couple-portal Budget until the couple approves or rejects each one.
      </p>
      {loading ? (
        <div className="text-xs text-amber-700 flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading…
        </div>
      ) : (
        <ul className="space-y-1 pt-1">
          {visible.map((d) => (
            <li key={d.id} className="text-xs flex items-center justify-between gap-3 px-2 py-1 rounded bg-white/60">
              <span className="text-gray-800 truncate flex-1">{d.item_name || '(unnamed item)'}</span>
              {d.payment_due_date && (
                <span className="text-gray-500 shrink-0">due {formatDate(d.payment_due_date)}</span>
              )}
              <span className="tabular-nums font-medium text-gray-700 shrink-0">{formatCurrency(d.budgeted)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
