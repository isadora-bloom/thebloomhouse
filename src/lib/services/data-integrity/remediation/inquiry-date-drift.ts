/**
 * Wave 9 remediation — inquiry_date_drift.
 *
 * What this fixes
 * ---------------
 * Weddings whose inquiry_date drifts >48h from the earliest inbound
 * interaction. Backfill artifact (NOW() stamped instead of email date)
 * or pinning to a later non-inquiry email.
 *
 * Strategy
 * --------
 * For each ghost-drift wedding:
 *   - When the wedding has at least one inbound interaction with a
 *     timestamp: set inquiry_date = MIN(timestamp). This is the
 *     authoritative "first inbound signal" anchor matching
 *     bloom-data-integrity-sweep.md doctrine.
 *   - When the wedding has NO inbound interactions (e.g. CRM-imported
 *     only): leave inquiry_date alone, count under
 *     skip_reasons.no_inbound_signal. Coordinator can override manually.
 *
 * Root-cause fix
 * --------------
 * src/lib/services/identity/resolver.ts createWedding() was the bad
 * write site: `inquiry_date: new Date().toISOString()` — wall-clock
 * NOW(), no signal anchor. Wave 9 adds an optional inquirySignalAt
 * parameter so callers pass the source signal's timestamp.
 *
 * email/pipeline.ts already uses chooseEventTime(email.date) on its
 * two wedding-create paths (2026-04-30 fix); no changes needed there.
 *
 * /api/agent/reprocess-orphans/route.ts + /api/agent/reprocess-form-
 * relays/route.ts already use row.timestamp ?? new Date(); those are
 * acceptable (the row timestamp is the signal), but they fall back to
 * NOW() when missing — defended by the inquiry_date_drift invariant
 * itself.
 *
 * Idempotency
 * -----------
 * After remediation the drift predicate (>48h from earliest inbound)
 * is zero; re-running is a no-op.
 */

import { createServiceClient } from '@/lib/supabase/service'
import {
  makeEmptyResult,
  bumpSkip,
  pushError,
  SAMPLE_CAP,
  type RemediationCallArgs,
  type RemediationResult,
} from './types'

const INVARIANT_ID = 'inquiry_date_drift'
const DRIFT_THRESHOLD_HOURS = 48

interface DriftedWedding {
  id: string
  inquiry_date: string
  earliest_inbound: string
  drift_hours: number
}

async function detectDriftedWeddings(venueId: string): Promise<{
  drifted: DriftedWedding[]
  noInboundCount: number
}> {
  const sb = createServiceClient()
  const { data: weddings, error } = await sb
    .from('weddings')
    .select('id, inquiry_date')
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
    .not('inquiry_date', 'is', null)
  if (error) throw new Error(`detectDriftedWeddings: ${error.message}`)
  const rows = (weddings ?? []) as Array<{ id: string; inquiry_date: string }>

  const drifted: DriftedWedding[] = []
  let noInboundCount = 0

  for (const w of rows) {
    const { data: first } = await sb
      .from('interactions')
      .select('timestamp')
      .eq('wedding_id', w.id)
      .eq('direction', 'inbound')
      .not('timestamp', 'is', null)
      .order('timestamp', { ascending: true })
      .limit(1)
    const earliest = (first?.[0] as { timestamp: string } | undefined)?.timestamp
    if (!earliest) {
      // No inbound at all — coordinator-only territory.
      noInboundCount += 1
      continue
    }
    const drift = Math.abs(new Date(earliest).getTime() - new Date(w.inquiry_date).getTime()) / 3_600_000
    if (drift >= DRIFT_THRESHOLD_HOURS) {
      drifted.push({
        id: w.id,
        inquiry_date: w.inquiry_date,
        earliest_inbound: earliest,
        drift_hours: Math.round(drift),
      })
    }
  }

  return { drifted, noInboundCount }
}

export async function remediateInquiryDateDrift(
  { venueId, mode }: RemediationCallArgs,
): Promise<RemediationResult> {
  const result = makeEmptyResult(
    INVARIANT_ID,
    mode,
    'Set inquiry_date = MIN(earliest inbound interaction). Skip when no inbound exists.',
  )

  let detect
  try {
    detect = await detectDriftedWeddings(venueId)
  } catch (err) {
    pushError(result, 'detect_drift', err)
    return result
  }
  const { drifted, noInboundCount } = detect

  result.violationsDetected = drifted.length
  // Track no-inbound weddings as skipped for visibility — they don't
  // count as "drift violations" against the invariant (the detector
  // doesn't flag them either), but the coordinator should know how
  // many CRM-imported / signal-less weddings exist on the venue.
  if (noInboundCount > 0) {
    result.skipReasons.no_inbound_signal_available = noInboundCount
  }

  if (drifted.length === 0) return result

  result.sampleBefore = drifted.slice(0, SAMPLE_CAP).map((d) => ({
    wedding_id: d.id,
    inquiry_date: d.inquiry_date,
    earliest_inbound: d.earliest_inbound,
    drift_hours: d.drift_hours,
  }))

  if (mode === 'dry_run') {
    result.violationsFixed = drifted.length
    return result
  }

  const sb = createServiceClient()
  let fixed = 0
  for (const d of drifted) {
    const { error: updErr } = await sb
      .from('weddings')
      .update({ inquiry_date: d.earliest_inbound })
      .eq('id', d.id)
    if (updErr) {
      pushError(result, 'realign_inquiry_date', updErr, d.id)
      bumpSkip(result, 'update_failed')
      continue
    }
    fixed += 1
  }
  result.violationsFixed = fixed

  // Sample after — confirm residual.
  try {
    const afterDetect = await detectDriftedWeddings(venueId)
    result.sampleAfter = afterDetect.drifted.slice(0, SAMPLE_CAP).map((d) => ({
      wedding_id: d.id,
      inquiry_date: d.inquiry_date,
      drift_hours: d.drift_hours,
      residual_after_remediation: true,
    }))
  } catch (err) {
    pushError(result, 'sample_after', err)
  }

  return result
}
