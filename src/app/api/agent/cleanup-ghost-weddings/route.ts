import { NextResponse } from 'next/server'
import { refuseDemo, getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import {
  cleanupGhostWeddings,
  GhostCleanupError,
} from '@/lib/services/identity/ghost-wedding-cleanup'

// ---------------------------------------------------------------------------
// POST /api/agent/cleanup-ghost-weddings
//
// 2026-05-13 — refactored per Step 9 of bloom-identity-resolution-doctrine.
// W66 — the rule moved to src/lib/services/identity/ghost-wedding-cleanup.ts
// so it can be tested against a fake client. A test that cannot observe
// the writes cannot tell a tombstone from a delete, and that distinction
// is the whole point of this endpoint.
//
// History
// -------
// This endpoint used to DELETE two flavours of "ghost" wedding:
//   (A) inquiry-stage with no linked people and no linked interactions
//   (B) inquiry-stage where partner1 email matches the venue's own Gmail
//       (the "Sage at Rixey Manor" self-bug — outbound coordinator email
//       misclassified as inbound inquiry, promoted to a pipeline card
//       with the venue itself as the couple)
//
// Per the constitution and the [[bloom-repair-endpoint-classification]]
// audit, hard DELETE on weddings is a forensic-trail violation. Rule A
// was retired (an empty inquiry is signal, not garbage) and Rule B
// became a soft-tombstone on `weddings.non_couple_at` (migration 332).
//
// Going forward, this endpoint is the manual peer of
// `tombstoneNonCouples` in the daily prune_maintenance cron — same
// soft-tombstone, narrower rule (self-bug only, not the intent-class
// rollup), faster to fire when an operator notices a fresh self-bug
// during onboarding.
//
// Idempotent. Re-running on a venue with no untombstoned self-bugs is a
// no-op.
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // The demo identity is an anonymous visitor. It may look; it may not write.
  const demoRefusal = refuseDemo(auth)
  if (demoRefusal) return demoRefusal

  const venueId = auth.venueId
  if (!venueId) {
    return NextResponse.json({ error: 'No venue in scope' }, { status: 400 })
  }

  // Optional: ?selfDomains=rixeymanor.com,other.com — fallback when the
  // venue hasn't linked a Gmail connection yet (so gmail_connections is
  // empty and the rule would otherwise catch nothing).
  const url = new URL(req.url)
  const paramDomains = (url.searchParams.get('selfDomains') ?? '')
    .split(',')
    .map((s) => s.toLowerCase().trim())
    .filter(Boolean)

  try {
    const result = await cleanupGhostWeddings(
      createServiceClient(),
      venueId,
      paramDomains,
    )
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof GhostCleanupError) {
      return NextResponse.json({ error: err.message }, { status: 500 })
    }
    throw err
  }
}
