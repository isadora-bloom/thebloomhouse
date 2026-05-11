/**
 * Wave 9 remediation — touchpoint_source_consistency.
 *
 * What this fixes
 * ---------------
 * wedding_touchpoints rows whose `source` disagrees with the linked
 * interaction's actual channel (derived from from_email domain). E.g.
 * a tour_booked touchpoint with source='website' linked to a Calendly
 * notification → wrong channel label, wrong attribution rollups.
 *
 * Strategy
 * --------
 * For each violation row:
 *   - Resolve the linked interaction (via metadata.interaction_id, or
 *     through metadata.engagement_event_id → engagement_events.metadata
 *     .interaction_id).
 *   - Read the interaction.from_email and derive the canonical source
 *     from a known-domain map (matches the detector logic in
 *     data-integrity.ts checkSourceConsistency).
 *   - Update touchpoint.source to the derived value.
 *
 * Root-cause fix
 * --------------
 * The legacy bug is in attribution/signal-inference.ts where touchpoint
 * source is inferred from `wedding.source` (legacy first-touch column)
 * rather than the linked interaction's actual channel. Wave 9 fixes
 * that callsite to derive from the interaction's from_email domain,
 * matching the touchpoints.ts contract.
 *
 * Idempotency
 * -----------
 * Re-running on a cleaned dataset is a no-op (the detector predicate
 * returns zero violations once source matches the linked interaction).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import {
  makeEmptyResult,
  bumpSkip,
  pushError,
  SAMPLE_CAP,
  type RemediationCallArgs,
  type RemediationResult,
} from './types'

const INVARIANT_ID = 'touchpoint_source_consistency'

// Mirrors checkSourceConsistency in data-integrity.ts — keep in sync if
// new platforms are added to the detector.
const KNOWN_DOMAINS: Record<string, string> = {
  '@calendly.com': 'calendly',
  '@calendlymail.com': 'calendly',
  '@acuityscheduling.com': 'acuity',
  '@honeybook.com': 'honeybook',
  '@dubsado.com': 'dubsado',
  '@theknot.com': 'the_knot',
  '@knotemail.com': 'the_knot',
  '@weddingwire.com': 'wedding_wire',
  '@herecomestheguide.com': 'here_comes_the_guide',
}

const TOUCH_TYPES_TO_CHECK = ['tour_booked', 'calendly_booked', 'inquiry', 'email_reply', 'tour_conducted']

interface TouchpointRow {
  id: string
  touch_type: string
  source: string | null
  metadata: { interaction_id?: string | null; engagement_event_id?: string | null } | null
}

interface Violation {
  touchpointId: string
  touchType: string
  currentSource: string | null
  expectedSource: string
  fromEmail: string
}

async function resolveInteractionId(
  sb: SupabaseClient,
  tp: TouchpointRow,
): Promise<string | null> {
  if (tp.metadata?.interaction_id) return tp.metadata.interaction_id
  if (tp.metadata?.engagement_event_id) {
    const { data: ee } = await sb
      .from('engagement_events')
      .select('metadata')
      .eq('id', tp.metadata.engagement_event_id)
      .maybeSingle()
    const m = (ee as { metadata: { interaction_id?: string | null } | null } | null)?.metadata
    return m?.interaction_id ?? null
  }
  return null
}

async function detectMismatches(venueId: string): Promise<Violation[]> {
  const sb = createServiceClient()
  const { data: tps, error } = await sb
    .from('wedding_touchpoints')
    .select('id, touch_type, source, metadata')
    .eq('venue_id', venueId)
    .in('touch_type', TOUCH_TYPES_TO_CHECK)
  if (error) throw new Error(`detectMismatches: ${error.message}`)
  const rows = (tps ?? []) as TouchpointRow[]
  const violations: Violation[] = []
  for (const tp of rows) {
    const iid = await resolveInteractionId(sb, tp)
    if (!iid) continue
    const { data: ix } = await sb
      .from('interactions')
      .select('from_email')
      .eq('id', iid)
      .maybeSingle()
    const fromEmail = (((ix as { from_email: string | null } | null)?.from_email) ?? '').toLowerCase()
    if (!fromEmail) continue
    for (const [domain, expectedSource] of Object.entries(KNOWN_DOMAINS)) {
      if (fromEmail.includes(domain) && tp.source !== expectedSource) {
        violations.push({
          touchpointId: tp.id,
          touchType: tp.touch_type,
          currentSource: tp.source,
          expectedSource,
          fromEmail,
        })
        break
      }
    }
  }
  return violations
}

export async function remediateTouchpointSourceMismatch(
  { venueId, mode }: RemediationCallArgs,
): Promise<RemediationResult> {
  const result = makeEmptyResult(
    INVARIANT_ID,
    mode,
    'Realign wedding_touchpoints.source from linked interaction from_email domain.',
  )

  let violations: Violation[]
  try {
    violations = await detectMismatches(venueId)
  } catch (err) {
    pushError(result, 'detect_mismatches', err)
    return result
  }

  result.violationsDetected = violations.length
  if (violations.length === 0) return result

  result.sampleBefore = violations.slice(0, SAMPLE_CAP).map((v) => ({
    touchpoint_id: v.touchpointId,
    touch_type: v.touchType,
    current_source: v.currentSource,
    expected_source: v.expectedSource,
    from_email: v.fromEmail,
  }))

  if (mode === 'dry_run') {
    result.violationsFixed = violations.length
    return result
  }

  const sb = createServiceClient()
  let fixed = 0
  for (const v of violations) {
    const { error: updErr } = await sb
      .from('wedding_touchpoints')
      .update({ source: v.expectedSource })
      .eq('id', v.touchpointId)
    if (updErr) {
      pushError(result, 'update_source', updErr, v.touchpointId)
      bumpSkip(result, 'update_failed')
      continue
    }
    fixed += 1
  }
  result.violationsFixed = fixed

  try {
    const after = await detectMismatches(venueId)
    result.sampleAfter = after.slice(0, SAMPLE_CAP).map((v) => ({
      touchpoint_id: v.touchpointId,
      current_source: v.currentSource,
      expected_source: v.expectedSource,
      residual_after_remediation: true,
    }))
  } catch (err) {
    pushError(result, 'sample_after', err)
  }

  return result
}
