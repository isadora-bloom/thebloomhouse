import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { mergePeople, undoMerge } from '@/lib/services/merge-people'

/**
 * POST /api/agent/people/merge
 * Body: { keepPersonId, mergePersonId, matchQueueId?, signals?, tier, confidence? }
 *
 * Actually consolidates two people. The /intel/matching UI's "Merge"
 * button calls this — before Phase 8 the button only flipped queue
 * status. Venue-scoped: both people must belong to the caller's venue.
 */
export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: {
    keepPersonId?: string
    mergePersonId?: string
    matchQueueId?: string | null
    signals?: Array<{ type: string; detail: string; weight: number }>
    tier?: 'high' | 'medium' | 'low'
    confidence?: number | null
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!body.keepPersonId || !body.mergePersonId) {
    return NextResponse.json({ error: 'keepPersonId and mergePersonId are required' }, { status: 400 })
  }
  if (body.keepPersonId === body.mergePersonId) {
    return NextResponse.json({ error: 'Cannot merge a person into themselves' }, { status: 400 })
  }

  const supabase = createServiceClient()

  // Scope guard: both people must belong to the caller's venue.
  const { data: checks } = await supabase
    .from('people')
    .select('id, venue_id')
    .in('id', [body.keepPersonId, body.mergePersonId])
  if (!checks || checks.length !== 2) {
    return NextResponse.json({ error: 'One or both people not found' }, { status: 404 })
  }
  for (const p of checks) {
    if (p.venue_id !== auth.venueId) {
      return NextResponse.json({ error: 'Forbidden: person is in a different venue' }, { status: 403 })
    }
  }

  try {
    const result = await mergePeople({
      supabase,
      venueId: auth.venueId,
      keepPersonId: body.keepPersonId,
      mergePersonId: body.mergePersonId,
      tier: body.tier ?? 'medium',
      signals: body.signals ?? [],
      confidence: body.confidence ?? null,
      mergedBy: auth.userId,
      matchQueueId: body.matchQueueId ?? null,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Merge failed' }, { status: 500 })
  }
}

/**
 * DELETE /api/agent/people/merge?mergeId=...
 * Undoes a merge — recreates the merged person with a new id (FK
 * cascades already deleted the original). Child reassignments stay on
 * the kept person; coordinator re-links manually if needed.
 */
export async function DELETE(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const mergeId = request.nextUrl.searchParams.get('mergeId')
  if (!mergeId) return NextResponse.json({ error: 'mergeId is required' }, { status: 400 })

  const supabase = createServiceClient()
  const { data: audit } = await supabase
    .from('person_merges')
    .select('venue_id')
    .eq('id', mergeId)
    .single()
  if (!audit || audit.venue_id !== auth.venueId) {
    return NextResponse.json({ error: 'Merge record not found' }, { status: 404 })
  }

  const result = await undoMerge({
    supabase,
    venueId: auth.venueId,
    mergeId,
    undoneBy: auth.userId,
  })
  return NextResponse.json({ ok: true, ...result })
}
