import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, assertCanAccessVenue, forbidden } from '@/lib/api/auth-helpers'

/**
 * POST /api/portal/config/copy (Tier-B #69C)
 *
 * Copy all rows from `sourceVenueId`'s configuration table into the
 * calling coordinator's currently-scoped venue. Used by multi-venue
 * orgs to seed a new venue's config from a sister venue at onboarding,
 * skipping the "fill in 12 of the same channels by hand" step.
 *
 * Body: { table: string, sourceVenueId: string }
 *
 * Security:
 *   - getPlatformAuth resolves the caller's venue (target).
 *   - assertCanAccessVenue verifies the caller can ALSO read the source
 *     venue. With pricing v2, multi/enterprise tiers have multiple
 *     venues per org; same-org sister venues pass via mig 058's
 *     org-admin scope. Cross-org attempts return 403.
 *   - Allowed tables are explicitly listed (no SQL injection via
 *     untrusted table names; a malicious caller can't ask us to copy
 *     `auth.users`).
 *
 * Behaviour:
 *   - Reads all rows from the source. Strips id, venue_id, created_at,
 *     updated_at columns and re-inserts under the target venue_id.
 *   - Does NOT clear existing rows in the target. Coordinator can
 *     manually delete first if they want a pure clone; default is
 *     additive so accidental clicks don't blow away in-progress work.
 *   - Returns the count of rows copied.
 */

const ALLOWED_TABLES = new Set<string>([
  'marketing_channels',
  'coordinator_absences',
  // Add more as more config pages get the copy-from button. Each entry
  // here is a venue-scoped table where `venue_id` is the only tenancy
  // column; if a table needs more nuance (per-row FK like booked_vendors,
  // or sub-relationships) it should NOT be on this list — write a
  // bespoke endpoint instead.
])

export async function POST(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!auth.venueId) {
    return NextResponse.json({ error: 'Target venue not resolved' }, { status: 400 })
  }

  const body = (await req.json().catch(() => null)) as
    | { table?: string; sourceVenueId?: string }
    | null
  if (!body?.table || !body?.sourceVenueId) {
    return NextResponse.json({ error: 'table and sourceVenueId required' }, { status: 400 })
  }
  if (!ALLOWED_TABLES.has(body.table)) {
    return NextResponse.json({ error: 'Table not allowed for copy' }, { status: 400 })
  }
  if (body.sourceVenueId === auth.venueId) {
    return NextResponse.json({ error: 'Source and target are the same venue' }, { status: 400 })
  }

  // Verify the caller can read the source venue.
  const access = await assertCanAccessVenue(auth, body.sourceVenueId)
  if (!access.ok) return forbidden(access.reason)

  const supabase = createServiceClient()

  const { data: sourceRows, error: readErr } = await supabase
    .from(body.table)
    .select('*')
    .eq('venue_id', body.sourceVenueId)

  if (readErr) {
    console.error('[portal/config/copy] read failed:', readErr)
    return NextResponse.json({ error: 'Failed to read source rows' }, { status: 500 })
  }
  if (!sourceRows || sourceRows.length === 0) {
    return NextResponse.json({ data: { copied: 0 } })
  }

  // Strip identity + audit columns; rewrite venue_id to the target.
  const STRIP = new Set(['id', 'venue_id', 'created_at', 'updated_at'])
  const rowsToInsert = sourceRows.map((row) => {
    const out: Record<string, unknown> = { venue_id: auth.venueId }
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      if (!STRIP.has(k)) out[k] = v
    }
    return out
  })

  const { error: insertErr, count } = await supabase
    .from(body.table)
    .insert(rowsToInsert, { count: 'exact' })

  if (insertErr) {
    console.error('[portal/config/copy] insert failed:', insertErr)
    // Likely a UNIQUE collision (venue_id, key). Surface the hint so
    // the coordinator can clear existing rows or rename collisions.
    return NextResponse.json(
      { error: insertErr.message ?? 'Insert failed' },
      { status: 409 },
    )
  }

  return NextResponse.json({
    data: { copied: count ?? rowsToInsert.length },
  })
}
