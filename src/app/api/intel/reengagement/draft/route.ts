import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { isReEngagementEnabled } from '@/lib/services/re-engagement'
import { draftReEngagementMessage, type ReEngagementChannel } from '@/lib/services/re-engagement-drafter'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'

/**
 * POST /api/intel/reengagement/draft  body={ candidate_id, channel }
 *   Generate a re-engagement draft for one candidate. Inserts a row
 *   in re_engagement_actions with sent_at NULL — the coordinator
 *   reviews/edits before clicking Send or Discard. Returns the new
 *   action row.
 *
 *   Refuses when the venue hasn't opted in (re_engagement_enabled
 *   false). Refuses when an action already exists for this candidate
 *   (no second-message policy).
 */
export async function POST(req: NextRequest) {
  // GAP-12: API-layer plan_tier enforcement BEFORE any DB reads.
  const plan = await requirePlan(req, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({})) as { candidate_id?: unknown; channel?: unknown }
  const candidateId = typeof body.candidate_id === 'string' ? body.candidate_id : null
  const channel: ReEngagementChannel | null =
    body.channel === 'email' || body.channel === 'manual_paste'
      ? (body.channel as ReEngagementChannel)
      : null
  if (!candidateId || !channel) {
    return NextResponse.json({ error: 'candidate_id and channel ("email" | "manual_paste") required' }, { status: 400 })
  }

  const sb = createServiceClient()

  // Hard gate: venue must have opted in. Refusing here protects
  // against a UI that sneaks past the off-by-default check.
  const enabled = await isReEngagementEnabled(sb, auth.venueId)
  if (!enabled) {
    return NextResponse.json({ error: 'Re-engagement is not enabled for this venue' }, { status: 403 })
  }

  // No second-message policy: if any row already exists for this
  // candidate (even discarded), refuse.
  const { data: existing } = await sb
    .from('re_engagement_actions')
    .select('id')
    .eq('candidate_identity_id', candidateId)
    .limit(1)
  if ((existing ?? []).length > 0) {
    return NextResponse.json({ error: 'Candidate already has a re-engagement action' }, { status: 409 })
  }

  // Ownership check: the candidate must belong to this venue.
  const { data: cand } = await sb
    .from('candidate_identities')
    .select('venue_id')
    .eq('id', candidateId)
    .maybeSingle()
  if (!cand || (cand as { venue_id: string }).venue_id !== auth.venueId) {
    return NextResponse.json({ error: 'Candidate not found in this venue' }, { status: 404 })
  }

  let drafted: Awaited<ReturnType<typeof draftReEngagementMessage>>
  try {
    drafted = await draftReEngagementMessage(sb, { candidate_id: candidateId, channel })
  } catch (err) {
    console.error('[reengagement/draft] AI failed:', err)
    return NextResponse.json({ error: 'Drafter failed' }, { status: 500 })
  }
  if (!drafted) return NextResponse.json({ error: 'Empty draft from AI' }, { status: 500 })

  const { data: inserted, error } = await sb
    .from('re_engagement_actions')
    .insert({
      venue_id: auth.venueId,
      candidate_identity_id: candidateId,
      platform: drafted.platform,
      draft_text: drafted.draft_text,
      drafted_by_model: drafted.model,
    })
    .select('id, platform, draft_text, drafted_at')
    .single()
  if (error) {
    console.error('[reengagement/draft] insert failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ action: inserted, intended_channel: channel })
}
