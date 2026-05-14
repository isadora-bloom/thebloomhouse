/**
 * POST /api/agent/match-queue/backfill-high-tier
 *
 * Re-evaluates pending client_match_queue rows against the current
 * resolution rules and auto-merges any pair that now qualifies as
 * high-tier. Catch-up sweep for the 2026-05-14 dedup-rule additions
 * (full_name_plus_email_domain) so already-queued duplicates get
 * resolved without operator click-through.
 *
 * Body: { dry_run?: boolean } — default false (actually merge). Set
 * dry_run=true for a preview count.
 *
 * Auth: getPlatformAuth — operator scope only. The service uses
 * service-role internally for the merge writes.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { backfillHighTierMerges } from '@/lib/services/identity/backfill-high-tier'

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { dry_run?: boolean } = {}
  try {
    body = (await request.json()) as { dry_run?: boolean }
  } catch {
    // Empty body is fine — default to actual run.
  }

  const supabase = createServiceClient()
  try {
    const result = await backfillHighTierMerges(supabase, auth.venueId, {
      dryRun: body.dry_run === true,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Backfill failed' },
      { status: 500 },
    )
  }
}
