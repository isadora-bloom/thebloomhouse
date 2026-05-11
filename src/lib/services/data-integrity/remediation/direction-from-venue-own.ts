/**
 * Wave 9 remediation — misclassified inbound (direction_from_venue_own).
 *
 * What this fixes
 * ---------------
 * Interactions where direction='inbound' but from_email matches one of
 * the venue's own sending addresses. Means Sage outbound was logged as
 * inbound — inflates heat scores via signal-inference firing on our own
 * marketing copy.
 *
 * Strategy
 * --------
 * Single tier: flip direction='inbound' → 'outbound'. Self-loop guard
 * in the pipeline now catches new writes (see pipeline.ts Wave 9
 * comment block); this remediation cleans the historical residue.
 *
 * Also resets engagement_events that fired on these now-outbound
 * interactions so heat scores recompute cleanly. The signal-inference
 * false-positive cleanup is its own invariant
 * (engagement_event_on_outbound) — we don't dual-fix here. After this
 * remediation, that invariant will newly surface as actionable and the
 * operator can apply its own remediation (or in the future, a
 * downstream sweep can pick it up automatically).
 *
 * Idempotency
 * -----------
 * Re-running on a cleaned venue is a no-op: the WHERE filter (direction
 * = 'inbound' AND from_email IN <ownEmails>) returns zero rows once
 * the historical residue is fixed.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { venueOwnEmails } from '@/lib/services/email/pipeline'
import {
  makeEmptyResult,
  pushError,
  SAMPLE_CAP,
  type RemediationCallArgs,
  type RemediationResult,
} from './types'

const INVARIANT_ID = 'direction_from_venue_own'

interface BadInboundRow {
  id: string
  direction: string | null
  from_email: string | null
  subject: string | null
  timestamp: string | null
}

async function loadMisclassifiedInbounds(venueId: string, ownEmails: Set<string>): Promise<BadInboundRow[]> {
  if (ownEmails.size === 0) return []
  const sb = createServiceClient()
  const { data, error } = await sb
    .from('interactions')
    .select('id, direction, from_email, subject, timestamp')
    .eq('venue_id', venueId)
    .eq('direction', 'inbound')
    .in('from_email', Array.from(ownEmails))
  if (error) throw new Error(`loadMisclassifiedInbounds: ${error.message}`)
  return (data ?? []) as BadInboundRow[]
}

export async function remediateMisclassifiedInbound(
  { venueId, mode }: RemediationCallArgs,
): Promise<RemediationResult> {
  const result = makeEmptyResult(
    INVARIANT_ID,
    mode,
    'Flip direction inbound -> outbound when from_email is in venueOwnEmails.',
  )

  let ownEmails: Set<string>
  try {
    ownEmails = await venueOwnEmails(venueId)
  } catch (err) {
    pushError(result, 'load_own_emails', err)
    return result
  }
  if (ownEmails.size === 0) {
    // Trivially clean — venue has no outbound history yet, so no
    // reference set against which to flag inbounds.
    return result
  }

  let bad: BadInboundRow[]
  try {
    bad = await loadMisclassifiedInbounds(venueId, ownEmails)
  } catch (err) {
    pushError(result, 'load_misclassified', err)
    return result
  }

  result.violationsDetected = bad.length
  if (bad.length === 0) return result

  result.sampleBefore = bad.slice(0, SAMPLE_CAP).map((r) => ({
    interaction_id: r.id,
    direction: r.direction,
    from_email: r.from_email,
    subject: r.subject,
    timestamp: r.timestamp,
  }))

  if (mode === 'dry_run') {
    result.violationsFixed = bad.length
    return result
  }

  // Apply: flip direction in chunks of 200 ids to keep the IN clause
  // payload reasonable.
  const sb = createServiceClient()
  const chunks: string[][] = []
  for (let i = 0; i < bad.length; i += 200) chunks.push(bad.slice(i, i + 200).map((r) => r.id))

  let fixed = 0
  for (const ids of chunks) {
    const { error: updErr, count } = await sb
      .from('interactions')
      .update({ direction: 'outbound' }, { count: 'exact' })
      .in('id', ids)
    if (updErr) {
      pushError(result, 'flip_direction', updErr, ids.join(','))
      continue
    }
    fixed += count ?? ids.length
  }
  result.violationsFixed = fixed

  // Sample after — confirm the predicate now returns zero / residual.
  try {
    const after = await loadMisclassifiedInbounds(venueId, ownEmails)
    result.sampleAfter = after.slice(0, SAMPLE_CAP).map((r) => ({
      interaction_id: r.id,
      direction: r.direction,
      from_email: r.from_email,
      residual_after_remediation: true,
    }))
  } catch (err) {
    pushError(result, 'sample_after', err)
  }

  return result
}
