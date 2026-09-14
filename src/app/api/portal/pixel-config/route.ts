import { NextRequest, NextResponse } from 'next/server'
import {
  refuseDemo,
  getPlatformAuth,
  unauthorized,
  serverError,
} from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import {
  getOrCreatePixelConfig,
  rotatePixelIngestKey,
} from '@/lib/services/intel/web-pixel'

/**
 * GET /api/portal/pixel-config
 *
 * Returns the venue's pixel_ingest_key (generated lazily on first read),
 * install status, and recent visit counts.
 */
export async function GET(request: NextRequest) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  try {
    const config = await getOrCreatePixelConfig(auth.venueId)
    return NextResponse.json({ config })
  } catch (err) {
    return serverError(err)
  }
}

/**
 * POST /api/portal/pixel-config/rotate
 *
 * Rotates the pixel_ingest_key. Old key stops working immediately; the
 * venue must update the snippet on their site.
 */
export async function POST(request: NextRequest) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  // The demo identity is an anonymous visitor. It may look; it may not write.
  const demoRefusal = refuseDemo(auth)
  if (demoRefusal) return demoRefusal
  try {
    const newKey = await rotatePixelIngestKey(auth.venueId)
    return NextResponse.json({ pixelIngestKey: newKey })
  } catch (err) {
    return serverError(err)
  }
}
