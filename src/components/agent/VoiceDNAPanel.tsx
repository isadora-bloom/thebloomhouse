'use client'

/**
 * Wave 20 — Voice DNA tab content for /agent/learning.
 *
 * Anchor docs:
 *   - bloom-constitution.md (operator authority — every derived item is
 *     a proposal awaiting explicit operator accept)
 *   - feedback_no_em_dash.md
 *
 * What it shows
 * -------------
 * 1. "Derive my voice" button that fires POST /api/admin/voice-dna/derive
 *    against the current venue.
 * 2. Latest derivation card with 4 sections (banned / approved / tone /
 *    principles). Each item has a checkbox, an evidence quote, and a
 *    confidence chip. Global "Apply all picked" + "Dismiss" buttons.
 * 3. History list — older derivations with their applied/dismissed
 *    status.
 *
 * Operator UX rules
 * -----------------
 * - Nothing applies without explicit click (Constitution).
 * - Default to ALL items selected within each section but the operator
 *   can uncheck individual items they don't want.
 * - "Apply all picked" sends the per-field selection back to the
 *   apply endpoint.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  Sparkles,
  Quote,
  CheckCircle,
  XCircle,
  Loader2,
  AlertTriangle,
  Ban,
  Heart,
  Palette,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Wand2,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types — mirror the server shape so the panel can be self-contained.
// ---------------------------------------------------------------------------

interface DerivedBanned {
  phrase: string
  evidence_quote: string
  confidence: number
}
interface DerivedApproved {
  phrase: string
  evidence_quote: string
  confidence: number
}
interface DerivedTone {
  descriptor: string
  evidence_quote: string
  confidence: number
}
interface DerivedPrinciple {
  principle: string
  reasoning: string
  confidence: number
}

interface Derivation {
  id: string
  derived_at: string
  source_summary: {
    coordinator_emails_count?: number
    draft_edits_count?: number
    time_window_days?: number
  } | null
  derived_banned_phrases: DerivedBanned[]
  derived_approved_phrases: DerivedApproved[]
  derived_tone_descriptors: DerivedTone[]
  derived_voice_principles: DerivedPrinciple[]
  cost_cents: number | null
  prompt_version: string | null
  applied: boolean
  applied_fields: string[] | null
  applied_at: string | null
  dismissed: boolean
  dismissed_at: string | null
  dismiss_reason: string | null
}

type ApplyableField =
  | 'banned_phrases'
  | 'approved_phrases'
  | 'tone_descriptors'
  | 'voice_principles'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function fmtCost(dollars: number | null): string {
  if (dollars === null || dollars === undefined) return '$0.00'
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`
  return `$${dollars.toFixed(2)}`
}

function confColor(c: number): string {
  if (c >= 85) return 'bg-emerald-100 text-emerald-700'
  if (c >= 70) return 'bg-sage-100 text-sage-700'
  if (c >= 50) return 'bg-amber-100 text-amber-700'
  return 'bg-red-100 text-red-700'
}

// ---------------------------------------------------------------------------
// Item card primitives
// ---------------------------------------------------------------------------

interface SectionProps<T> {
  title: string
  icon: React.ComponentType<{ className?: string }>
  iconBg: string
  iconColor: string
  items: T[]
  selectedIndexes: Set<number>
  onToggle: (index: number) => void
  renderHeadline: (item: T) => string
  renderEvidence: (item: T) => string
  evidenceLabel: 'Evidence' | 'Reasoning'
  emptyText: string
}

function Section<T extends { confidence: number }>({
  title,
  icon: Icon,
  iconBg,
  iconColor,
  items,
  selectedIndexes,
  onToggle,
  renderHeadline,
  renderEvidence,
  evidenceLabel,
  emptyText,
}: SectionProps<T>) {
  return (
    <div className="bg-warm-white border border-border rounded-lg p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className={`w-7 h-7 rounded ${iconBg} flex items-center justify-center`}>
          <Icon className={`w-4 h-4 ${iconColor}`} />
        </div>
        <h4 className="font-medium text-sage-900 text-sm">{title}</h4>
        <span className="text-xs text-sage-500">({items.length})</span>
      </div>

      {items.length === 0 ? (
        <p className="text-xs text-sage-400 italic px-1">{emptyText}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((item, i) => {
            const selected = selectedIndexes.has(i)
            return (
              <li key={i} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => onToggle(i)}
                  className="mt-1 shrink-0 rounded border-sage-300 text-sage-600 focus:ring-sage-400"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm text-sage-900 font-medium">
                      {renderHeadline(item)}
                    </span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${confColor(item.confidence)}`}>
                      {item.confidence}% confidence
                    </span>
                  </div>
                  <div className="mt-1 flex items-start gap-1.5 text-xs text-sage-600 italic">
                    <Quote className="w-3 h-3 mt-0.5 shrink-0 text-sage-400" />
                    <span className="break-words">
                      <span className="font-medium text-sage-500 not-italic">
                        {evidenceLabel}:
                      </span>{' '}
                      {renderEvidence(item)}
                    </span>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Latest derivation card
// ---------------------------------------------------------------------------

function LatestDerivationCard({
  derivation,
  onApplied,
  onDismissed,
}: {
  derivation: Derivation
  onApplied: () => void
  onDismissed: () => void
}) {
  // Default: all items selected. Operator can uncheck individuals.
  const initSet = (n: number) => new Set(Array.from({ length: n }, (_, i) => i))

  const [bannedSel, setBannedSel] = useState<Set<number>>(
    () => initSet(derivation.derived_banned_phrases.length),
  )
  const [approvedSel, setApprovedSel] = useState<Set<number>>(
    () => initSet(derivation.derived_approved_phrases.length),
  )
  const [toneSel, setToneSel] = useState<Set<number>>(
    () => initSet(derivation.derived_tone_descriptors.length),
  )
  const [principlesSel, setPrinciplesSel] = useState<Set<number>>(
    () => initSet(derivation.derived_voice_principles.length),
  )
  const [applying, setApplying] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const toggleIn = (set: Set<number>, setter: (s: Set<number>) => void, i: number) => {
    const next = new Set(set)
    if (next.has(i)) next.delete(i)
    else next.add(i)
    setter(next)
  }

  const totalSelected =
    bannedSel.size + approvedSel.size + toneSel.size + principlesSel.size

  const handleApply = async () => {
    setApplying(true)
    setErr(null)
    try {
      const fields: ApplyableField[] = []
      const itemIndexes: Record<string, number[]> = {}
      if (bannedSel.size > 0) {
        fields.push('banned_phrases')
        itemIndexes.banned_phrases = Array.from(bannedSel).sort((a, b) => a - b)
      }
      if (approvedSel.size > 0) {
        fields.push('approved_phrases')
        itemIndexes.approved_phrases = Array.from(approvedSel).sort((a, b) => a - b)
      }
      if (toneSel.size > 0) {
        fields.push('tone_descriptors')
        itemIndexes.tone_descriptors = Array.from(toneSel).sort((a, b) => a - b)
      }
      if (principlesSel.size > 0) {
        fields.push('voice_principles')
        itemIndexes.voice_principles = Array.from(principlesSel).sort((a, b) => a - b)
      }
      if (fields.length === 0) {
        setErr('Select at least one item to apply.')
        setApplying(false)
        return
      }

      const res = await fetch(`/api/admin/voice-dna/${derivation.id}/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fields, itemIndexes }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        setErr(json.error ?? json.reason ?? 'Failed to apply')
      } else {
        onApplied()
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to apply')
    } finally {
      setApplying(false)
    }
  }

  const handleDismiss = async () => {
    setDismissing(true)
    setErr(null)
    try {
      const res = await fetch(`/api/admin/voice-dna/${derivation.id}/dismiss`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'operator dismissed from learning page' }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        setErr(json.error ?? json.reason ?? 'Failed to dismiss')
      } else {
        onDismissed()
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to dismiss')
    } finally {
      setDismissing(false)
    }
  }

  const summary = derivation.source_summary ?? {}

  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm">
      <div className="px-6 pt-6 pb-4 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-purple-50 rounded-lg flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-purple-600" />
          </div>
          <div>
            <h3 className="font-heading text-lg font-semibold text-sage-900">
              Latest derivation
            </h3>
            <p className="text-sm text-sage-500">
              Derived {fmtDate(derivation.derived_at)} from{' '}
              <span className="font-medium text-sage-700">
                {summary.coordinator_emails_count ?? 0}
              </span>{' '}
              coordinator emails +{' '}
              <span className="font-medium text-sage-700">
                {summary.draft_edits_count ?? 0}
              </span>{' '}
              draft edits over {summary.time_window_days ?? 0} days. Cost{' '}
              <span className="font-medium text-sage-700">
                {fmtCost(derivation.cost_cents)}
              </span>
              .
            </p>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-4">
        {err && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
            <p className="text-sm text-red-700">{err}</p>
          </div>
        )}

        <Section<DerivedBanned>
          title="Banned phrases"
          icon={Ban}
          iconBg="bg-red-50"
          iconColor="text-red-500"
          items={derivation.derived_banned_phrases}
          selectedIndexes={bannedSel}
          onToggle={(i) => toggleIn(bannedSel, setBannedSel, i)}
          renderHeadline={(item) => item.phrase}
          renderEvidence={(item) => item.evidence_quote}
          evidenceLabel="Evidence"
          emptyText="No banned phrases derived."
        />

        <Section<DerivedApproved>
          title="Approved phrases"
          icon={Heart}
          iconBg="bg-emerald-50"
          iconColor="text-emerald-500"
          items={derivation.derived_approved_phrases}
          selectedIndexes={approvedSel}
          onToggle={(i) => toggleIn(approvedSel, setApprovedSel, i)}
          renderHeadline={(item) => item.phrase}
          renderEvidence={(item) => item.evidence_quote}
          evidenceLabel="Evidence"
          emptyText="No approved phrases derived."
        />

        <Section<DerivedTone>
          title="Tone descriptors"
          icon={Palette}
          iconBg="bg-purple-50"
          iconColor="text-purple-500"
          items={derivation.derived_tone_descriptors}
          selectedIndexes={toneSel}
          onToggle={(i) => toggleIn(toneSel, setToneSel, i)}
          renderHeadline={(item) => item.descriptor}
          renderEvidence={(item) => item.evidence_quote}
          evidenceLabel="Evidence"
          emptyText="No tone descriptors derived."
        />

        <Section<DerivedPrinciple>
          title="Voice principles"
          icon={BookOpen}
          iconBg="bg-amber-50"
          iconColor="text-amber-500"
          items={derivation.derived_voice_principles}
          selectedIndexes={principlesSel}
          onToggle={(i) => toggleIn(principlesSel, setPrinciplesSel, i)}
          renderHeadline={(item) => item.principle}
          renderEvidence={(item) => item.reasoning}
          evidenceLabel="Reasoning"
          emptyText="No voice principles derived."
        />

        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={handleApply}
            disabled={applying || dismissing || totalSelected === 0}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-sage-500 hover:bg-sage-600 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {applying ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <CheckCircle className="w-4 h-4" />
            )}
            Apply {totalSelected} selected
          </button>
          <button
            onClick={handleDismiss}
            disabled={applying || dismissing}
            className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-sage-700 border border-sage-300 rounded-lg hover:bg-sage-50 transition-colors disabled:opacity-50"
          >
            {dismissing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <XCircle className="w-4 h-4" />
            )}
            Dismiss
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// History row (collapsed by default)
// ---------------------------------------------------------------------------

function HistoryRow({ derivation }: { derivation: Derivation }) {
  const [open, setOpen] = useState(false)
  const counts = {
    banned: derivation.derived_banned_phrases.length,
    approved: derivation.derived_approved_phrases.length,
    tone: derivation.derived_tone_descriptors.length,
    principles: derivation.derived_voice_principles.length,
  }
  const total = counts.banned + counts.approved + counts.tone + counts.principles

  const statusBadge = derivation.applied ? (
    <span className="text-[10px] px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded-full">
      Applied
    </span>
  ) : derivation.dismissed ? (
    <span className="text-[10px] px-1.5 py-0.5 bg-red-50 text-red-600 rounded-full">
      Dismissed
    </span>
  ) : (
    <span className="text-[10px] px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded-full">
      Pending
    </span>
  )

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-4 py-3 bg-warm-white hover:bg-sage-50 transition-colors text-left"
      >
        {open ? (
          <ChevronDown className="w-4 h-4 text-sage-400" />
        ) : (
          <ChevronRight className="w-4 h-4 text-sage-400" />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm text-sage-900">
            {fmtDate(derivation.derived_at)}
          </p>
          <p className="text-xs text-sage-500">
            {total} items derived ({counts.banned} banned, {counts.approved} approved,{' '}
            {counts.tone} tone, {counts.principles} principles)
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {statusBadge}
          <span className="text-xs text-sage-400">{fmtCost(derivation.cost_cents)}</span>
        </div>
      </button>
      {open && (
        <div className="px-4 py-3 bg-white border-t border-border space-y-3 text-xs">
          {derivation.applied && derivation.applied_fields && (
            <p className="text-emerald-700">
              Applied {derivation.applied_fields.join(', ')} on {fmtDate(derivation.applied_at ?? '')}
            </p>
          )}
          {derivation.dismissed && (
            <p className="text-red-600">
              Dismissed on {fmtDate(derivation.dismissed_at ?? '')}
              {derivation.dismiss_reason ? `: ${derivation.dismiss_reason}` : ''}
            </p>
          )}
          {derivation.derived_banned_phrases.slice(0, 5).map((p, i) => (
            <p key={`b${i}`} className="text-sage-700">
              <span className="text-red-600 font-medium">[banned]</span> {p.phrase}
            </p>
          ))}
          {derivation.derived_approved_phrases.slice(0, 5).map((p, i) => (
            <p key={`a${i}`} className="text-sage-700">
              <span className="text-emerald-600 font-medium">[approved]</span> {p.phrase}
            </p>
          ))}
          {derivation.derived_tone_descriptors.slice(0, 5).map((p, i) => (
            <p key={`t${i}`} className="text-sage-700">
              <span className="text-purple-600 font-medium">[tone]</span> {p.descriptor}
            </p>
          ))}
          {derivation.derived_voice_principles.slice(0, 5).map((p, i) => (
            <p key={`r${i}`} className="text-sage-700">
              <span className="text-amber-600 font-medium">[principle]</span> {p.principle}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function VoiceDNAPanel({ venueId }: { venueId: string | null | undefined }) {
  const [derivations, setDerivations] = useState<Derivation[]>([])
  const [loading, setLoading] = useState(true)
  const [deriving, setDeriving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!venueId) {
      setLoading(false)
      return
    }
    setLoading(true)
    setErr(null)
    try {
      const res = await fetch(
        `/api/admin/voice-dna/list?venueId=${encodeURIComponent(venueId)}&limit=20`,
      )
      const json = await res.json()
      if (!res.ok || !json.ok) {
        setErr(json.error ?? 'Failed to load derivations')
      } else {
        setDerivations((json.derivations ?? []) as Derivation[])
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [venueId])

  useEffect(() => {
    load()
  }, [load])

  const handleDerive = async () => {
    if (!venueId) return
    setDeriving(true)
    setErr(null)
    try {
      const res = await fetch('/api/admin/voice-dna/derive', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ venueId }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        setErr(
          json.reason === 'insufficient_evidence'
            ? 'Not enough coordinator emails or draft edits yet. Connect Gmail and let some emails flow before deriving.'
            : json.error ?? json.reason ?? 'Failed to derive',
        )
      } else {
        await load()
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to derive')
    } finally {
      setDeriving(false)
    }
  }

  // Latest = unapplied + undismissed if available, else newest row of any state.
  const latest = derivations.find((d) => !d.applied && !d.dismissed) ?? derivations[0]
  const history = latest ? derivations.filter((d) => d.id !== latest.id) : derivations

  return (
    <div className="space-y-6">
      {/* Header + derive button */}
      <div className="bg-surface border border-border rounded-xl shadow-sm">
        <div className="px-6 py-5 flex items-start gap-4">
          <div className="w-12 h-12 bg-gradient-to-br from-purple-100 to-sage-100 rounded-lg flex items-center justify-center shrink-0">
            <Wand2 className="w-6 h-6 text-purple-600" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="font-heading text-xl font-semibold text-sage-900">
              Voice DNA — auto-derive your voice
            </h2>
            <p className="text-sm text-sage-600 mt-1 max-w-2xl">
              Instead of typing every banned phrase, approved phrase, tone and
              principle, let Bloom infer your voice from emails you&apos;ve already
              sent + edits you&apos;ve already made to Sage drafts. Each derived item
              comes with a verbatim evidence quote, so you can audit before
              accepting.
            </p>
          </div>
          <button
            onClick={handleDerive}
            disabled={!venueId || deriving}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            {deriving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4" />
            )}
            {deriving ? 'Deriving...' : 'Derive my voice'}
          </button>
        </div>
      </div>

      {/* Error banner */}
      {err && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{err}</p>
          <button
            onClick={() => setErr(null)}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="bg-surface border border-border rounded-xl p-8 text-center">
          <Loader2 className="w-6 h-6 text-sage-400 animate-spin mx-auto" />
          <p className="text-sm text-sage-500 mt-2">Loading derivations...</p>
        </div>
      )}

      {/* Empty state */}
      {!loading && derivations.length === 0 && (
        <div className="bg-surface border border-border rounded-xl p-8 text-center">
          <Sparkles className="w-10 h-10 text-sage-300 mx-auto mb-3" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
            No derivations yet
          </h3>
          <p className="text-sm text-sage-600 max-w-md mx-auto">
            Hit &ldquo;Derive my voice&rdquo; above. Bloom will analyse your recent
            coordinator emails + Sage draft edits and propose four buckets of
            voice DNA (banned, approved, tone, principles) for you to review.
          </p>
        </div>
      )}

      {/* Latest derivation */}
      {!loading && latest && (
        <LatestDerivationCard
          derivation={latest}
          onApplied={() => load()}
          onDismissed={() => load()}
        />
      )}

      {/* History */}
      {!loading && history.length > 0 && (
        <div className="bg-surface border border-border rounded-xl shadow-sm">
          <div className="px-6 pt-6 pb-4 border-b border-border">
            <h3 className="font-heading text-lg font-semibold text-sage-900">
              Past derivations ({history.length})
            </h3>
            <p className="text-sm text-sage-500">
              Earlier proposals + their applied/dismissed status
            </p>
          </div>
          <div className="p-6 space-y-2">
            {history.map((d) => (
              <HistoryRow key={d.id} derivation={d} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
