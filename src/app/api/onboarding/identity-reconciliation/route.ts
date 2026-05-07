/**
 * Identity reconciliation API (Stream KK / migration 177).
 *
 * GET /api/onboarding/identity-reconciliation
 *   ?dry_run=1 — preview run, no writes. Default true.
 *   Returns ReconciliationResult (clusters with their proposed merges).
 *
 * POST /api/onboarding/identity-reconciliation
 *   action: 'run' — execute auto-merge pass + return result. Tier-2
 *     surfaced clusters are returned but NOT merged.
 *   action: 'merge' — coordinator-confirmed merge for one cluster.
 *     body: { winnerId, loserIds, reason? }
 *   action: 'defer' — coordinator deferred a cluster to "later".
 *     Persists nothing — re-running reconcile will surface it again.
 *     Endpoint exists for symmetry / UI bookkeeping.
 *
 * Auth: getPlatformAuth — coordinator-only.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import {
  reconcileVenue,
  applyClusterMerge,
} from '@/lib/services/identity/reconciliation'

export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const dryRun = (new URL(request.url).searchParams.get('dry_run') ?? '1') !== '0'
  const supabase = createServiceClient()
  const result = await reconcileVenue(supabase, auth.venueId, { dryRun })
  return NextResponse.json(result)
}

interface PostBody {
  action: 'run' | 'merge' | 'defer'
  winnerId?: string
  loserIds?: string[]
  reason?: string
}

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: PostBody
  try {
    body = (await request.json()) as PostBody
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const supabase = createServiceClient()

  if (body.action === 'run') {
    const result = await reconcileVenue(supabase, auth.venueId, { dryRun: false })
    return NextResponse.json(result)
  }

  if (body.action === 'merge') {
    if (!body.winnerId || !Array.isArray(body.loserIds) || body.loserIds.length === 0) {
      return NextResponse.json({ error: 'missing winnerId or loserIds' }, { status: 400 })
    }
    const r = await applyClusterMerge(supabase, {
      venueId: auth.venueId,
      winnerId: body.winnerId,
      loserIds: body.loserIds,
      coordinatorUserId: auth.userId ?? null,
      reason: body.reason ?? null,
    })
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
    return NextResponse.json({ ok: true, backfilled: r.backfilled })
  }

  if (body.action === 'defer') {
    // No-op on the server — the cluster will resurface on the next
    // reconcile dry-run. The UI tracks the defer in coordinator state
    // (or just doesn't re-render the card until the page reloads).
    return NextResponse.json({ ok: true, deferred: true })
  }

  return NextResponse.json({ error: `unknown action: ${body.action}` }, { status: 400 })
}
