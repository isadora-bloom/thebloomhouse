import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { applyBacktrace } from '@/lib/services/source-backtrace'
import { CANONICAL_SOURCES, type CanonicalSource } from '@/lib/services/normalize-source'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * Sources a coordinator should NEVER pick as a manual override —
 * scheduling tools are surface-level channels, never the real
 * first-touch. They round-trip through the schema (the storage layer
 * preserves them when applyBacktrace re-writes existing values), but
 * they are not selectable on the inline edit UI.
 */
const NON_OVERRIDE_SOURCES = new Set(['calendly', 'acuity', 'honeybook', 'dubsado'])

/**
 * GET /api/agent/leads/[id]/source
 *
 * Returns the wedding's current source plus the audit trail from the
 * inquiry touchpoint metadata (backtraced_from / backtraced_to /
 * backtraced_at / backtraced_by). Used by the inline source-edit UI
 * to show "originally Calendly · re-attributed by you on date".
 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id: weddingId } = await context.params
  if (!weddingId) {
    return NextResponse.json({ error: 'Missing wedding id' }, { status: 400 })
  }

  const sb = createServiceClient()

  const { data: wedding } = await sb
    .from('weddings')
    .select('id, venue_id, source')
    .eq('id', weddingId)
    .maybeSingle()
  if (!wedding || (wedding as { venue_id: string }).venue_id !== auth.venueId) {
    return NextResponse.json({ error: 'Wedding not found' }, { status: 404 })
  }

  const { data: tp } = await sb
    .from('wedding_touchpoints')
    .select('metadata')
    .eq('venue_id', auth.venueId)
    .eq('wedding_id', weddingId)
    .eq('touch_type', 'inquiry')
    .maybeSingle()
  const meta = (tp?.metadata as Record<string, unknown> | null) ?? {}

  return NextResponse.json({
    source: (wedding as { source: string | null }).source,
    audit: {
      backtracedFrom: (meta.backtraced_from as string | null) ?? null,
      backtracedTo: (meta.backtraced_to as string | null) ?? null,
      backtracedAt: (meta.backtraced_at as string | null) ?? null,
      backtracedBy: (meta.backtraced_by as string | null) ?? null,
    },
  })
}

/**
 * POST /api/agent/leads/[id]/source
 *
 * Coordinator-driven source override for one wedding. Re-uses the
 * source-backtrace service's applyBacktrace path so the same audit
 * metadata (backtraced_from, backtraced_to, backtraced_at,
 * backtraced_by) is written regardless of whether the correction
 * came from the bulk re-attribution panel or this inline edit.
 *
 * Body: { newSource: CanonicalSource }
 *   newSource must be one of CANONICAL_SOURCES — we don't normalize
 *   here because the inline UI passes the canonical key directly.
 *   Bogus values are rejected so a typo can't silently corrupt the
 *   funnel.
 *
 * Auth: caller must be authenticated to the venue that owns the
 * wedding. applyBacktrace double-checks the wedding.venue_id, so a
 * stale weddingId from another venue returns 404, not a write.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id: weddingId } = await context.params
  if (!weddingId) {
    return NextResponse.json({ error: 'Missing wedding id' }, { status: 400 })
  }

  let body: { newSource?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const { newSource } = body
  if (!newSource) {
    return NextResponse.json({ error: 'Missing newSource' }, { status: 400 })
  }

  if (!(CANONICAL_SOURCES as readonly string[]).includes(newSource)) {
    return NextResponse.json(
      { error: `Invalid source. Must be one of: ${CANONICAL_SOURCES.join(', ')}` },
      { status: 400 }
    )
  }
  if (NON_OVERRIDE_SOURCES.has(newSource)) {
    return NextResponse.json(
      {
        error:
          `Scheduling tools (${[...NON_OVERRIDE_SOURCES].join(', ')}) cannot be set as the first-touch source manually. ` +
          `They surface as the source only when no upstream channel is detected; once you re-attribute a wedding, you should pick the real upstream channel.`,
      },
      { status: 400 }
    )
  }

  try {
    const result = await applyBacktrace(
      auth.venueId,
      weddingId,
      newSource as CanonicalSource,
      auth.userId ?? null
    )
    if (!result.ok) {
      return NextResponse.json(
        { error: 'Wedding not found or wrong venue' },
        { status: 404 }
      )
    }
    return NextResponse.json({ ok: true, oldSource: result.oldSource, newSource })
  } catch (err) {
    console.error('[api/agent/leads/[id]/source]', err)
    return NextResponse.json(
      { error: 'Failed to apply source override' },
      { status: 500 }
    )
  }
}
