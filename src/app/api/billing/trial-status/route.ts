import { NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { resolveBillingState } from '@/lib/services/billing/billing-state'

// ---------------------------------------------------------------------------
// GET /api/billing/trial-status
//
// The honest "is this venue on a trial, and has it run out" read. Backs
// the platform-wide trial banner (src/components/billing/trial-banner.tsx)
// and the trial section of /settings/billing.
//
// Demo venues are never on trial — requirePlan and usePlanTier both treat
// demo the same way, so this route mirrors that rather than showing a
// confusing "trial expired" banner over the sales demo.
//
// Response: { isTrial, trialEndsAt, trialExpired, daysRemaining, tier }
// ---------------------------------------------------------------------------

export async function GET(): Promise<NextResponse> {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (auth.isDemo) {
    return NextResponse.json({
      isTrial: false,
      trialEndsAt: null,
      trialExpired: false,
      daysRemaining: null,
      tier: 'enterprise',
    })
  }

  const state = await resolveBillingState(auth.venueId)

  return NextResponse.json({
    isTrial: state.isTrial,
    trialEndsAt: state.trialEndsAt,
    trialExpired: state.trialExpired,
    daysRemaining: state.daysRemaining,
    tier: state.storedTier,
  })
}
