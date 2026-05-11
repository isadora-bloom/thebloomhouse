/**
 * POST /api/admin/sms/rematch
 *
 * Backfill: re-run the SMS name + event-context matcher against every
 * unlinked SMS interaction (person_id IS NULL or wedding_id IS NULL)
 * on the venue, in the last 90 days. Links each match by updating the
 * row's person_id + wedding_id.
 *
 * This is the operator-triggered counterpart to the per-message match
 * the openphone sync now runs. Use after the live sync first ingests
 * messages — or any time the matching prompt is bumped.
 *
 * Body: { venueId?: string, dryRun?: boolean }
 *   - venueId: optional override; defaults to auth.venueId
 *   - dryRun: when true, returns counts but does NOT update rows
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
} from '@/lib/api/auth-helpers'
import { tryMatchSmsByName } from '@/lib/services/ingestion/sms-name-match'

const LOOKBACK_DAYS = 90

interface PostBody {
  venueId?: string
  dryRun?: boolean
}

export async function POST(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot run SMS rematch')

  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }

  const venueId = body.venueId ?? auth.venueId
  if (!venueId) {
    return NextResponse.json({ error: 'venueId required' }, { status: 400 })
  }
  if (venueId !== auth.venueId && auth.role !== 'super_admin') {
    return forbidden('cross-venue rematch requires super_admin')
  }

  const supabase = createServiceClient()
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString()

  const { data: rows, error } = await supabase
    .from('interactions')
    .select('id, full_body, body_preview, from_email, wedding_id, person_id')
    .eq('venue_id', venueId)
    .eq('type', 'sms')
    .eq('direction', 'inbound')
    .or('person_id.is.null,wedding_id.is.null')
    .gte('timestamp', since)
    .limit(500)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const list = (rows ?? []) as Array<{
    id: string
    full_body: string | null
    body_preview: string | null
    from_email: string | null
    wedding_id: string | null
    person_id: string | null
  }>

  const dryRun = !!body.dryRun
  let scanned = 0
  let matched = 0
  let updated = 0
  const samples: Array<{ id: string; matchedName: string; confidence: number }> = []

  for (const row of list) {
    scanned++
    const text = (row.full_body ?? row.body_preview ?? '').trim()
    if (!text) continue

    const match = await tryMatchSmsByName({
      supabase,
      venueId,
      body: text,
      fromPhone: row.from_email,
    })
    if (!match) continue

    matched++
    if (samples.length < 10) {
      samples.push({
        id: row.id,
        matchedName: match.matchedName,
        confidence: match.confidence,
      })
    }

    if (dryRun) continue

    const { error: updErr } = await supabase
      .from('interactions')
      .update({
        person_id: match.personId,
        wedding_id: match.weddingId,
      })
      .eq('id', row.id)
    if (!updErr) updated++
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    scanned,
    matched,
    updated,
    samples,
  })
}
