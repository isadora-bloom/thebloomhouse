/**
 * Wave 14 — referral list endpoint.
 *
 * GET /api/admin/intel/referrals/list?venueId=X
 *
 * Returns attribution_events that carry Wave-14 referral metadata
 * (referrer_name_text NOT NULL OR referrer_wedding_id NOT NULL),
 * ordered most-recent-first.
 *
 * Auth:
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId param required.
 *   - else getPlatformAuth (coordinator UI). venueId from auth.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, badRequest } from '@/lib/api/auth-helpers'

export const maxDuration = 60

interface ReferralRow {
  id: string
  venue_id: string
  wedding_id: string
  referrer_wedding_id: string | null
  referrer_name_text: string | null
  referrer_relationship_text: string | null
  referrer_evidence_quote: string | null
  referrer_confidence_0_100: number | null
  referral_resolved_at: string | null
  confidence: number
  tier: string
  decided_by: string
  reasoning: string | null
  decided_at: string
  reverted_at: string | null
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const venueIdParam = url.searchParams.get('venueId')

  const cronAuth = req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  let venueId: string | null = null
  if (cronAuth) {
    if (!venueIdParam) return badRequest('CRON_SECRET path requires venueId param')
    venueId = venueIdParam
  } else {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    if (!auth.venueId) return badRequest('caller has no resolved venue')
    venueId = auth.venueId
  }

  const limitRaw = url.searchParams.get('limit')
  const limit = limitRaw ? Math.max(1, Math.min(500, Number(limitRaw))) : 100

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('attribution_events')
    .select(
      'id, venue_id, wedding_id, referrer_wedding_id, referrer_name_text, referrer_relationship_text, referrer_evidence_quote, referrer_confidence_0_100, referral_resolved_at, confidence, tier, decided_by, reasoning, decided_at, reverted_at',
    )
    .eq('venue_id', venueId)
    .not('referrer_name_text', 'is', null)
    .is('reverted_at', null)
    .order('decided_at', { ascending: false })
    .limit(limit)

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }

  const rows = (data ?? []) as ReferralRow[]
  const matched = rows.filter((r) => r.referrer_wedding_id !== null).length
  const ambiguous = rows.filter(
    (r) => r.referrer_wedding_id === null && r.referral_resolved_at === null && r.tier === 'tier_2_ai',
  ).length

  return NextResponse.json({
    ok: true,
    venueId,
    count: rows.length,
    matched_count: matched,
    ambiguous_count: ambiguous,
    rows,
  })
}
