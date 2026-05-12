/**
 * Cron: tbh-reports-monthly (Wave 6E follow-up)
 *
 * On the first of each month, generates an internal-mode TBH Report
 * for every agency with an active engagement, covering the prior
 * calendar month. Idempotent: re-runs that find an existing report
 * for the same (agency, period, mode) skip.
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyCronAuth } from '@/lib/cron-auth'
import { runTbhReportsMonthly } from '@/lib/services/intel/marketing-agency-cron'

export const maxDuration = 300

async function handle(request: NextRequest): Promise<NextResponse> {
  const authResult = verifyCronAuth(request, { alwaysDestructive: false })
  if (!authResult.ok) {
    return NextResponse.json(
      { ok: false, error: authResult.error },
      { status: authResult.status },
    )
  }
  try {
    const result = await runTbhReportsMonthly()
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    )
  }
}

export async function GET(request: NextRequest) {
  return handle(request)
}

export async function POST(request: NextRequest) {
  return handle(request)
}
