/**
 * Tracer rebind — backfill touchpoints for mirror-backfilled couples.
 *
 * Anchor: D9 honesty card (2026-05-19 ship). The cohort funnel surfaced
 * that most legacy mirror-backfilled couples have a `source_wedding_id`
 * link but ZERO touchpoints attached. The mirror-couple writer creates
 * the spine row at wedding-mint time but does NOT walk historical
 * interactions; the Tracer is supposed to, but on cold-start at
 * mirror-time the wedding has no fresh-arrival signal so the Tracer
 * skips it.
 *
 * This service is the one-shot backfill: find every couple with a
 * source_wedding_id and zero touchpoints, walk that wedding's
 * interactions, and insert touchpoint rows attached to the couple.
 *
 * Doctrine notes:
 *  - Idempotent: a couple that already has any touchpoints is skipped,
 *    so repeated runs are safe. Per-interaction idempotency uses the
 *    existing UNIQUE (venue_id, channel, external_id) constraint where
 *    external_id = interaction.id.
 *  - Direction-preserving: outbound interactions become action_type
 *    'venue_sent'; inbound become 'reply'. This matches the live Gmail
 *    source adapter's contract so cohort / attribution / honesty rails
 *    read uniformly.
 *  - Read-only on weddings + interactions; only writes to touchpoints.
 *  - Multi-venue safe. Caller passes a venueId; no cross-venue work.
 *
 * Failure mode honesty: when an interaction already has the same
 * (venue_id, channel='gmail', external_id=interaction.id) row, the
 * insert is a silent no-op per the unique constraint. Counts returned
 * count newly-inserted rows only.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface TracerRebindResult {
  couplesScanned: number
  couplesUpdated: number
  touchpointsInserted: number
  errors: string[]
  latencyMs: number
}

interface CoupleRow {
  id: string
  source_wedding_id: string | null
}

interface InteractionRow {
  id: string
  wedding_id: string | null
  direction: string | null
  timestamp: string
  from_email: string | null
  subject: string | null
  body_preview: string | null
  author_class: string | null
}

interface ExistingTouchpointRow {
  couple_id: string | null
}

/**
 * Build the touchpoint row shape from an interaction. Returns null when
 * the interaction is not eligible (e.g., no timestamp).
 */
function interactionToTouchpoint(
  venueId: string,
  coupleId: string,
  interaction: InteractionRow,
): Record<string, unknown> | null {
  if (!interaction.timestamp) return null
  // Direction → action_type. Outbound is the venue replying; inbound is
  // the couple sending. Spine doctrine §C.4.
  const dir = (interaction.direction ?? '').toLowerCase()
  const actionType =
    dir === 'outbound' || dir === 'sent'
      ? 'venue_sent'
      : 'reply'
  return {
    venue_id: venueId,
    couple_id: coupleId,
    channel: 'gmail',
    action_type: actionType,
    occurred_at: interaction.timestamp,
    // Gmail is high-tier per doctrine (full identity carried).
    signal_tier: 'high',
    // External id ties this row back to its interaction so reruns
    // de-duplicate via UNIQUE (venue_id, channel, external_id).
    external_id: interaction.id,
    raw_payload: {
      direction: actionType === 'venue_sent' ? 'outbound' : 'inbound',
      subject: interaction.subject ?? null,
      body_preview: interaction.body_preview ?? null,
      from_email: interaction.from_email ?? null,
      backfilled_from_interaction: true,
    },
  }
}

/**
 * Run the rebind for a single venue. Iterates mirror-backfilled couples
 * (couples.source_wedding_id IS NOT NULL) whose touchpoint count is
 * zero, and walks each one's source wedding's interactions to create
 * touchpoints.
 *
 * `coupleLimit` caps the number of couples processed in a single run
 * so a large venue can rebind in batches.
 */
