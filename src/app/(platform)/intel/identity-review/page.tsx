'use client'

/**
 * /intel/identity-review — Tier 8 §C.5 doctrine page.
 *
 * Two tabs:
 *   - "Review queue" — the existing Phase E adjudication queue
 *     (open candidate_matches, confirm / reject / defer).
 *   - "Identity Report" — the data-integrity report extension shipped
 *     in T8.2: Q6 (couples & confidence), Q29 (top + bottom 20 merges),
 *     Q30 (90-day completeness), Q36 (5 most confident same + 5
 *     borderline pending).
 *
 * The queue stays the default tab — that's the surface the operator
 * loads with intent ("I'm here to adjudicate"). The report is a step
 * back to ask "how is the identity model doing overall?".
 */

import { useState } from 'react'
import { GitBranch, Layers } from 'lucide-react'
import ReviewQueueTab from './review-queue-tab'
import IdentityReportTab from './identity-report-tab'

type Tab = 'queue' | 'report'

export default function IdentityReviewPage() {
  const [tab, setTab] = useState<Tab>('queue')

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <h1 className="font-serif text-3xl text-stone-900">Identity</h1>
        <p className="mt-2 max-w-2xl text-sm text-stone-600">
          Adjudicate borderline matches and read the identity-model report
          showing how confident Bloom is across the cohort.
        </p>
      </div>

      <div className="mb-6 flex items-center gap-1 border-b border-stone-200">
        <TabButton
          active={tab === 'queue'}
          onClick={() => setTab('queue')}
          icon={<GitBranch className="w-4 h-4" />}
          label="Review queue"
        />
        <TabButton
          active={tab === 'report'}
          onClick={() => setTab('report')}
          icon={<Layers className="w-4 h-4" />}
          label="Identity report"
        />
      </div>

      {tab === 'queue' ? <ReviewQueueTab /> : <IdentityReportTab />}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-4 py-2 text-sm border-b-2 -mb-px transition-colors ${
        active
          ? 'border-stone-900 text-stone-900 font-medium'
          : 'border-transparent text-stone-500 hover:text-stone-700'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}
