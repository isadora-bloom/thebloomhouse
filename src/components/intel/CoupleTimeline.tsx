'use client'

/**
 * CoupleTimeline — Wave 12 unified chronological event stream.
 *
 * Renders TimelineEvent rows grouped by day, with a sticky filter chip
 * row for kind filtering. Inflection events (lifecycle transition,
 * contract upload, first review) carry a highlighted card.
 *
 * Stage chip is shown ONCE per consecutive run of same-stage events
 * (left rail). This keeps the visual rhythm honest — three emails
 * inside the same "tour scheduled" stage shouldn't repeat the chip.
 *
 * Filter bar:
 *   - by kind chips (multi-select)
 *   - "all" toggle to clear filters
 *
 * Date headers:
 *   - "Apr 12, 2026" sticky over each day's rows
 *
 * Anchor: build-timeline.ts (TimelineEvent type) + TimelineEvent.tsx
 * (event row rendering).
 */

import { useMemo, useState } from 'react'
import { TimelineEvent } from './TimelineEvent'
import { LifecycleStageChip } from '@/components/lifecycle/LifecycleStageChip'
import { cn } from '@/lib/utils'
import type {
  TimelineEvent as TLEvent,
  TimelineEventKind,
} from '@/lib/services/timeline/build-timeline'

interface Props {
  events: TLEvent[]
  truncated?: boolean
  countsByKind?: Partial<Record<TimelineEventKind, number>>
}

interface KindMeta {
  kind: TimelineEventKind
  label: string
  color: string
}

const KIND_META: ReadonlyArray<KindMeta> = [
  { kind: 'interaction', label: 'Emails', color: 'border-blue-300 text-blue-700 bg-blue-50' },
  { kind: 'tour', label: 'Tours', color: 'border-amber-300 text-amber-700 bg-amber-50' },
  { kind: 'lifecycle_transition', label: 'Lifecycle', color: 'border-purple-300 text-purple-700 bg-purple-50' },
  { kind: 'reconstruction', label: 'Identity', color: 'border-sage-300 text-sage-700 bg-sage-50' },
  { kind: 'intel_derive', label: 'Intel', color: 'border-indigo-300 text-indigo-700 bg-indigo-50' },
  { kind: 'payment', label: 'Payments', color: 'border-emerald-300 text-emerald-700 bg-emerald-50' },
  { kind: 'contract', label: 'Contracts', color: 'border-teal-300 text-teal-700 bg-teal-50' },
  { kind: 'review', label: 'Reviews', color: 'border-yellow-300 text-yellow-700 bg-yellow-50' },
  { kind: 'attribution_event', label: 'Attribution', color: 'border-fuchsia-300 text-fuchsia-700 bg-fuchsia-50' },
  { kind: 'intel_match', label: 'Signal matches', color: 'border-violet-300 text-violet-700 bg-violet-50' },
  { kind: 'discovery', label: 'Discoveries', color: 'border-orange-300 text-orange-700 bg-orange-50' },
  { kind: 'recommendation', label: 'Recommendations', color: 'border-rose-300 text-rose-700 bg-rose-50' },
]