export async function rebindMirrorBackfilledCouples(
  supabase: SupabaseClient,
  venueId: string,
  options: { coupleLimit?: number } = {},
): Promise<TracerRebindResult> {
  const start = Date.now()
  const limit = options.coupleLimit ?? 200
  const errors: string[] = []

  // ---- Step 1: load every mirror-backfilled couple. -----------------------
  const { data: couples, error: couplesErr } = await supabase
    .from('couples')
    .select('id, source_wedding_id')
    .eq('venue_id', venueId)
    .not('source_wedding_id', 'is', null)
    .order('created_at', { ascending: true })
    .limit(limit * 4) // over-fetch; we'll filter by touchpoint presence below

  if (couplesErr) {
    errors.push(`couples query: ${couplesErr.message}`)
    return {
      couplesScanned: 0,
      couplesUpdated: 0,
      touchpointsInserted: 0,
      errors,
      latencyMs: Date.now() - start,
    }
  }
  const allCouples = (couples ?? []) as CoupleRow[]

  // ---- Step 2: find which couples already have touchpoints ----------------
  // One query per batch to keep this cheap. PostgREST cap is 1000 ids
  // per IN — fine at venue scale.
  const coupleIds = allCouples.map((c) => c.id)
  const { data: existing } = await supabase
    .from('touchpoints')
    .select('couple_id')
    .eq('venue_id', venueId)
    .in('couple_id', coupleIds)
  const haveTouchpoints = new Set<string>()
  for (const row of (existing ?? []) as ExistingTouchpointRow[]) {
    if (row.couple_id) haveTouchpoints.add(row.couple_id)
  }

  // The actual work set: mirror-backfilled couples with ZERO
  // touchpoints. Cap to `limit` so a single run stays bounded.
  const targets = allCouples
    .filter((c) => !haveTouchpoints.has(c.id))
    .slice(0, limit)

  if (targets.length === 0) {
    return {
      couplesScanned: allCouples.length,
      couplesUpdated: 0,
      touchpointsInserted: 0,
      errors,
      latencyMs: Date.now() - start,
    }
  }

  // ---- Step 3: load interactions for the target wedding ids ---------------
  // One bulk query so we keep network round trips low. A venue with
  // ~2K interactions per ~200 couples fits comfortably in one IN().
  const sourceWeddingIds = Array.from(
    new Set(
      targets
        .map((c) => c.source_wedding_id)
        .filter((v): v is string => Boolean(v)),
    ),
  )

  const { data: interactions, error: ixErr } = await supabase
    .from('interactions')
    .select(
      'id, wedding_id, direction, timestamp, from_email, subject, body_preview, author_class',
    )
    .eq('venue_id', venueId)
    .in('wedding_id', sourceWeddingIds)
  if (ixErr) {
    errors.push(`interactions query: ${ixErr.message}`)
  }

  // Index by wedding_id for fast lookup.
  const ixByWedding = new Map<string, InteractionRow[]>()
  for (const ix of (interactions ?? []) as InteractionRow[]) {
    if (!ix.wedding_id) continue
    const list = ixByWedding.get(ix.wedding_id)
    if (list) list.push(ix)
    else ixByWedding.set(ix.wedding_id, [ix])
  }

  // ---- Step 4: for each target couple, build + insert touchpoints ---------
  let couplesUpdated = 0
  let touchpointsInserted = 0
  for (const couple of targets) {
    if (!couple.source_wedding_id) continue
    const ixList = ixByWedding.get(couple.source_wedding_id) ?? []
    if (ixList.length === 0) continue

    const rows = ixList
      .map((ix) => interactionToTouchpoint(venueId, couple.id, ix))
      .filter((r): r is Record<string, unknown> => Boolean(r))

    if (rows.length === 0) continue

    // Upsert against the UNIQUE (venue_id, channel, external_id) so
    // reruns are idempotent. ignoreDuplicates=true means we don't
    // surface conflict rows as errors.
    const { error: upsertErr, count } = await supabase
      .from('touchpoints')
      .upsert(rows, {
        onConflict: 'venue_id,channel,external_id',
        ignoreDuplicates: true,
        count: 'exact',
      })
    if (upsertErr) {
      errors.push(`couple ${couple.id}: ${upsertErr.message}`)
      continue
    }

    const inserted = count ?? 0
    if (inserted > 0) {
      couplesUpdated += 1
      touchpointsInserted += inserted
    }
  }

  return {
    couplesScanned: allCouples.length,
    couplesUpdated,
    touchpointsInserted,
    errors,
    latencyMs: Date.now() - start,
  }
}
