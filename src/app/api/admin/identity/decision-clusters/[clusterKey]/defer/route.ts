/**
 * POST /api/admin/identity/decision-clusters/:clusterKey/defer
 *
 * Wave 10 — defer ALL handles in a person cluster.
 *
 * Marks every handle in the cluster as 'deferred' in
 * handle_merge_decisions (so they stay surfaced on subsequent loads)
 * and writes one cluster audit row.
 *
 * Auth: getPlatformAuth + auth.venueId. Demo mode rejected.
 */

import { NextRequest, NextResponse } from 'next/server'
import { decideCluster } from '../decide-helper'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'

export const maxDuration = 60

interface RouteContext {
  params: Promise<{ clusterKey: string }>
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot defer decision clusters')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const params = await ctx.params
  const clusterKey = decodeURIComponent(params.clusterKey ?? '').trim()
  if (!clusterKey) return badRequest('clusterKey path param required')

  const body = (await req.json().catch(() => null)) as { note?: string | null } | null
  const note = body?.note?.toString().trim() || null

  return decideCluster({
    venueId: auth.venueId,
    userId: auth.userId,
    clusterKey,
    decision: 'deferred',
    note,
  })
}
