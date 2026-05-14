'use client'

import { useState } from 'react'
import { Info, ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Trust-building primitive. Shows operator-facing reasoning for why
 * Bloom is recommending / highlighting / scoring something. Trust comes
 * from showing the work, not hiding it.
 *
 * Two collapse modes:
 *   - 'collapsed' (default): start collapsed, click to expand
 *   - 'open'                : start open (use when the surface is small)
 *
 * Pass `reasoning` as plain text OR `evidence` as a list of bullets.
 * Both render in the same panel.
 */
interface WhyThisCardProps {
  title?: string
  reasoning?: string
  evidence?: string[]
  source?: string
  defaultOpen?: boolean
  variant?: 'inline' | 'card'
  className?: string
}

export function WhyThisCard({
  title = 'Why we surfaced this',
  reasoning,
  evidence,
  source,
  defaultOpen = false,
  variant = 'inline',
  className,
}: WhyThisCardProps) {
  const [open, setOpen] = useState(defaultOpen)
  const hasContent =
    !!reasoning || (Array.isArray(evidence) && evidence.length > 0) || !!source
  if (!hasContent) return null

  return (
    <div
      className={cn(
        variant === 'card'
          ? 'rounded-xl border border-border bg-warm-white p-4'
          : 'border-t border-border/60 bg-warm-white/40 px-3 py-2',
        className
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-sage-500" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-sage-500" />
        )}
        <Info className="h-3.5 w-3.5 flex-shrink-0 text-sage-400" />
        <span className="text-xs font-medium text-sage-700">{title}</span>
      </button>
      {open ? (
        <div className="mt-2 pl-6 space-y-2">
          {reasoning ? (
            <p className="text-xs text-sage-700 leading-relaxed">{reasoning}</p>
          ) : null}
          {Array.isArray(evidence) && evidence.length > 0 ? (
            <ul className="text-xs text-sage-700 space-y-1">
              {evidence.map((e, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-sage-400">·</span>
                  <span>{e}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {source ? (
            <p className="text-[11px] text-sage-500">Source: {source}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
