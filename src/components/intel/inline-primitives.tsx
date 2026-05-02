/**
 * Shared inline primitives for intel surfaces (T4-B / Playbook 20.2).
 *
 * Companion to HeatBadge (already shipped in src/components/intel/
 * heat-badge.tsx). These primitives are the rest of the visual
 * vocabulary the playbook wants used consistently across every
 * surface (lead detail, leads list, pipeline, intel pages, /pulse).
 *
 * Each primitive is single-purpose, small, and accepts the minimum
 * data it needs. No state, no fetching — pure render.
 */

import { AlertTriangle, Users, History } from 'lucide-react'

// ---------------------------------------------------------------------------
// RiskFlag — surfaces a risk signal with severity color
// ---------------------------------------------------------------------------

export type RiskSeverity = 1 | 2 | 3

export interface RiskFlagProps {
  /** 1-3, where 3 is highest. Drives color. */
  severity: RiskSeverity
  /** Short label rendered next to the icon. */
  label: string
  /** Optional tooltip / longer evidence text. */
  title?: string
  className?: string
}

const RISK_STYLE: Record<RiskSeverity, { bg: string; text: string; border: string }> = {
  3: { bg: 'bg-red-100',   text: 'text-red-800',   border: 'border-red-200' },
  2: { bg: 'bg-amber-100', text: 'text-amber-800', border: 'border-amber-200' },
  1: { bg: 'bg-sage-100',  text: 'text-sage-700',  border: 'border-sage-200' },
}

export function RiskFlag({ severity, label, title, className }: RiskFlagProps) {
  const s = RISK_STYLE[severity] ?? RISK_STYLE[1]
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium ${s.bg} ${s.text} ${s.border} ${className ?? ''}`}
      title={title}
    >
      <AlertTriangle className="w-3 h-3" />
      {label}
      <span className="text-[9px] opacity-75 font-mono ml-1">sev{severity}</span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// ConfidenceBadge — single rendering of confidence levels
// ---------------------------------------------------------------------------

export type ConfidenceLevel = 'low' | 'medium' | 'high'

export interface ConfidenceBadgeProps {
  /** 0..1 numeric confidence; level computed from value. */
  value: number
  /** Optional override for the visible label. */
  label?: string
  /** Compact = pill-only; verbose = "High conf (0.82)". */
  variant?: 'compact' | 'verbose'
  className?: string
}

const CONFIDENCE_STYLE: Record<ConfidenceLevel, { bg: string; text: string; label: string }> = {
  high:   { bg: 'bg-emerald-50', text: 'text-emerald-700', label: 'High' },
  medium: { bg: 'bg-amber-50',   text: 'text-amber-700',   label: 'Medium' },
  low:    { bg: 'bg-sage-50',    text: 'text-sage-500',    label: 'Low' },
}

export function levelForConfidence(value: number): ConfidenceLevel {
  if (value >= 0.7) return 'high'
  if (value >= 0.45) return 'medium'
  return 'low'
}

export function ConfidenceBadge({ value, label, variant = 'compact', className }: ConfidenceBadgeProps) {
  const safe = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
  const level = levelForConfidence(safe)
  const s = CONFIDENCE_STYLE[level]
  const text = label ?? (variant === 'verbose' ? `${s.label} conf (${safe.toFixed(2)})` : `${s.label} conf`)
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${s.bg} ${s.text} ${className ?? ''}`}
      title={`${s.label} confidence (${safe.toFixed(2)})`}
    >
      {text}
    </span>
  )
}

// ---------------------------------------------------------------------------
// CoupleBadge — partner1+partner2 names with friendly fallback
// ---------------------------------------------------------------------------

export interface CoupleBadgeProps {
  partner1?: string | null
  partner2?: string | null
  /** Optional client code (e.g., "Smith.B") shown in mono next to names. */
  clientCode?: string | null
  /** Truncate long names to N chars (default 32). */
  maxChars?: number
  className?: string
}

export function CoupleBadge({ partner1, partner2, clientCode, maxChars = 32, className }: CoupleBadgeProps) {
  const p1 = (partner1 ?? '').trim()
  const p2 = (partner2 ?? '').trim()
  let name: string
  if (p1 && p2) name = `${p1} & ${p2}`
  else if (p1) name = p1
  else if (p2) name = p2
  else name = 'Unknown couple'
  const truncated = name.length > maxChars ? name.slice(0, maxChars - 1) + '…' : name
  return (
    <span className={`inline-flex items-baseline gap-2 ${className ?? ''}`} title={name}>
      <span className="text-sm font-medium text-sage-900">{truncated}</span>
      {clientCode && (
        <span className="text-xs font-mono text-sage-500">{clientCode}</span>
      )}
    </span>
  )
}

// ---------------------------------------------------------------------------
// PriorTouchesBadge — surfaces past-touchpoint count with negative-result
// transparency (see T1-D). Empty / zero shows neutrally; non-zero
// shows count with a tooltip listing source platforms.
// ---------------------------------------------------------------------------

export interface PriorTouchesBadgeProps {
  count: number
  platforms?: string[]
  className?: string
}

export function PriorTouchesBadge({ count, platforms = [], className }: PriorTouchesBadgeProps) {
  const isNegativeResult = count === 0
  const platformLabel = platforms.length > 0 ? platforms.slice(0, 3).join(', ') : null
  const tooltip = isNegativeResult
    ? 'Searched cross-platform; no prior touches found'
    : `${count} prior touch${count === 1 ? '' : 'es'}${platformLabel ? ` (${platformLabel})` : ''}`
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs ${isNegativeResult ? 'text-sage-400 italic' : 'text-sage-700'} ${className ?? ''}`}
      title={tooltip}
    >
      <History className="w-3 h-3" />
      {isNegativeResult ? (
        <span>No prior touches</span>
      ) : (
        <span>{count} prior touch{count === 1 ? '' : 'es'}</span>
      )}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Optional convenience: named-cohort badge (used by T3-D cohort-match
// surfaces). Adds the user-recognisable Users icon for cohort-shape
// rendering.
// ---------------------------------------------------------------------------

export interface CohortBadgeProps {
  booked: number
  total: number
  className?: string
}

export function CohortBadge({ booked, total, className }: CohortBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs text-sage-700 ${className ?? ''}`}
      title={`${booked} of ${total} similar past leads booked`}
    >
      <Users className="w-3 h-3" />
      {booked}/{total} booked
    </span>
  )
}

// Pure helpers exported for unit tests.
export const __test__ = {
  levelForConfidence,
}
