/**
 * POST /api/onboarding/voice-dna-extract
 *
 * Day-4 of the 5-day onboarding project: extract voice anchors from the
 * coordinator's actual Gmail backfill (T5-θ.3).
 *
 * Body (all optional):
 *   {
 *     venueId?: string         — defaults to caller's scoped venue.
 *                                Cross-venue access requires org-admin.
 *     overwrite?: boolean      — when true, deletes prior 'imported_high'
 *                                voice rows before re-extracting.
 *     sampleLimit?: number     — override the default sample size (100).
 *   }
 *
 * Status codes:
 *   200  — extraction succeeded; body has counts.
 *   401  — unauthorized.
 *   403  — cross-venue access denied.
 *   404  — venue not found.
 *   409  — already imported; coordinator must pass overwrite=true.
 *   422  — Gmail not connected, or insufficient samples.
 *   429  — venue is at 100% of the daily cost ceiling. Body includes
 *          resume_at (next UTC midnight ISO).
 *   500  — extraction itself failed (LLM unavailable).
 *
 * Cost discipline: gateForBrainCall runs inside the service before any
 * LLM call. The 429 path is the user-facing surface of that gate.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import {
  extractVoiceDnaFromBackfill,
  hasPriorImport,
  DEFAULT_SAMPLE_LIMIT,
} from '@/lib/services/brain/voice-dna-extract'
import { newCorrelationId } from '@/lib/observability/logger'

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: { venueId?: string; overwrite?: boolean; sampleLimit?: number } = {}
  try {
    body = await request.json().catch(() => ({}))
  } catch {
    body = {}
  }

  const supabase = createServiceClient()

  // Resolve target venue. Defaults to caller's scoped venue; cross-venue
  // access requires org-admin or super_admin and same-org membership.
  let targetVenueId = auth.venueId
  if (body.venueId && body.venueId !== auth.venueId) {
    if (!/^[0-9a-f-]{36}$/i.test(body.venueId)) {
      return NextResponse.json({ error: 'invalid_venue_id' }, { status: 400 })
    }
    if (auth.role !== 'org_admin' && auth.role !== 'super_admin') {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    const { data: venue } = await supabase
      .from('venues')
      .select('id, org_id')
      .eq('id', body.venueId)
      .maybeSingle()
    if (!venue) return NextResponse.json({ error: 'venue_not_found' }, { status: 404 })
    if (auth.orgId && (venue.org_id as string | null) !== auth.orgId) {
      return NextResponse.json({ error: 'forbidden_other_org' }, { status: 403 })
    }
    targetVenueId = body.venueId
  }

  const sampleLimit =
    typeof body.sampleLimit === 'number' && body.sampleLimit > 0 && body.sampleLimit <= 500
      ? Math.floor(body.sampleLimit)
      : DEFAULT_SAMPLE_LIMIT

  // Mint correlation_id at the route entry so the entire LLM-extract +
  // DB-write lineage threads under one id (per Stream M correlation_id
  // extension / OPS-21.2.1).
  const correlationId = newCorrelationId()

  const result = await extractVoiceDnaFromBackfill(supabase, targetVenueId, {
    overwrite: body.overwrite === true,
    sampleLimit,
    correlationId,
    actor: auth.userId ? `user:${auth.userId}` : 'system',
  })

  if (!result.ok) {
    switch (result.reason) {
      case 'gmail_not_connected':
        return NextResponse.json(
          {
            error: 'gmail_not_connected',
            message: 'Connect a Gmail account first (Day 1 step). Voice DNA extraction reads the venue\'s past outbound writing.',
            correlation_id: result.correlationId,
          },
          { status: 422 },
        )
      case 'insufficient_samples':
        return NextResponse.json(
          {
            error: 'insufficient_samples',
            message: `Only ${result.sampledCount ?? 0} coordinator-written outbound emails found. Run the 12-month backfill first (Day 1 step) to seed the corpus.`,
            sampled_count: result.sampledCount ?? 0,
            correlation_id: result.correlationId,
          },
          { status: 422 },
        )
      case 'already_imported':
        return NextResponse.json(
          {
            error: 'already_imported',
            message: 'Voice DNA has already been extracted for this venue. Pass overwrite=true to re-run; this will OVERWRITE the previous extraction.',
            already_imported: true,
            correlation_id: result.correlationId,
          },
          { status: 409 },
        )
      case 'gated':
        return NextResponse.json(
          {
            error: 'cost_ceiling_paused',
            message: 'Autonomous behaviour is paused for this venue (daily cost ceiling reached). Resume manually or wait for the next UTC day.',
            resume_at: result.resumeAt,
            correlation_id: result.correlationId,
          },
          { status: 429 },
        )
      case 'extraction_failed':
        return NextResponse.json(
          {
            error: 'extraction_failed',
            message: 'LLM extraction did not produce any results. Try again, or check provider status.',
            sampled_count: result.sampledCount ?? 0,
            correlation_id: result.correlationId,
          },
          { status: 500 },
        )
    }
  }

  // result.ok = true. Optionally check `hasPriorImport` to surface
  // "this overwrote N prior anchors" hint for the UI banner.
  const had = result.alreadyImported
  return NextResponse.json({
    ok: true,
    sampled_count: result.sampledCount,
    rows_written: result.rowsWritten,
    phrases_extracted: result.phrasesExtracted,
    greeting_patterns: result.greetingPatterns,
    signoff_patterns: result.signoffPatterns,
    overwrote_prior: had,
    correlation_id: result.correlationId,
  })
}

/**
 * GET /api/onboarding/voice-dna-extract?venueId=...
 *
 * Lightweight idempotency probe so the Day-4 UI can render
 * "Re-run extraction?" vs "Run extraction" before the coordinator clicks.
 */
export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const queryVenueId = request.nextUrl.searchParams.get('venueId')
  let targetVenueId = auth.venueId
  const supabase = createServiceClient()

  if (queryVenueId && queryVenueId !== auth.venueId) {
    if (!/^[0-9a-f-]{36}$/i.test(queryVenueId)) {
      return NextResponse.json({ error: 'invalid_venue_id' }, { status: 400 })
    }
    if (auth.role !== 'org_admin' && auth.role !== 'super_admin') {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    const { data: venue } = await supabase
      .from('venues')
      .select('id, org_id')
      .eq('id', queryVenueId)
      .maybeSingle()
    if (!venue) return NextResponse.json({ error: 'venue_not_found' }, { status: 404 })
    if (auth.orgId && (venue.org_id as string | null) !== auth.orgId) {
      return NextResponse.json({ error: 'forbidden_other_org' }, { status: 403 })
    }
    targetVenueId = queryVenueId
  }

  const has = await hasPriorImport(supabase, targetVenueId)

  // Also surface gmail-connectivity + outbound-sample count so the UI
  // can show the right call-to-action ("Connect Gmail" vs "Run backfill"
  // vs "Run extraction").
  const { count: gmailCount } = await supabase
    .from('gmail_connections')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', targetVenueId)
    .eq('status', 'active')
  const { count: outboundCount } = await supabase
    .from('interactions')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', targetVenueId)
    .eq('type', 'email')
    .eq('direction', 'outbound')

  return NextResponse.json({
    venue_id: targetVenueId,
    already_imported: has,
    gmail_connected: (gmailCount ?? 0) > 0,
    outbound_count: outboundCount ?? 0,
  })
}
