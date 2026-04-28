'use client'

import { useState, useEffect } from 'react'
import { Pencil, Check, X, Loader2 } from 'lucide-react'

/**
 * Editable source badge. Replaces the static `sourceBadge` rendering
 * on the wedding detail page. Click the pencil to switch to a
 * dropdown; pick a canonical source; click the check to apply. The
 * write goes through /api/agent/leads/[id]/source which delegates to
 * applyBacktrace, so the same audit metadata
 * (backtraced_from / backtraced_to / backtraced_at / backtraced_by)
 * is recorded as a coordinator-confirmed bulk re-attribution.
 *
 * Surfaces the audit trail inline when present: "originally Calendly,
 * re-attributed Apr 28". The line answers the most common question a
 * coordinator has when they see a non-obvious source: "did someone
 * change this?"
 */

/**
 * Sources a coordinator can pick. Scheduling-tool sources
 * (calendly/acuity/honeybook/dubsado) are intentionally excluded —
 * they're never a real first-touch, only the channel where the lead
 * happened to land last. The API enforces the same exclusion server-
 * side. Calendly/etc. still render correctly in `styleFor()` since
 * existing weddings may have those values.
 */
const SELECTABLE_SOURCES = [
  'the_knot',
  'wedding_wire',
  'here_comes_the_guide',
  'zola',
  'website',
  'venue_calculator',
  'instagram',
  'facebook',
  'google',
  'referral',
  'walk_in',
  'direct',
  'other',
] as const

const SOURCE_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  the_knot:             { bg: 'bg-rose-50',    text: 'text-rose-700',    label: 'The Knot' },
  wedding_wire:         { bg: 'bg-blue-50',    text: 'text-blue-700',    label: 'Wedding Wire' },
  here_comes_the_guide: { bg: 'bg-violet-50',  text: 'text-violet-700',  label: 'Here Comes The Guide' },
  zola:                 { bg: 'bg-purple-50',  text: 'text-purple-700',  label: 'Zola' },
  website:              { bg: 'bg-teal-50',    text: 'text-teal-700',    label: 'Website' },
  venue_calculator:     { bg: 'bg-amber-50',   text: 'text-amber-700',   label: 'Venue Calculator' },
  instagram:            { bg: 'bg-pink-50',    text: 'text-pink-700',    label: 'Instagram' },
  facebook:             { bg: 'bg-indigo-50',  text: 'text-indigo-700',  label: 'Facebook' },
  google:               { bg: 'bg-sky-50',     text: 'text-sky-700',     label: 'Google' },
  referral:             { bg: 'bg-emerald-50', text: 'text-emerald-700', label: 'Word of Mouth' },
  walk_in:              { bg: 'bg-amber-50',   text: 'text-amber-700',   label: 'Walk-in' },
  direct:               { bg: 'bg-slate-50',   text: 'text-slate-700',   label: 'Direct' },
  calendly:             { bg: 'bg-blue-50',    text: 'text-blue-700',    label: 'Calendly' },
  acuity:               { bg: 'bg-cyan-50',    text: 'text-cyan-700',    label: 'Acuity' },
  honeybook:            { bg: 'bg-amber-50',   text: 'text-amber-700',   label: 'HoneyBook' },
  dubsado:              { bg: 'bg-stone-50',   text: 'text-stone-700',   label: 'Dubsado' },
  other:                { bg: 'bg-sage-50',    text: 'text-sage-600',    label: 'Other' },
}

function styleFor(source: string | null): { bg: string; text: string; label: string } {
  if (!source) return { bg: 'bg-sage-50', text: 'text-sage-500', label: 'Unknown' }
  return SOURCE_STYLES[source] ?? { bg: 'bg-sage-50', text: 'text-sage-600', label: source.replace(/_/g, ' ') }
}

interface AuditTrail {
  backtracedFrom: string | null
  backtracedTo: string | null
  backtracedAt: string | null
  backtracedBy: string | null
}

