/**
 * Wave 24 — Channel Truth page hydrate endpoint.
 *
 * GET /api/admin/intel/channel-truth/page?venueId=X
 * Returns: ChannelTruthPagePayload
 *
 * Auth:
 *   - getPlatformAuth (demo or coordinator-or-better)
 *   - venueId from auth; explicit body.venueId only honoured for
 *     super_admin / cron
 *
 * Side effects:
 *   - Writes one row to channel_truth_audits per view (for
 *     reproducibility). Cheap insert; surfaces failures as a warning,
 *     never blocks the page.
 *
 * Cost: ~7 Sonnet calls per page view (one per answerable question).
 * Per Wave 21 doctrine: cost per render is logged via callAI; the
 * audit row stores the snapshot so a refresh on the same data does not
 * re-narrate.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import {
  computeChannelTruthPage,
  writeAuditSnapshot,
} from '@/lib/services/channel-truth/compute-all'

export const maxDuration = 120

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const requestedVenueId = url.searchParams.get('venueId')

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  if (
    requestedVenueId &&
    requestedVenueId !== auth.venueId &&
    auth.role !== 'super_admin'
  ) {
    return forbidden('venue does not belong to caller')
  }
  const venueId = requestedVenueId ?? auth.venueId

  try {
    const payload = await computeChannelTruthPage(venueId)
    // Best-effort audit write. Never throws upward.
    if (payload.ok) {
      try {
        const auditRes = await writeAuditSnapshot({
          venueId,
          viewedBy: auth.isDemo ? null : auth.userId,
          payload,
        })
        if (auditRes.error) {
          // eslint-disable-next-line no-console
          console.warn('[channel-truth] audit write failed:', auditRes.error)
        }
      } catch (auditErr) {
        // eslint-disable-next-line no-console
        console.warn('[channel-truth] audit write threw:', auditErr)
      }
    }
    return NextResponse.json(payload)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
