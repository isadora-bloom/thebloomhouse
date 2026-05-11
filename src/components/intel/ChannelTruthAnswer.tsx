'use client'

/**
 * Wave 24 — Channel Truth answer card.
 *
 * Renders one narrated answer with:
 *   - Question text (large)
 *   - Headline pull-quote + confidence pill
 *   - Narration paragraph
 *   - Recommendation block (when present)
 *   - Sample-size + v1-contamination badges per cell
 *   - "Expand evidence" toggle (EvidenceChainDrillDown)
 *   - "Share this finding" button
 *
 * Hard-refusal cards render the refusal_reason in place of the
 * narration — no fake number, no headline.
 */

import { useState } from 'react'
import { AlertTriangle, BadgeCheck, Share2, Sparkles } from 'lucide-react'
import { EvidenceChainDrillDown } from './EvidenceChainDrillDown'
import type { NarratedAnswer } from '@/lib/services/channel-truth/types'

interface Props {
  answer: NarratedAnswer
  onShare: (questionId: string, format: 'csv' | 'pdf' | 'link') => void
}

const CONFIDENCE_PILL: Record<
  NarratedAnswer['confidence_level'],
  { label: string; cls: string; icon: 'check' | 'warn' }
> = {
  high: {
    label: 'high confidence',
    cls: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    icon: 'check',
  },
  moderate: {
    label: 'moderate confidence',
    cls: 'bg-amber-100 text-amber-800 border-amber-200',
    icon: 'warn',
  },
  thin: {
    label: 'thin sample',
    cls: 'bg-rose-100 text-rose-800 border-rose-200',
    icon: 'warn',
  },
}

export function ChannelTruthAnswer({ answer, onShare }: Props) {
  const [shareOpen, setShareOpen] = useState(false)
  const isRefusal =
    !!answer.hard_refusal || !!answer.narrator.refusal_reason
  const pill = CONFIDENCE_PILL[answer.confidence_level]
  const refusalReason =
    answer.hard_refusal?.reason ?? answer.narrator.refusal_reason ?? ''

  return (
    <div className="bg-white border border-stone-200 rounded-lg p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4 mb-3">
        <h3 className="text-xl font-serif text-stone-900 leading-snug">
          {answer.question_text}
        </h3>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span
            className={`text-xs px-2 py-1 rounded-full border ${pill.cls} inline-flex items-center gap-1`}
          >
            {pill.icon === 'check' ? (
              <BadgeCheck className="w-3 h-3" />
            ) : (
              <AlertTriangle className="w-3 h-3" />
            )}
            {pill.label} (n={answer.total_sample_size})
          </span>
        </div>
      </div>

      {answer.v1_contamination_pct > 0 && !isRefusal && (
        <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded-md text-sm text-amber-900 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold">
              {answer.v1_contamination_pct.toFixed(1)}% of cells in this
              calculation were classified under a bias-contaminated prompt
              (v1).
            </span>{' '}
            Re-run /api/admin/attribution/reclassify-v1 for clean numbers
            before citing this finding externally.
          </div>
        </div>
      )}

      {isRefusal ? (
        <div className="p-4 bg-stone-50 border border-stone-200 rounded-md">
          <div className="flex items-start gap-2 text-stone-700">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5 text-stone-500" />
            <div>
              <div className="font-semibold mb-1">
                Insufficient data to answer this question yet.
              </div>
              <div className="text-sm text-stone-600">{refusalReason}</div>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="mb-3">
            <div className="text-lg font-serif text-stone-900 italic mb-2 leading-snug">
              &ldquo;{answer.narrator.headline_pull_quote}&rdquo;
            </div>
            <div className="text-stone-700 leading-relaxed">
              {answer.narrator.narration_paragraph}
            </div>
          </div>

          {answer.narrator.recommendation_if_any && (
            <div className="mb-3 p-3 bg-sky-50 border border-sky-200 rounded-md text-sm text-sky-900 flex items-start gap-2">
              <Sparkles className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold mb-0.5">Possible next step:</div>
                {answer.narrator.recommendation_if_any}
              </div>
            </div>
          )}

          {answer.cells.length > 0 && (
            <div className="mb-3 grid grid-cols-2 md:grid-cols-3 gap-2">
              {answer.cells.map((c) => (
                <div
                  key={c.label}
                  className="p-2 bg-stone-50 border border-stone-200 rounded-md text-xs"
                >
                  <div className="text-stone-500 font-mono truncate" title={c.label}>
                    {c.label}
                  </div>
                  <div className="text-stone-900 font-semibold">
                    {formatHeadlineValue(c.headline_value)}
                  </div>
                  <div className="text-stone-500">n={c.n}</div>
                  {c.v1_contaminated_pct > 0 && (
                    <div className="text-amber-700">
                      v1: {c.v1_contaminated_pct.toFixed(0)}%
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <EvidenceChainDrillDown
        weddings={answer.evidence_weddings}
        computeSignature={answer.compute_signature}
        computedAtIso={answer.computed_at_iso}
        promptVersionsUsed={answer.prompt_versions_used}
        contextNotes={answer.context_notes}
      />

      <div className="mt-3 flex items-center justify-between">
        <div className="text-xs text-stone-500">
          Narrator: {answer.narrator_prompt_version}
        </div>
        <div className="relative">
          <button
            onClick={() => setShareOpen((o) => !o)}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-stone-700 bg-white border border-stone-200 rounded-md hover:bg-stone-50"
          >
            <Share2 className="w-3 h-3" />
            Share this finding
          </button>
          {shareOpen && (
            <div className="absolute right-0 top-full mt-1 bg-white border border-stone-200 rounded-md shadow-lg z-10 min-w-[120px]">
              {(['csv', 'pdf', 'link'] as const).map((fmt) => (
                <button
                  key={fmt}
                  onClick={() => {
                    setShareOpen(false)
                    onShare(answer.question_id, fmt)
                  }}
                  className="block w-full text-left px-3 py-1.5 text-xs hover:bg-stone-50"
                >
                  Export as {fmt.toUpperCase()}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function formatHeadlineValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number') {
    if (v >= 0 && v <= 1) return `${(v * 100).toFixed(1)}%`
    return String(v)
  }
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v).slice(0, 60)
  } catch {
    return String(v).slice(0, 60)
  }
}
