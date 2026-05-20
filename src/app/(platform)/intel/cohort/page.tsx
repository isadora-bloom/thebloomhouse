'use client'

/**
 * /intel/cohort — cohort intelligence dashboard.
 *
 * Two tabs:
 *   - "Funnel & Timing" (D9, Tier 8) — deterministic couple-keyed
 *     funnel, response-time distributions, lead time, conversion
 *     curve, text-pattern trends, YoY, weather, anomalies. Computed
 *     over the identity-first spine (couples + touchpoints).
 *   - "Themes" (Wave 5B) — the LLM-aggregated emerging themes,
 *     conversion correlations, voice calibration, service demand.
 *
 * The D9 tab is the default — it answers the bulk of the operator's
 * standing questions without an LLM call.
 */

import { useState } from 'react'
import { GitBranch, Sparkles } from 'lucide-react'
import { FunnelTimingTab } from './funnel-timing-tab'
import { ThemesTab } from './themes-tab'

type Tab = 'funnel' | 'themes'

export default function CohortIntelDashboard() {
  const [tab, setTab] = useState<Tab>('funnel')

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold text-sage-900">
          Cohort intelligence
        </h1>
        <p className="text-sm text-sage-600 mt-1">
          How couples move through your funnel, how fast you respond, and
          what&apos;s emerging across the cohort.
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-border">
        <TabButton
          active={tab === 'funnel'}
          onClick={() => setTab('funnel')}
          icon={<GitBranch className="w-4 h-4" />}
          label="Funnel & Timing"
        />
        <TabButton
          active={tab === 'themes'}
          onClick={() => setTab('themes')}
          icon={<Sparkles className="w-4 h-4" />}
          label="Themes"
        />
      </div>

      {tab === 'funnel' ? <FunnelTimingTab /> : <ThemesTab />}
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
          ? 'border-sage-600 text-sage-900 font-medium'
          : 'border-transparent text-sage-500 hover:text-sage-700'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}
