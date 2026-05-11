'use client'

/**
 * Wave 17 — DisagreementCard.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Pattern 12: the disagreement IS the gold)
 *   - feedback_self_reported_sources_not_truth.md (surfacing the gap >
 *     overwriting one side)
 *
 * Renders one disagreement_findings row:
 *   - Headline + paragraph from the narrator
 *   - Stated vs forensic side-by-side
 *   - Magnitude + confidence + axis chip
 *   - Action row: Resolve / Dismiss / Investigate / Re-narrate
 */

import { useCallback, useMemo, useState } from 'react'
import {
  CheckCircle2,
  XCircle,
  Search,
  Sparkles,
  Loader2,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import type {
  DisagreementAxis,
  DisagreementFindingRow,
} from '@/lib/services/disagreement/types'

interface DisagreementCardProps {
  finding: DisagreementFindingRow
  onUpdated?: () => void
}

const AXIS_LABEL: Record<DisagreementAxis, string> = {
  source: 'Source',
  wedding_date: 'Wedding date',
  guest_count: 'Guest count',
  budget: 'Budget',
  persona: 'Persona',
  close_prediction: 'Close prediction',
  name: 'Name',
  crm_source: 'CRM source',
  other: 'Other',
}

const AXIS_MAGNITUDE_UNIT: Record<DisagreementAxis, string> = {
  source: 'gap',
  wedding_date: 'days',
  guest_count: 'guests',
  budget: '$',
  persona: 'gap',
  close_prediction: 'pct points',
  name: 'gap',
  crm_source: 'gap',
  other: '',
}

const STATUS_BG: Record<string, string> = {
  active: 'bg-amber-50 border-amber-200',
  resolved: 'bg-emerald-50 border-emerald-200',
  dismissed: 'bg-slate-50 border-slate-200',
  investigating: 'bg-blue-50 border-blue-200',
}

const STATUS_PILL: Record<string, string> = {
  active: 'bg-amber-100 text-amber-800',
  resolved: 'bg-emerald-100 text-emerald-800',
  dismissed: 'bg-slate-200 text-slate-700',
  investigating: 'bg-blue-100 text-blue-800',
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '(none)'
  if (typeof v === 'string') return v.length > 0 ? v : '(empty)'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function splitNarrator(text: string | null): { headline: string | null; paragraph: string | null } {
  if (!text) return { headline: null, paragraph: null }
  const parts = text.split(/\n\n+/)
  if (parts.length === 1) return { headline: null, paragraph: parts[0] }
  return { headline: parts[0], paragraph: parts.slice(1).join('\n\n') }
}

export function DisagreementCard({ finding, onUpdated }: DisagreementCardProps) {
  const [busy, setBusy] = useState<string | null>(null)
  const [showActionForm, setShowActionForm] = useState<'resolve' | 'dismiss' | 'investigate' | null>(null)
  const [actionNote, setActionNote] = useState('')
  const [expandedRaw, setExpandedRaw] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const narratorParts = useMemo(
    () => splitNarrator(finding.narrator_text),
    [finding.narrator_text],
  )

  const axis = finding.axis
  const axisLabel = AXIS_LABEL[axis] ?? axis
  const magnitudeUnit = AXIS_MAGNITUDE_UNIT[axis] ?? ''
  const statusBg = STATUS_BG[finding.status] ?? 'bg-white border-slate-200'
  const statusPill = STATUS_PILL[finding.status] ?? 'bg-slate-100 text-slate-700'

  const callAction = useCallback(
    async (
      path: 'resolve' | 'dismiss' | 'investigate',
      body: Record<string, unknown>,
    ) => {
      setBusy(path)
      setError(null)
      try {
        const res = await fetch(
          `/api/admin/intel/disagreements/${finding.id}/${path}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
        )
        const data = (await res.json()) as { ok?: boolean; error?: string }
        if (!res.ok || !data.ok) {
          setError(data.error ?? `${path} failed`)
          return
        }
        setShowActionForm(null)
        setActionNote('')
        if (onUpdated) onUpdated()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(null)
      }
    },
    [finding.id, onUpdated],
  )

  const callNarrate = useCallback(async () => {
    setBusy('narrate')
    setError(null)
    try {
      const res = await fetch(
        `/api/admin/intel/disagreements/${finding.id}/narrate`,
        { method: 'POST' },
      )
      const data = (await res.json()) as { ok?: boolean; error?: string }
      if (!res.ok || !data.ok) {
        setError(data.error ?? 'narrate failed')
        return
      }
      if (onUpdated) onUpdated()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [finding.id, onUpdated])

  return (
    <div className={`rounded-lg border ${statusBg} p-4 space-y-3`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-600 bg-white border border-slate-200 px-2 py-0.5 rounded">
              {axisLabel}
            </span>
            <span className={`text-xs font-medium px-2 py-0.5 rounded ${statusPill}`}>
              {finding.status}
            </span>
            {finding.magnitude_score !== null && (
              <span className="text-xs text-slate-600">
                magnitude:{' '}
                <strong className="font-medium">
                  {magnitudeUnit === '$'
                    ? `$${Math.round(finding.magnitude_score).toLocaleString()}`
                    : `${finding.magnitude_score}${magnitudeUnit ? ` ${magnitudeUnit}` : ''}`}
                </strong>
              </span>
            )}
            {finding.confidence_0_100 !== null && (
              <span className="text-xs text-slate-600">
                confidence: <strong className="font-medium">{finding.confidence_0_100}</strong>
              </span>
            )}
          </div>
          {narratorParts.headline && (
            <div className="font-serif text-lg text-slate-900 leading-snug mb-1">
              {narratorParts.headline}
            </div>
          )}
          {narratorParts.paragraph && (
            <p className="text-sm text-slate-700 leading-relaxed">
              {narratorParts.paragraph}
            </p>
          )}
          {!finding.narrator_text && (
            <div className="text-sm text-slate-500 italic">
              Narrator output not yet generated.
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
        <div className="bg-white border border-slate-200 rounded p-3">
          <div className="font-medium text-slate-500 uppercase text-[10px] tracking-wide mb-1">
            Stated {finding.stated_source_kind ? `(${finding.stated_source_kind})` : ''}
          </div>
          <pre className="whitespace-pre-wrap break-words text-slate-800 font-mono text-xs leading-snug">
            {formatValue(finding.stated_value)}
          </pre>
        </div>
        <div className="bg-white border border-slate-200 rounded p-3">
          <div className="font-medium text-slate-500 uppercase text-[10px] tracking-wide mb-1">
            Forensic {finding.forensic_source_kind ? `(${finding.forensic_source_kind})` : ''}
          </div>
          <pre className="whitespace-pre-wrap break-words text-slate-800 font-mono text-xs leading-snug">
            {formatValue(finding.forensic_value)}
          </pre>
        </div>
      </div>

      {finding.resolution_note && (
        <div className="text-xs text-slate-600 italic border-l-2 border-slate-300 pl-2">
          <strong className="not-italic font-medium">Note:</strong> {finding.resolution_note}
        </div>
      )}

      {error && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {showActionForm && (
        <div className="space-y-2 pt-2 border-t border-slate-200">
          <textarea
            value={actionNote}
            onChange={(e) => setActionNote(e.target.value)}
            placeholder={
              showActionForm === 'dismiss'
                ? 'Why is this not a real disagreement?'
                : showActionForm === 'investigate'
                  ? 'Optional note about what you are investigating'
                  : 'What action did you take?'
            }
            className="w-full text-sm border border-slate-300 rounded px-2 py-1 min-h-[60px]"
            maxLength={1000}
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                const payload = showActionForm === 'dismiss'
                  ? { reason: actionNote }
                  : { note: actionNote }
                callAction(showActionForm, payload)
              }}
              disabled={
                busy !== null ||
                (showActionForm !== 'investigate' && actionNote.trim().length === 0)
              }
              className="text-xs font-medium bg-slate-900 text-white px-3 py-1.5 rounded hover:bg-slate-800 disabled:opacity-50"
            >
              {busy === showActionForm ? (
                <Loader2 className="w-3 h-3 inline animate-spin mr-1" />
              ) : null}
              Confirm {showActionForm}
            </button>
            <button
              onClick={() => {
                setShowActionForm(null)
                setActionNote('')
              }}
              className="text-xs text-slate-600 hover:text-slate-900 px-2 py-1.5"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {!showActionForm && finding.status === 'active' && (
        <div className="flex items-center gap-2 flex-wrap pt-1">
          <button
            onClick={() => setShowActionForm('resolve')}
            className="text-xs font-medium bg-emerald-600 text-white px-3 py-1.5 rounded hover:bg-emerald-700 flex items-center gap-1"
          >
            <CheckCircle2 className="w-3 h-3" /> Resolve
          </button>
          <button
            onClick={() => setShowActionForm('investigate')}
            className="text-xs font-medium bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 flex items-center gap-1"
          >
            <Search className="w-3 h-3" /> Investigate
          </button>
          <button
            onClick={() => setShowActionForm('dismiss')}
            className="text-xs font-medium bg-slate-200 text-slate-700 px-3 py-1.5 rounded hover:bg-slate-300 flex items-center gap-1"
          >
            <XCircle className="w-3 h-3" /> Dismiss
          </button>
          <button
            onClick={callNarrate}
            disabled={busy !== null}
            className="text-xs font-medium text-slate-700 hover:text-slate-900 px-2 py-1.5 flex items-center gap-1 disabled:opacity-50"
            title="Re-generate narrator text"
          >
            {busy === 'narrate' ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Sparkles className="w-3 h-3" />
            )}
            Re-narrate
          </button>
        </div>
      )}

      {!showActionForm && finding.status === 'investigating' && (
        <div className="flex items-center gap-2 flex-wrap pt-1">
          <button
            onClick={() => setShowActionForm('resolve')}
            className="text-xs font-medium bg-emerald-600 text-white px-3 py-1.5 rounded hover:bg-emerald-700 flex items-center gap-1"
          >
            <CheckCircle2 className="w-3 h-3" /> Mark resolved
          </button>
          <button
            onClick={() => setShowActionForm('dismiss')}
            className="text-xs font-medium bg-slate-200 text-slate-700 px-3 py-1.5 rounded hover:bg-slate-300 flex items-center gap-1"
          >
            <XCircle className="w-3 h-3" /> Dismiss
          </button>
        </div>
      )}

      <button
        onClick={() => setExpandedRaw(!expandedRaw)}
        className="text-[11px] text-slate-500 hover:text-slate-700 flex items-center gap-1"
      >
        {expandedRaw ? (
          <ChevronUp className="w-3 h-3" />
        ) : (
          <ChevronDown className="w-3 h-3" />
        )}
        {expandedRaw ? 'Hide' : 'Show'} metadata
      </button>
      {expandedRaw && (
        <div className="text-[11px] text-slate-500 grid grid-cols-2 gap-x-3 gap-y-1">
          <div>id</div>
          <div className="font-mono">{finding.id}</div>
          <div>wedding_id</div>
          <div className="font-mono">{finding.wedding_id ?? '(none)'}</div>
          <div>first detected</div>
          <div>{finding.first_detected_at}</div>
          <div>last observed</div>
          <div>{finding.last_observed_at}</div>
          {finding.narrator_prompt_version && (
            <>
              <div>narrator prompt</div>
              <div className="font-mono">{finding.narrator_prompt_version}</div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
