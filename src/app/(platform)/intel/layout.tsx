'use client'

import { UpgradeGate } from '@/components/ui/upgrade-gate'

export default function IntelLayout({ children }: { children: React.ReactNode }) {
  return (
    <UpgradeGate requiredTier="solo" featureName="Bloom Intelligence">
      {children}
    </UpgradeGate>
  )
}
