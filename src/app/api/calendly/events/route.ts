import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import {
  fetchUpcomingEvents,
  CalendlyNotConfiguredError,
  CalendlyReconnectError,
} from '@/lib/services/ingestion/calendly'
import { apiError } from '@/lib/api/api-error'

// ---------------------------------------------------------------------------
// GET /api/calendly/events
//
// Returns the venue coordinator's upcoming Calendly meetings.
//   200 { events: [...] }              — happy path
//   200 { events: [], notConfigured }  — no token resolved (UI prompts connect)
//   200 { events: [], reconnect }      — token expired/invalid, refresh failed
//   401                                — not authenticated as platform user
//   500                                — unexpected failure
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const limit = Number(searchParams.get('limit')) || 20

  try {
    const events = await fetchUpcomingEvents(auth.venueId, { limit })
    return NextResponse.json({ events })
  } catch (err) {
    if (err instanceof CalendlyNotConfiguredError) {
      // Developer-authored, fixed-default message on the error class
      // itself (never raw driver/exception text) — safe to surface.
      const safeMessage = err.message
      return NextResponse.json({
        events: [],
        notConfigured: true,
        message: safeMessage,
      })
    }
    if (err instanceof CalendlyReconnectError) {
      const safeMessage = err.message
      return NextResponse.json({
        events: [],
        reconnect: true,
        message: safeMessage,
      })
    }
    return apiError(err)
  }
}
