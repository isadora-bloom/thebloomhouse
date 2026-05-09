/**
 * /api/admin/identity/seed-vendor-domains  —  one-shot backfill
 * ------------------------------------------------------------
 *
 * Anchors:
 *   - migration 258 (venue_vendor_domains)
 *   - src/lib/services/inbox/vendor-domains.ts (promoteVendorDomain)
 *
 * Why this exists
 * ---------------
 * Some venues have run /api/admin/reclass-folders-ai already (Haiku
 * already labelled hundreds of inbox rows as 'vendor' before mig 258
 * shipped). This endpoint mines those existing classifications: it
 * scans interactions where lifecycle_folder='vendor' AND
 * direction='inbound' AND from_email IS NOT NULL, groups by sender
 * domain, and auto-promotes any domain that appears at least
 * MIN_OCCURRENCES (default 2) times into venue_vendor_domains with
 * source='backfill'.
 *
 * The two-occurrence floor is the spec: a single 'vendor' label
 * could be a one-off classification mistake; two from the same domain
 * is the coordinator (or Haiku) labelling consistently and is the
 * safe bar to auto-promote.
 *
 * Auth: getPlatformAuth + auth.venueId. Demo mode rejected. Caller
 * can only seed their own venue — no cross-venue blast radius.
 *
 * Idempotent: re-running the endpoint upserts existing rows
 * (confidence is bumped, never lowered) and adds any new ones that
 * have crossed the threshold since the previous run.
 */

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import { promoteVendorDomain } from '@/lib/services/inbox/vendor-domains'

export const maxDuration = 60

const MIN_OCCURRENCES = 2
// Confidence stamp on backfill rows. We deliberately use 80 not 100:
// the coordinator may still want to review/remove backfilled rows
// (the source='backfill' label surfaces them on the settings UI), and
// a manual confirmation later upgrades to 100.
const BACKFILL_CONFIDENCE = 80
// Hard ceiling on rows scanned to keep the endpoint bounded.
const SCAN_LIMIT = 5000

export async function POST() {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot seed vendor domains')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const venueId = auth.venueId
  const supabase = createServiceClient()

  // Pull every inbound interaction already labelled 'vendor' with a
  // sender email. ORDER doesn't matter for the bucket; capping is
  // enough to keep the scan bounded on a venue with tens of
  // thousands of historical rows.
  const { data: rows, error } = await supabase
    .from('interactions')
    .select('from_email')
    .eq('venue_id', venueId)
    .eq('type', 'email')
    .eq('direction', 'inbound')
    .eq('lifecycle_folder', 'vendor')
    .not('from_email', 'is', null)
    .limit(SCAN_LIMIT)

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }

  // Bucket by domain.
  const counts = new Map<string, number>()
  for (const row of rows ?? []) {
    const fromEmail = (row.from_email as string | null)?.toLowerCase().trim()
    if (!fromEmail) continue
    const at = fromEmail.lastIndexOf('@')
    if (at <= 0) continue
    const domain = fromEmail.slice(at + 1)
    if (!domain || !domain.includes('.')) continue
    counts.set(domain, (counts.get(domain) ?? 0) + 1)
  }

  // Promote everything past the floor. Idempotent — promoteVendorDomain
  // upserts confidence on existing rows.
  const promoted: { domain: string; occurrences: number }[] = []
  let attempted = 0
  for (const [domain, occ] of counts.entries()) {
    if (occ < MIN_OCCURRENCES) continue
    attempted += 1
    try {
      const ok = await promoteVendorDomain({
        venueId,
        domain,
        confidence: BACKFILL_CONFIDENCE,
        source: 'backfill',
      })
      if (ok) {
        promoted.push({ domain, occurrences: occ })
      }
    } catch (err) {
      console.warn('[seed-vendor-domains] promotion failed', {
        domain,
        err: err instanceof Error ? err.message : 'unknown',
      })
    }
  }

  return NextResponse.json({
    ok: true,
    venueId,
    scanned: rows?.length ?? 0,
    distinct_domains: counts.size,
    floor: MIN_OCCURRENCES,
    attempted,
    promoted_count: promoted.length,
    promoted,
  })
}
