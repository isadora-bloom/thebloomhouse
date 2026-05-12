/**
 * POST /api/admin/interactions/[interactionId]/author-class
 *
 * Pattern 10 - operator override for interactions.author_class. Companion to
 * migration 312 (override audit columns) + migration 293 (the classifier that
 * auto-derives author_class). The AI classifier must skip re-classification
 * when author_class_overridden_at IS NOT NULL.
 *
 * Body:
 *   {
 *     "author_class": "couple" | "operator" | "sage" | "platform_system"
 *                     | "vendor" | "unknown",
 *     "note": string?
 *   }
 *
 * Auth: getPlatformAuth - operator-only.
 *
 * Note: the spec listed four values (couple/operator/sage/vendor), but the
 * interactions_author_class_check constraint (migration 293) is the source of
 * truth and admits six values including platform_system and unknown. We honor
 * the constraint so e.g. an operator can mark a Calendly notification as
 * platform_system after a misclassification.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

type AuthorClass =
  | 'couple'
  | 'operator'
  | 'sage'
  | 'platform_system'
  | 'vendor'
  | 'unknown'

const AUTHOR_CLASSES: ReadonlyArray<AuthorClass> = [
  'couple',
  'operator',
  'sage',
  'platform_system',
  'vendor',
  'unknown',
]

interface Body {
  author_class?: string
  note?: string
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ interactionId: string }> },
): Promise<NextResponse> {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { interactionId } = await params

  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const authorClass = body.author_class
  if (!authorClass || !AUTHOR_CLASSES.includes(authorClass as AuthorClass)) {
    return NextResponse.json(
      { error: 'invalid_author_class', valid: AUTHOR_CLASSES },
      { status: 400 },
    )
  }

  const supabase = createServiceClient()

  const { data: interaction } = await supabase
    .from('interactions')
    .select('id, venue_id, wedding_id')
    .eq('id', interactionId)
    .maybeSingle()
  if (!interaction) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  const venueId = (interaction as { venue_id: string }).venue_id
  if (!auth.isDemo && venueId !== auth.venueId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const now = new Date().toISOString()
  const patch = {
    author_class: authorClass,
    author_class_overridden_by: auth.userId,
    author_class_overridden_at: now,
  }

  const { error: updErr } = await supabase
    .from('interactions')
    .update(patch)
    .eq('id', interactionId)
  if (updErr) {
    return NextResponse.json(
      { error: 'update_failed', detail: updErr.message },
      { status: 500 },
    )
  }

  // Audit row. We use the wedding-scoped lifecycle log even for interaction
  // overrides, because the override is downstream-relevant to the wedding's
  // signal interpretation (a "couple"->"platform_system" reclass changes
  // touchpoint counts, heat scoring, attribution). If wedding_id is null on
  // an unrouted interaction, skip the audit; the patch itself still landed.
  const weddingId = (interaction as { wedding_id: string | null }).wedding_id
  if (weddingId) {
    await supabase.from('wedding_lifecycle_events').insert({
      wedding_id: weddingId,
      venue_id: venueId,
      signal: `override:author_class=${authorClass}`,
      detected_by: 'coordinator',
      reason: body.note?.slice(0, 500) ?? null,
    })
  }

  return NextResponse.json({ ok: true, interactionId, applied: patch })
}
