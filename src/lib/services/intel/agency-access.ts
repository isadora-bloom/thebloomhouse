/**
 * One place that answers "may this caller touch this agency?".
 *
 * S5 (2026-09-14 security audit, item 5).
 *
 * Every route under /api/intel/agencies/[id]/** took the agency id
 * straight out of the URL and went to the database with the service-role
 * client, which bypasses RLS by design. The [id] segment is caller
 * controlled, so any authenticated coordinator could read another venue's
 * agency: its contracts, its retainer, its KPI commitments, and — via the
 * documents routes — the bytes of the signed agreement. The download route
 * even wrote an audit row confirming the caller had taken it.
 *
 * The visibility rule here is the same one listAgenciesForVenue already
 * used, stated once instead of re-derived per route:
 *
 *   - the agency is owned by the caller's venue (marketing_agencies.venue_id), OR
 *   - the agency is owned by the caller's org (marketing_agencies.org_id), OR
 *   - the caller's venue has an engagement with the agency.
 *
 * super_admin is the one bypass, and only super_admin. org_admin already
 * gets everything under their org through the org_id branch; giving them a
 * blanket pass would hand them every other org's agencies too.
 *
 * Soft-deleted agencies are refused. A deleted agency is not a reachable
 * object, and letting a caller distinguish "deleted" from "not yours" is
 * an enumeration oracle for nothing in return.
 */

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'

/** The shape getPlatformAuth returns, narrowed to what this check needs. */
export interface AgencyScopeAuth {
  venueId: string
  orgId?: string | null
  role?: string
}

export type AgencyScopeResult =
  | { ok: true; agencyId: string }
  | { ok: false; status: 400 | 403 | 404; reason: string }

/**
 * Canonical v4/v5 UUID-ish check. Deliberately strict: the agency id is
 * interpolated into a Supabase Storage path (`${agencyId}/${docId}-...`)
 * in the upload route, so anything with a slash or a `..` in it is a path
 * traversal waiting to happen. Validate the shape before it can reach the
 * path, not after.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

/**
 * Resolve whether `agencyId` is visible from the caller's venue.
 *
 * Returns a discriminated result rather than throwing so routes can map it
 * to their own response helpers. 404 is used for "exists but not yours" as
 * well as "does not exist" — a 403 there would confirm the id is real.
 */
export async function checkAgencyScope(
  agencyId: string,
  auth: AgencyScopeAuth,
): Promise<AgencyScopeResult> {
  if (!isUuid(agencyId)) {
    return { ok: false, status: 400, reason: 'agency id must be a uuid' }
  }
  if (!auth.venueId) {
    return { ok: false, status: 403, reason: 'caller has no resolved venue' }
  }

  const service = createServiceClient()

  const { data: agency } = await service
    .from('marketing_agencies')
    .select('id, venue_id, org_id, deleted_at')
    .eq('id', agencyId)
    .maybeSingle()

  if (!agency || agency.deleted_at) {
    return { ok: false, status: 404, reason: 'Agency not found' }
  }

  if (auth.role === 'super_admin') return { ok: true, agencyId }

  if ((agency.venue_id as string | null) === auth.venueId) {
    return { ok: true, agencyId }
  }

  const agencyOrgId = agency.org_id as string | null
  if (agencyOrgId) {
    // Prefer the org on the session; fall back to the venue row so a
    // coordinator whose profile predates org_id still resolves.
    let callerOrgId = auth.orgId ?? null
    if (!callerOrgId) {
      const { data: venueRow } = await service
        .from('venues')
        .select('org_id')
        .eq('id', auth.venueId)
        .maybeSingle()
      callerOrgId = (venueRow?.org_id as string | null) ?? null
    }
    if (callerOrgId && callerOrgId === agencyOrgId) {
      return { ok: true, agencyId }
    }
  }

  const { data: engagement } = await service
    .from('venue_agency_engagements')
    .select('id')
    .eq('venue_id', auth.venueId)
    .eq('agency_id', agencyId)
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle()

  if (engagement) return { ok: true, agencyId }

  return { ok: false, status: 404, reason: 'Agency not found' }
}

/**
 * Route-shaped wrapper. Returns a response to send when the caller may not
 * touch the agency, or null when they may.
 *
 * Every handler under /api/intel/agencies/[id]/** calls this immediately
 * after getPlatformAuth, before it reads a single agency-scoped row:
 *
 *   const denied = await requireAgencyScope(id, auth)
 *   if (denied) return denied
 */
export async function requireAgencyScope(
  agencyId: string,
  auth: AgencyScopeAuth,
): Promise<NextResponse | null> {
  const result = await checkAgencyScope(agencyId, auth)
  if (result.ok) return null
  return NextResponse.json({ error: result.reason }, { status: result.status })
}
