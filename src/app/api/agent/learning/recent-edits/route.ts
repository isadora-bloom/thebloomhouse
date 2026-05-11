/**
 * Bloom House - Wave 26 recent-edits feed.
 *
 * GET /api/agent/learning/recent-edits?limit=50
 *
 * Returns the last N draft_edit_insights rows for the caller's venue
 * scope so /agent/learning/recent-edits can render the audit-of-
 * learnings view (what Sage learned, where it landed, when).
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10), 200)
  const kindFilter = searchParams.get('kind')

  const supabase = createServiceClient()

  let query = supabase
    .from('draft_edit_insights')
    .select(
      'id, draft_id, venue_id, insight_kind, sage_text, operator_text, learning_summary, persisted_to, persisted_ref, confidence_0_100, operator_acknowledged_at, operator_correction, created_at',
    )
    .order('created_at', { ascending: false })
    .limit(limit)

  if (auth.venueId) {
    query = query.eq('venue_id', auth.venueId)
  }

  if (kindFilter) {
    query = query.eq('insight_kind', kindFilter)
  }

  const { data, error } = await query
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ insights: data ?? [] })
}