function dayKey(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso.slice(0, 10)
  const d = new Date(t)
  // Local day. UTC at this granularity is also fine; we pick local so
  // the operator's "today" doesn't drift by timezone.
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function dayLabel(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso.slice(0, 10)
  return new Date(t).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function isInflection(e: TLEvent): boolean {
  if (e.kind === 'lifecycle_transition') return true
  if (e.kind === 'contract') return true
  // First review per couple — without state, we mark every review row;
  // realistically a couple has 0-1 reviews so this is the same thing.
  if (e.kind === 'review') return true
  return false
}

export function CoupleTimeline({ events, truncated, countsByKind }: Props) {
  const [selectedKinds, setSelectedKinds] = useState<Set<TimelineEventKind>>(
    new Set(),
  )

  const filtered = useMemo<TLEvent[]>(() => {
    if (selectedKinds.size === 0) return events
    return events.filter((e) => selectedKinds.has(e.kind))
  }, [events, selectedKinds])

  // Group by day-key, preserving the ASC order.
  const groups = useMemo(() => {
    const map = new Map<string, { label: string; events: TLEvent[] }>()
    for (const e of filtered) {
      const k = dayKey(e.timestamp)
      const existing = map.get(k)
      if (existing) {
        existing.events.push(e)
      } else {
        map.set(k, { label: dayLabel(e.timestamp), events: [e] })
      }
    }
    return Array.from(map.entries()).map(([k, v]) => ({ key: k, ...v }))
  }, [filtered])

  function toggleKind(k: TimelineEventKind) {
    setSelectedKinds((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }
  function clearKinds() {
    setSelectedKinds(new Set())
  }

  // Empty state.
  if (events.length === 0) {
    return (
      <div className="bg-surface border border-border rounded-xl p-10 text-center">
        <p className="text-sage-600 text-sm">No events yet for this couple.</p>
        <p className="text-sage-400 text-xs mt-1">
          Once interactions, tours, lifecycle transitions, payments, or
          intel events land, they will appear here in order.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Sticky filter bar. */}
      <div className="sticky top-0 z-10 bg-warm-white/95 backdrop-blur-sm border-b border-border py-3 -mx-2 px-2">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={clearKinds}
            className={cn(
              'inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border transition-colors',
              selectedKinds.size === 0
                ? 'bg-sage-500 text-white border-sage-500'
                : 'bg-surface text-sage-600 border-sage-200 hover:bg-sage-50',
            )}
          >
            All
          </button>
          {KIND_META.map((m) => {
            const count = countsByKind?.[m.kind] ?? 0
            if (count === 0) return null
            const active = selectedKinds.has(m.kind)
            return (
              <button
                key={m.kind}
                type="button"
                onClick={() => toggleKind(m.kind)}
                className={cn(
                  'inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors',
                  active
                    ? m.color
                    : 'bg-surface text-sage-600 border-sage-200 hover:bg-sage-50',
                )}
              >
                {m.label}
                <span className={cn('text-[10px]', active ? '' : 'text-sage-400')}>
                  {count}
                </span>
              </button>
            )
          })}
          {truncated && (
            <span
              className="ml-auto text-[10px] text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded-full"
              title="The timeline is capped at 500 events. Older events are not shown."
            >
              truncated
            </span>
          )}
        </div>
      </div>

      {/* Day-grouped event blocks. */}
      <div className="space-y-6">
        {groups.map((g) => (
          <DayGroup key={g.key} label={g.label} events={g.events} />
        ))}
      </div>
    </div>
  )
}

function DayGroup({
  label,
  events,
}: {
  label: string
  events: TLEvent[]
}) {
  // Inside a day, collapse consecutive same-stage rows so the chip
  // renders once per run.
  // We walk events and decide hideStageChip per row.
  const computed = events.map((e, i) => {
    const prev = events[i - 1]
    const sameStage =
      prev &&
      (prev.lifecycle_stage_at_time ?? null) ===
        (e.lifecycle_stage_at_time ?? null)
    return { e, hide: !!sameStage }
  })

  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <h3 className="text-xs uppercase tracking-wider text-sage-500 font-semibold">
          {label}
        </h3>
        <div className="flex-1 border-t border-sage-100" />
        <span className="text-[10px] text-sage-400">
          {events.length} event{events.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="space-y-1.5">
        {computed.map(({ e, hide }) => (
          <TimelineEvent
            key={e.id}
            event={e}
            inflection={isInflection(e)}
            hideStageChip={hide}
          />
        ))}
      </div>
    </div>
  )
}

// Re-export for symmetric importing.
export type { TLEvent as TimelineEventType }
export { LifecycleStageChip }
