'use client'

import { usePlanTier, type PlanTier, TIER_DISPLAY, tierMeetsMinimum } from '@/lib/hooks/use-plan-tier'
import { Lock, Sparkles } from 'lucide-react'

/**
 * Wraps page content and shows an upgrade prompt if the current venue's
 * plan tier doesn't meet the required minimum.
 */
export function UpgradeGate({
  requiredTier,
  featureName,
  children,
}: {
  requiredTier: PlanTier
  featureName: string
  children: React.ReactNode
}) {
  const { tier, loading, meetsMinimum } = usePlanTier()

  if (loading) return null
  if (meetsMinimum(requiredTier)) return <>{children}</>

  const required = TIER_DISPLAY[requiredTier]
  const current = TIER_DISPLAY[tier]

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="max-w-md w-full text-center">
        <div className="w-16 h-16 rounded-full bg-sage-50 flex items-center justify-center mx-auto mb-6">
          <Lock className="w-8 h-8 text-sage-400" />
        </div>
        <h2 className="font-heading text-2xl font-bold text-sage-900 mb-2">
          {featureName}
        </h2>
        <p className="text-sage-600 text-sm mb-6">
          This feature is available on the{' '}
          <span className="font-semibold text-sage-800">{required.name}</span> plan
          ({required.price}).
          You&apos;re currently on{' '}
          <span className="font-semibold">{current.name}</span>.
        </p>
        <button className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-sage-600 text-white text-sm font-medium hover:bg-sage-700 transition-colors">
          <Sparkles className="w-4 h-4" />
          Upgrade to {required.name}
        </button>
      </div>
    </div>
  )
}
