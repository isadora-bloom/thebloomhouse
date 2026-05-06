import { NextRequest, NextResponse } from 'next/server'
import { logRead } from '@/lib/services/activity-logger'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { getCoupleAuth } from '@/lib/api/auth-helpers'
import { checkRateLimit } from '@/lib/rate-limit'

// ---------------------------------------------------------------------------
// /api/audit/export — beacon for client-side CSV exports
//
// CSV exports happen in the browser (src/lib/utils/csv-export.ts builds
// the file from data already in memory and triggers a download). There
// is no server roundtrip on download itself, so the only way to record
// the event is for the client to ping this endpoint when the user
// clicks the download button.
//
// Auth: accepts either platform (coordinator) or couple. Either is a
// legitimate exporter — coordinators export coordinator surfaces,
// couples export their own portal data.
//
// Rate limit: 30/hour per user. A user clicking "Download" 30 times
// in an hour is already abnormal; if the limit is hit we still log
// the attempt (so the bypass attempt itself is auditable).
//
// Per 2026-05-06 audit Lens 8 top-3 fix #1.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  // Try platform auth first; fall back to couple auth. We do NOT
  // require auth strictly — failing to log is preferable to blocking
  // the export, but we want SOME identifier to attribute it to.
  const platform = await getPlatformAuth()
  const couple = platform ? null : await getCoupleAuth()

  const userId = platform?.userId ?? couple?.userId ?? null
  const venueId = platform?.venueId ?? couple?.venueId ?? null
  const weddingId = couple?.weddingId ?? null

  if (!venueId) {
    // Genuine unauthenticated caller. Don't log — there's no actor
    // to attribute the action to. Return 204 so callers can fire-
    // and-forget without console errors.
    return new NextResponse(null, { status: 204 })
  }

  // Rate-limit at the user level (or venue level if user is anon).
  const rateKey = userId ? `audit-export:${userId}` : `audit-export:venue:${venueId}`
  const rl = await checkRateLimit({
    key: rateKey,
    limit: 30,
    windowSec: 3600,
  })

  let body: {
    resource?: string
    mode?: 'view' | 'export' | 'bulk_read'
    rowCount?: number
    filename?: string
    format?: string
    details?: Record<string, unknown>
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  if (!body.resource || typeof body.resource !== 'string') {
    return NextResponse.json({ error: 'resource is required' }, { status: 400 })
  }
  const mode = body.mode ?? 'export'
  if (!['view', 'export', 'bulk_read'].includes(mode)) {
    return NextResponse.json({ error: 'invalid mode' }, { status: 400 })
  }

  // Always log, even if rate-limited — we want the bypass attempt
  // itself to leave a trail.
  await logRead({
    venueId,
    weddingId: weddingId ?? undefined,
    userId: userId ?? undefined,
    resource: body.resource.replace(/[^a-z0-9_]/gi, '_').toLowerCase().slice(0, 64),
    mode,
    rowCount: typeof body.rowCount === 'number' ? body.rowCount : undefined,
    details: {
      filename: typeof body.filename === 'string' ? body.filename.slice(0, 200) : null,
      format: typeof body.format === 'string' ? body.format.slice(0, 32) : null,
      rate_limited: !rl.ok,
      ...(body.details ?? {}),
    },
  })

  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Rate limit exceeded', logged: true },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000)),
        },
      },
    )
  }

  return NextResponse.json({ logged: true })
}
