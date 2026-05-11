/**
 * Wave 18 — Calibration report endpoint.
 *
 * GET /api/admin/intel/calibration/report?venueId=X&kind=Y&windowDays=Z&narrate=1
 *
 * Auth (dual):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path; venueId required.
 *   - else getPlatformAuth (coordinator UI). venueId from auth.
 *
 * Returns: CalibrationReport plus optional Sonnet narrative.
 *
 * The narrate=1 flag triggers a Sonnet call (~$0.02). Default is OFF
 * so the dashboard's initial mount is cheap; the user clicks
 * "Narrator's read" to spend the call.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import { analyzeCalibration } from '@/lib/services/calibration/analyze'
import { narrateCalibration } from '@/lib/services/calibration/narrate'

export const maxDuration = 120

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const queryVenueId = url.searchParams.get('venueId')
  const kind = url.searchParams.get('kind') ?? 'close_probability_pct'
  const windowDaysParam = url.searchParams.get('windowDays')
  const narrateParam = url.searchParams.get('narrate')
  const windowDays = windowDaysParam ? Math.max(1, parseInt(windowDaysParam, 10) || 90) : 90

  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`

  let venueId: string | null = null
  if (cronAuth) {
    if (!queryVenueId) return badRequest('CRON_SECRET path requires venueId')
    venueId = queryVenueId
  } else {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    if (auth.isDemo) return forbidden('demo cannot read calibration')
    if (!auth.venueId) return badRequest('caller has no resolved venue')
    if (queryVenueId && queryVenueId !== auth.venueId) {
      return forbidden('cannot read another venue')
    }
    venueId = auth.venueId
  }

  try {
    const report = await analyzeCalibration({ venueId, kind, windowDays })

    if (narrateParam === '1' && report.diagnostics.sufficientForAnalysis) {
      try {
        const narration = await narrateCalibration(report)
        return NextResponse.json({
          ok: true,
          report,
          narrative: narration.narrative,
          narrativeCostCents: narration.costCents,
          narrativePromptVersion: narration.promptVersion,
        })
      } catch (narrErr) {
        // Narrator failure is non-fatal — return the raw report so
        // the dashboard still renders.
        return NextResponse.json({
          ok: true,
          report,
          narrative: null,
          narrativeError:
            narrErr instanceof Error ? narrErr.message : String(narrErr),
        })
      }
    }

    return NextResponse.json({ ok: true, report })
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
