/**
 * Cron: agency-activity-sweep (Wave 6E follow-up)
 *
 * Auto-writes kpi_missed + report_late entries into agency_activity_log
 * so the timeline self-populates. Daily cadence (vercel.json).
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyCronAuth } from '@/lib/cron-auth'
import { runAgencyActivitySweep } from '@/lib/services/intel/marketing-agency-cron'
import { apiError } from '@/lib/api/api-error'

export const maxDuration = 120

async function handle(request: NextRequest): Promise<NextResponse> {
  const authResult = verifyCronAuth(request, { alwaysDestructive: false })
  if (!authResult.ok) {
    return NextResponse.json(
      { ok: false, error: authResult.error },
      { status: authResult.status },
    )
  }
  try {
    const result = await runAgencyActivitySweep()
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    return apiError(err)
  }
}

export async function GET(request: NextRequest) {
  return handle(request)
}

export async function POST(request: NextRequest) {
  return handle(request)
}
