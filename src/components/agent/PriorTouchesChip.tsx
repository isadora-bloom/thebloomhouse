'use client'

import { useEffect, useState } from 'react'
import { Flame, Sparkles, ChevronDown, ChevronUp, Mail, AtSign, Globe, Calendar, Star, Link as LinkIcon } from 'lucide-react'
import type { PriorTouchSummary, PriorTouch } from '@/lib/services/prior-touches'

interface PriorTouchesChipProps {
  personId: string | null | undefined
}

/**
 * Surfaces the Phase 8 multi-touch history for an inquiry row.
 *
 * Renders nothing if the person has no prior touchpoints (cold). Warm
 * couples (1-2 touches) get a small amber chip. Hot couples (3+) get a
 * sage chip. Clicking either expands an inline list of each touch.
 *
 * The component silent-fails on 401/403/404/network errors and hides
 * itself rather than showing inbox-row error state.
 */
export function PriorTouchesChip({ personId }: PriorTouchesChipProps) {
  const [summary, setSummary] = useState<PriorTouchSummary | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!personId) {
      setSummary(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/agent/inbox/prior-touches/${personId}`)
        if (!res.ok) {
          // Silent fail on 401/403/404/5xx: hide the chip entirely.
          if (!cancelled) setSummary(null)
          return
        }
        const data = (await res.json()) as PriorTouchSummary
        if (!cancelled) setSummary(data)
      } catch {
        // Network error: hide.
        if (!cancelled) setSummary(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [personId])

  if (!personId) return null
  if (!summary) return null
  if (summary.warmth === 'cold' || summary.touches.length === 0) return null

  const total = summary.touches.length
  const isHot = summary.warmth === 'hot'
  const chipClass = isHot
    ? 'bg-sage-50 text-sage-700 border-sage-200 hover:bg-sage-100'
    : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
  const Icon = isHot ? Flame : Sparkles
  const label = `${total} prior touchpoint${total === 1 ? '' : 's'}`
  const narration = buildNarration(summary.touches)

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setExpanded((v) => !v)
        }}
        title={narration}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap transition-colors ${chipClass}`}
      >
        <Icon className="w-3 h-3" />
        <span>{label}</span>
        {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      </button>
      {expanded && (
        <div
          className={`mt-2 rounded-md border px-2 py-2 text-[11px] space-y-1 ${
            isHot ? 'bg-sage-50/70 border-sage-200' : 'bg-amber-50/70 border-amber-200'
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          {summary.touches.map((t, i) => (
            <TouchRow key={`${t.date}-${i}`} touch={t} />
          ))}
        </div>
      )}
    </div>
  )
}

function TouchRow({ touch }: { touch: PriorTouch }) {
  const SourceIcon = sourceIcon(touch.source, touch.kind)
  const dateStr = touch.date
    ? new Date(touch.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : ''
  return (
    <div className="flex items-start gap-2 text-sage-800">
      <SourceIcon className="w-3 h-3 mt-0.5 shrink-0 text-sage-600" />
      <span className="text-sage-500 shrink-0 tabular-nums w-14">{dateStr}</span>
      <span className="truncate">{touch.summary}</span>
    </div>
  )
}

function sourceIcon(source: string, kind: PriorTouch['kind']) {
  const s = source.toLowerCase()
  if (s.includes('instagram') || s.includes('facebook') || s.includes('tiktok')) return AtSign
  if (s.includes('website') || s.includes('web')) return Globe
  if (s.includes('knot') || s.includes('wedding_wire') || s.includes('weddingwire') || s.includes('zola')) return LinkIcon
  if (s.includes('review') || s.includes('google') || s.includes('yelp')) return Star
  if (kind === 'tour') return Calendar
  if (kind === 'interaction' || s === 'email') return Mail
  return Globe
}

function buildNarration(touches: PriorTouch[]): string {
  if (touches.length === 0) return ''
  const parts = touches.slice(0, 6).map((t) => {
    const d = t.date ? new Date(t.date) : null
    const when = d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''
    return `${t.summary}${when ? ` (${when})` : ''}`
  })
  return parts.join('; ')
}
