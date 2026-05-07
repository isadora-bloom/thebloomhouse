import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * GET /api/agent/auto-send-shadow
 *
 * List recent shadow-mode eligibility decisions for the calling
 * coordinator's venue, with their matching auto_send_rules row.
 * Drives the coordinator review surface at /agent/auto-send-shadow.
 *
 * Query params:
 *   ?ruleId=<uuid>     filter to one rule
 *   ?unreviewed=1      only rows with reviewed_at IS NULL
 *   ?limit=N           default 50, max 200
 *
 * Tier-B #67A.
 */
export async function GET(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!auth.venueId) {
    return NextResponse.json({ error: 'Venue not resolved' }, { status: 400 })
  }

  const ruleId = req.nextUrl.searchParams.get('ruleId')
  const unreviewed = req.nextUrl.searchParams.get('unreviewed') === '1'
  const limitRaw = parseInt(req.nextUrl.searchParams.get('limit') ?? '50', 10)
  const limit = Math.max(1, Math.min(200, isNaN(limitRaw) ? 50 : limitRaw))

  const supabase = createServiceClient()
  let query = supabase
    .from('auto_send_shadow_decisions')
    .select(
      'id, rule_id, draft_id, wedding_id, thread_id, context_type, source, confidence_score, injection_suspected, would_have_sent, reason, reviewed_at, review_verdict, review_note, created_at',
    )
    .eq('venue_id', auth.venueId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (ruleId) query = query.eq('rule_id', ruleId)
  if (unreviewed) query = query.is('reviewed_at', null)

  const { data: decisions, error } = await query
  if (error) {
    console.error('[auto-send-shadow GET]', error)
    return NextResponse.json({ error: 'Failed to load decisions' }, { status: 500 })
  }

  // Sibling fetch: the rules in shadow mode for this venue (so the UI
  // can show "Promote" buttons next to each rule).
  const { data: rules } = await supabase
    .from('auto_send_rules')
    .select('id, context, source, enabled, shadow_mode, shadow_started_at, graduated_at')
    .eq('venue_id', auth.venueId)
    .order('context', { ascending: true })

  return NextResponse.json({
    decisions: decisions ?? [],
    rules: rules ?? [],
  })
}

/**
 * POST /api/agent/auto-send-shadow/verdict
 *
 * Coordinator marks a single shadow decision as correct / wrong_send /
 * wrong_block. Drives the "ready to graduate" heuristic.
 *
 * Body: { id: string, verdict: 'correct'|'wrong_send'|'wrong_block', note?: string }
 *
 * Implemented as POST on the same path; the route disambiguates via
 * an `action` field in the body to keep the API surface flat.
 */
export async function POST(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!auth.venueId || !auth.userId) {
    return NextResponse.json({ error: 'Venue or user not resolved' }, { status: 400 })
  }

  const body = (await req.json().catch(() => null)) as
    | { action: 'verdict'; id: string; verdict: 'correct' | 'wrong_send' | 'wrong_block'; note?: string }
    | { action: 'promote'; ruleId: string }
    | null

  if (!body) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const supabase = createServiceClient()

  if (body.action === 'verdict') {
    if (!body.id || !['correct', 'wrong_send', 'wrong_block'].includes(body.verdict)) {
      return NextResponse.json({ error: 'Invalid verdict' }, { status: 400 })
    }

    // Service-role write but gate on venue_id matching the auth.
    const { data: existing } = await supabase
      .from('auto_send_shadow_decisions')
      .select('venue_id')
      .eq('id', body.id)
      .maybeSingle()
    if (!existing || existing.venue_id !== auth.venueId) {
      return NextResponse.json({ error: 'Decision not found' }, { status: 404 })
    }

    const { error } = await supabase
      .from('auto_send_shadow_decisions')
      .update({
        reviewed_at: new Date().toISOString(),
        reviewed_by: auth.userId,
        review_verdict: body.verdict,
        review_note: body.note?.slice(0, 500) ?? null,
      })
      .eq('id', body.id)
    if (error) {
      console.error('[auto-send-shadow verdict]', error)
      return NextResponse.json({ error: 'Failed to save verdict' }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  }

  if (body.action === 'promote') {
    if (!body.ruleId) {
      return NextResponse.json({ error: 'ruleId required' }, { status: 400 })
    }

    // Verify the rule belongs to the calling venue.
    const { data: rule } = await supabase
      .from('auto_send_rules')
      .select('venue_id, shadow_mode')
      .eq('id', body.ruleId)
      .maybeSingle()
    if (!rule || rule.venue_id !== auth.venueId) {
      return NextResponse.json({ error: 'Rule not found' }, { status: 404 })
    }
    if (!rule.shadow_mode) {
      return NextResponse.json(
        { error: 'Rule is not in shadow mode' },
        { status: 400 },
      )
    }

    const { error } = await supabase
      .from('auto_send_rules')
      .update({
        shadow_mode: false,
        graduated_at: new Date().toISOString(),
        graduated_by: auth.userId,
      })
      .eq('id', body.ruleId)
    if (error) {
      console.error('[auto-send-shadow promote]', error)
      return NextResponse.json({ error: 'Failed to promote rule' }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
