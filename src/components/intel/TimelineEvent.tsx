'use client'

/**
 * TimelineEvent — Wave 12 reusable row card.
 *
 * Renders one TimelineEvent with an icon, an actor pill, and a
 * lifecycle stage chip showing the stage the couple was IN when the
 * event happened. Click-through is a faint link to the source row;
 * because most source tables don't have dedicated detail routes yet,
 * the link rendering is opt-in (sourceHrefFor returns null → no link).
 *
 * Anchor: src/lib/services/timeline/build-timeline.ts (TimelineEvent
 * type definition).
 */

import {
  ArrowDownRight,
  ArrowUpRight,
  Calendar,
  Sparkles,
  Brain,
  DollarSign,
  FileSignature,
  Star,
  Route,
  Link as LinkIcon,
  Lightbulb,
  TrendingUp,
  CircleDot,
} from 'lucide-react'
import { LifecycleStageChip } from '@/components/lifecycle/LifecycleStageChip'
import type { TimelineEvent as TLEvent, TimelineEventKind } from '@/lib/services/timeline/build-timeline'
import { cn } from '@/lib/utils'

interface Props {
  event: TLEvent
  /** True for the visually-inflection event types (lifecycle change,
   *  contract upload, first review). Highlights with a tinted border. */
  inflection?: boolean
  /** When set, the chip column shows this stage instead of the
   *  event.lifecycle_stage_at_time. Used by CoupleTimeline to render
   *  the stage chip once per group rather than per event row. */
  hideStageChip?: boolean
}

function iconForKind(kind: TimelineEventKind, direction?: 'inbound' | 'outbound') {
  switch (kind) {
    case 'interaction':
      return direction === 'inbound' ? (
        <ArrowDownRight className="w-4 h-4" />
      ) : (
        <ArrowUpRight className="w-4 h-4" />
      )
    case 'tour':
      return <Calendar className="w-4 h-4" />
    case 'lifecycle_transition':
      return <Sparkles className="w-4 h-4" />
    case 'reconstruction':
      return <Sparkles className="w-4 h-4" />
    case 'intel_derive':
      return <Brain className="w-4 h-4" />
    case 'payment':
      return <DollarSign className="w-4 h-4" />
    case 'contract':
      return <FileSignature className="w-4 h-4" />
    case 'review':
      return <Star className="w-4 h-4" />
    case 'attribution_event':
      return <Route className="w-4 h-4" />
    case 'intel_match':
      return <LinkIcon className="w-4 h-4" />
    case 'discovery':
      return <Lightbulb className="w-4 h-4" />
    case 'recommendation':
      return <TrendingUp className="w-4 h-4" />
    default:
      return <CircleDot className="w-4 h-4" />
  }
}

function actorPillClass(actor: string | undefined): string {
  if (!actor) return 'bg-sage-50 text-sage-600'
  if (actor.toLowerCase().includes('sage') || actor.toLowerCase().includes('ai')) {
    return 'bg-indigo-50 text-indigo-700'
  }
  if (actor === 'coordinator') return 'bg-amber-50 text-amber-700'
  if (actor === 'couple') return 'bg-emerald-50 text-emerald-700'
  if (actor === 'system') return 'bg-gray-100 text-gray-600'
  return 'bg-sage-50 text-sage-600'
}

function iconTintClass(kind: TimelineEventKind): string {
  switch (kind) {
    case 'interaction':
      return 'bg-blue-50 text-blue-600 border-blue-100'
    case 'tour':
      return 'bg-amber-50 text-amber-600 border-amber-100'
    case 'lifecycle_transition':
      return 'bg-purple-50 text-purple-600 border-purple-100'
    case 'reconstruction':
      return 'bg-sage-50 text-sage-600 border-sage-100'
    case 'intel_derive':
      return 'bg-indigo-50 text-indigo-600 border-indigo-100'
    case 'payment':
      return 'bg-emerald-50 text-emerald-600 border-emerald-100'
    case 'contract':
      return 'bg-teal-50 text-teal-600 border-teal-100'
    case 'review':
      return 'bg-yellow-50 text-yellow-600 border-yellow-100'
    case 'attribution_event':
      return 'bg-fuchsia-50 text-fuchsia-600 border-fuchsia-100'
    case 'intel_match':
      return 'bg-violet-50 text-violet-600 border-violet-100'
    case 'discovery':
      return 'bg-orange-50 text-orange-600 border-orange-100'
    case 'recommendation':
      return 'bg-rose-50 text-rose-600 border-rose-100'
    default:
      return 'bg-gray-100 text-gray-600 border-gray-200'
  }
}

function relTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 'unknown'
  const diff = Date.now() - t
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 0) {
    // future
    const fm = -minutes
    if (fm < 60) return `in ${fm}m`
    const fh = Math.floor(fm / 60)
    if (fh < 24) return `in ${fh}h`
    return `in ${Math.floor(fh / 24)}d`
  }
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

function absoluteTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  return new Date(t).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function TimelineEvent({ event, inflection, hideStageChip }: Props) {
  return (
    <div
      className={cn(
        'flex gap-3 px-3 py-2.5 rounded-lg border',
        inflection
          ? 'bg-amber-50/40 border-amber-200'
          : 'bg-surface border-border hover:bg-sage-50/40 transition-colors',
      )}
    >
      {/* Stage chip column (left rail). */}
      <div className="shrink-0 w-24 pt-0.5">
        {!hideStageChip && event.lifecycle_stage_at_time ? (
          <LifecycleStageChip
            stage={event.lifecycle_stage_at_time}
            variant="pill"
            className="text-[10px] py-0"
          />
        ) : !hideStageChip ? (
          <span
            className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-50 text-gray-400 border border-gray-100"
            title="No lifecycle stage recorded for this point in time."
          >
            pre-stage
          </span>
        ) : null}
      </div>

      {/* Icon column. */}
      <div
        className={cn(
          'shrink-0 w-8 h-8 rounded-full border flex items-center justify-center mt-0.5',
          iconTintClass(event.kind),
        )}
      >
        {iconForKind(event.kind, event.direction)}
      </div>

      {/* Body. */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2 flex-wrap">
          <span className="font-medium text-sm text-sage-900 break-words">
            {event.title}
          </span>
          {event.actor && (
            <span
              className={cn(
                'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium',
                actorPillClass(event.actor),
              )}
            >
              {event.actor}
            </span>
          )}
        </div>
        {event.summary && (
          <p className="mt-1 text-xs text-sage-600 leading-snug break-words">
            {event.summary}
          </p>
        )}
        <div className="mt-1 flex items-center gap-2 text-[10px] text-sage-400">
          <span title={absoluteTime(event.timestamp)} className="cursor-help">
            {relTime(event.timestamp)}
          </span>
          <span className="font-mono">{event.payload_ref.table}:{event.payload_ref.id.slice(0, 8)}</span>
        </div>
      </div>
    </div>
  )
}