interface Props {
  weddingId: string
  initialSource: string | null
  /** Called after a successful update with the new source so the page
   *  can refresh dependent state (the source label in the header,
   *  source-attribution charts elsewhere on the page). */
  onUpdated?: (newSource: string) => void
}

export function SourceBadgeEditable({ weddingId, initialSource, onUpdated }: Props) {
  const [source, setSource] = useState<string | null>(initialSource)
  const [audit, setAudit] = useState<AuditTrail | null>(null)
  const [editing, setEditing] = useState(false)
  const [pending, setPending] = useState<string>(initialSource ?? 'other')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fetch the audit trail on mount + on every update so the
  // "re-attributed" hint stays accurate.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/agent/leads/${weddingId}/source`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { source?: string; audit?: AuditTrail } | null) => {
        if (cancelled || !json) return
        if (typeof json.source === 'string' || json.source === null) setSource(json.source ?? null)
        if (json.audit) setAudit(json.audit)
      })
      .catch(() => { /* non-fatal — UI stays in fallback */ })
    return () => { cancelled = true }
  }, [weddingId])

  const current = styleFor(source)
  const previous = audit?.backtracedFrom ? styleFor(audit.backtracedFrom) : null

  async function apply() {
    if (!pending || pending === source) {
      setEditing(false)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/agent/leads/${weddingId}/source`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ newSource: pending }),
      })
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(json.error ?? `HTTP ${res.status}`)
      }
      const json = (await res.json()) as { newSource: string }
      setSource(json.newSource)
      onUpdated?.(json.newSource)
      // Re-pull audit so the hint reflects the just-applied change.
      const a = await fetch(`/api/agent/leads/${weddingId}/source`)
      if (a.ok) {
        const ajson = (await a.json()) as { audit?: AuditTrail }
        if (ajson.audit) setAudit(ajson.audit)
      }
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  function cancel() {
    setPending(source ?? 'other')
    setEditing(false)
    setError(null)
  }

  if (editing) {
    return (
      <span className="inline-flex items-center gap-2">
        <select
          value={pending}
          onChange={(e) => setPending(e.target.value)}
          className="text-xs border border-border rounded px-2 py-1 bg-surface"
          disabled={saving}
        >
          {SELECTABLE_SOURCES.map((s) => (
            <option key={s} value={s}>
              {styleFor(s).label}
            </option>
          ))}
        </select>
        <button
          onClick={apply}
          disabled={saving || pending === source}
          className="inline-flex items-center justify-center w-6 h-6 rounded bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white"
          title="Apply"
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
        </button>
        <button
          onClick={cancel}
          disabled={saving}
          className="inline-flex items-center justify-center w-6 h-6 rounded bg-sage-50 hover:bg-sage-100 text-sage-600 border border-border"
          title="Cancel"
        >
          <X className="w-3 h-3" />
        </button>
        {error && <span className="text-[11px] text-red-600">{error}</span>}
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-2">
      <span
        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${current.bg} ${current.text}`}
      >
        {current.label}
      </span>
      <button
        onClick={() => {
          setPending(source ?? 'other')
          setEditing(true)
        }}
        className="inline-flex items-center justify-center w-5 h-5 rounded text-sage-400 hover:text-sage-700 hover:bg-sage-50 transition-colors"
        title="Edit source"
      >
        <Pencil className="w-3 h-3" />
      </button>
      {previous && audit?.backtracedAt && (
        <span className="text-[11px] text-sage-500" title={
          audit.backtracedBy
            ? `Re-attributed by user ${audit.backtracedBy.slice(0, 8)}…`
            : 'Re-attributed via the source-backtrace tool'
        }>
          (originally{' '}
          <span className={`${previous.text} font-medium`}>{previous.label}</span>,
          re-attributed {new Date(audit.backtracedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})
        </span>
      )}
    </span>
  )
}
