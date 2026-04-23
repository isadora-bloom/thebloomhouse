import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { mergePeople } from '@/lib/services/merge-people'

/**
 * POST /api/agent/match-queue/:id/resolve
 * Body: { action: 'merge' | 'dismiss' | 'snooze' | 'unsnooze' | 'wait_for_signal', keepPersonId? }
 *
 * Resolves a client_match_queue row. For 'merge', actually consolidates
 * the two people (keepPersonId is optional — defaults to person_a_id,
 * the older of the pair). For 'dismiss' and 'snooze' just flips status.
 * 'wait_for_signal' is equivalent to 'snooze' but records the intent so
 * later signal can auto-promote.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  if (!id) return NextResponse.json({ error: 'Missing queue id' }, { status: 400 })

  let body: { action?: string; keepPersonId?: string }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const action = body.action
  if (!['merge', 'dismiss', 'snooze', 'unsnooze', 'wait_for_signal'].includes(action ?? '')) {
    return NextResponse.json({ error: 'invalid action' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { data: row } = await supabase
    .from('client_match_queue')
    .select('id, venue_id, person_a_id, person_b_id, signals, tier, confidence')
    .eq('id', id)
    .single()
  if (!row || row.venue_id !== auth.venueId) {
    return NextResponse.json({ error: 'Queue row not found' }, { status: 404 })
  }

  if (action === 'merge') {
    const keep = body.keepPersonId || (row.person_a_id as string)
    const merge = keep === row.person_a_id ? (row.person_b_id as string) : (row.person_a_id as string)
    try {
      const result = await mergePeople({
        supabase,
        venueId: auth.venueId,
        keepPersonId: keep,
        mergePersonId: merge,
        tier: (row.tier as 'high' | 'medium' | 'low') ?? 'medium',
        signals: (row.signals as Array<{ type: string; detail: string; weight: number }>) ?? [],
        confidence: (row.confidence as number | null) ?? null,
        mergedBy: auth.userId,
        matchQueueId: id,
      })
      return NextResponse.json({ ok: true, action: 'merged', ...result })
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Merge failed' }, { status: 500 })
    }
  }

  const statusMap = {
    dismiss: 'dismissed',
    snooze: 'snoozed',
    unsnooze: 'pending',
    wait_for_signal: 'snoozed',
  } as const
  const next = statusMap[action as keyof typeof statusMap]
  await supabase.from('client_match_queue').update({
    status: next,
    resolved_by: auth.userId,
    resolved_at: action === 'unsnooze' ? null : new Date().toISOString(),
  }).eq('id', id)
  return NextResponse.json({ ok: true, action, status: next })
}
