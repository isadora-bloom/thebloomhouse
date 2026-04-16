import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import {
  getOutcomesForVenue,
  getOutcomeForInsight,
} from '@/lib/services/insight-tracking'

// ---------------------------------------------------------------------------
// GET — Fetch insight outcomes
// Query params:
//   ?insight_id=UUID  — get outcome for a specific insight
//   (no params)       — get all outcomes for the venue (for ROI view)
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sp = req.nextUrl.searchParams
  const insightId = sp.get('insight_id')

  try {
    if (insightId) {
      const outcome = await getOutcomeForInsight(insightId)
      return NextResponse.json({ outcome })
    }

    const limit = Math.min(Number(sp.get('limit') || '50'), 200)
    const outcomes = await getOutcomesForVenue(auth.venueId, limit)

    // Compute summary stats for ROI view
    const total = outcomes.length
    const improved = outcomes.filter((o) => o.verdict === 'improved').length
    const unchanged = outcomes.filter((o) => o.verdict === 'unchanged').length
    const declined = outcomes.filter((o) => o.verdict === 'declined').length
    const pending = outcomes.filter((o) => o.verdict === 'pending').length

    return NextResponse.json({
      outcomes,
      stats: {
        total,
        improved,
        unchanged,
        declined,
        pending,
        improvement_rate: total > 0 ? Math.round((improved / (total - pending)) * 100) || 0 : 0,
      },
    })
  } catch (err) {
    console.error('[api/intel/outcomes] GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
