/**
 * The one lifecycle pill. Wave 5, W37.
 *
 * Three surfaces used to render a couple's state three different ways: the
 * couples list had its own eight-value pill, the pipeline had none and let
 * the column speak for the card, and the couple page printed the raw state
 * from the database into a grey chip. Same couple, three answers.
 *
 * This component is the only place those words, colours and tooltips are
 * chosen. It renders a stage that
 * `src/lib/services/lifecycle/vocabulary.ts` derived; it does no deriving
 * of its own, so a surface cannot quietly invent a fourteenth stage by
 * passing different inputs.
 *
 * The tooltip is the `because` sentence. It is the whole point of the
 * pill: a card sitting in the Tour Booked column with a "Gone quiet" pill
 * is confusing until you read the one line that says why.
 */

'use client'

import type {
  OperatorStageResult,
  OperatorStageTone,
} from '@/lib/services/lifecycle/vocabulary'

/** Tone to Tailwind. The tones come from the vocabulary module, which
 *  knows nothing about CSS; the classes live here, which knows nothing
 *  about lifecycles. */
const TONE_CLASS: Record<OperatorStageTone, string> = {
  new: 'bg-stone-100 text-stone-700 border-stone-200',
  live: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  warm: 'bg-amber-100 text-amber-800 border-amber-200',
  won: 'bg-sky-100 text-sky-800 border-sky-200',
  done: 'bg-indigo-100 text-indigo-800 border-indigo-200',
  quiet: 'bg-stone-100 text-stone-500 border-stone-200',
  off: 'bg-violet-100 text-violet-800 border-violet-200',
}

const SIZE_CLASS = {
  sm: 'px-1.5 py-0.5 text-[10px]',
  md: 'px-2 py-0.5 text-xs',
} as const

export interface LifecyclePillProps {
  /** The derived stage, straight from `deriveOperatorStage`. */
  stage: OperatorStageResult
  size?: keyof typeof SIZE_CLASS
  /** Show a dot when the record and the pipeline point at different
   *  places. Off by default; the couples list and the pipeline card turn
   *  it on because that is where the two are side by side. */
  showDisagreement?: boolean
  className?: string
}

export function LifecyclePill({
  stage,
  size = 'md',
  showDisagreement = false,
  className = '',
}: LifecyclePillProps) {
  const disagreed = stage.agreement === 'disagreed'
  return (
    <span
      title={stage.because}
      data-stage={stage.stage}
      data-agreement={stage.agreement}
      className={`inline-flex items-center gap-1 rounded-full border font-medium ${
        SIZE_CLASS[size]
      } ${TONE_CLASS[stage.tone]} ${className}`}
    >
      {showDisagreement && disagreed && (
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-60"
        />
      )}
      {stage.label}
      {showDisagreement && disagreed && (
        <span className="sr-only"> (the record and your pipeline disagree)</span>
      )}
    </span>
  )
}

export default LifecyclePill
