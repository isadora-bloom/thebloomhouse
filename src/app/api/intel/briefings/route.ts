import { NextRequest, NextResponse } from 'next/server'
import {
  getLatestBriefing,
  getAllBriefings,
  generateWeeklyBriefing,
  generateMonthlyBriefing,
} from '@/lib/services/briefings'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'

// ---------------------------------------------------------------------------
// GET — Latest briefing(s)
//   ?type=weekly|monthly  (default: weekly)
//   ?all=true             for a list of recent briefings (limit 10)
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const plan = await requirePlan(request, 'intelligence')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(request.url)
    const type = searchParams.get('type') ?? 'weekly'
    const all = searchParams.get('all') === 'true'

    if (all) {
      const briefings = await getAllBriefings(auth.venueId, 10)
      return NextResponse.json({ briefings })
    }

    const briefing = await getLatestBriefing(auth.venueId, type)
    return NextResponse.json({ briefing })
  } catch (err) {
    console.error('[api/intel/briefings] GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// POST — Generate a new briefing
//   Body: { type: 'weekly' | 'monthly' }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const plan = await requirePlan(request, 'intelligence')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const type = body.type ?? 'weekly'

    if (type !== 'weekly' && type !== 'monthly') {
      return NextResponse.json(
        { error: 'Invalid briefing type. Must be "weekly" or "monthly".' },
        { status: 400 }
      )
    }

    const briefing = type === 'weekly'
      ? await generateWeeklyBriefing(auth.venueId)
      : await generateMonthlyBriefing(auth.venueId)

    return NextResponse.json({ briefing })
  } catch (err) {
    console.error('[api/intel/briefings] POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
