/**
 * Bloom House — Wave 20 voice-DNA drift-refresh sweep.
 *
 * Anchor docs (~/.claude memory/):
 *   - bloom-constitution.md (operator authority — the sweep produces
 *     new proposals; never auto-applies anything)
 *
 * Cadence: every 60 days, for each venue that has at least one applied
 * voice_dna_derivations row, enqueue a fresh derivation. The operator
 * receives the new proposal in the Voice DNA UI; if they like it they
 * accept, if not they dismiss. Voice drift naturally produces small
 * incremental changes the operator can pick up.
 *
 * Cron registration: TODO — register in src/app/api/cron/route.ts
 * (case 'voice_dna_sweep') and vercel.json. Wave 20 leaves this for
 * the reconciliation stream so parallel agents don't fight the cron
 * route file. The job string to use is `voice_dna_sweep`.
 *
 * Skip conditions per venue:
 *   - No prior applied derivation (= the venue hasn't gone through the
 *     onboarding flow yet; nothing to drift FROM).
 *   - Last derivation < 60 days old (= too recent; spend protection).
 *   - Cost-cap gated (= autonomous_paused; per-venue gate inside
 *     deriveVoiceDNA itself catches this too, but we double-check
 *     here to avoid even enqueueing the job).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { deriveVoiceDNA } from './derive'

export const DRIFT_INTERVAL_DAYS = 60

export interface SweepOutcome {
  venuesChecked: number
  venuesDerived: number
  venuesSkipped: number
  venuesFailed: number
  perVenue: Array<{
    venueId: string
    outcome: 'derived' | 'skipped' | 'failed'
    reason?: string
    derivationId?: string
    costCents?: number
  }>
}

interface VenueWithLatestDerivation {
  venue_id: string
  derived_at: string
}

/**
 * For each venue with at least one applied derivation, derive a fresh
 * voice DNA if the last derivation is older than DRIFT_INTERVAL_DAYS.
 * Per-venue failures are caught + logged so one bad venue doesn't
 * break the cross-venue tick.
 */
export async function voiceDnaDriftSweep(args: {
  supabase?: SupabaseClient
} = {}): Promise<SweepOutcome> {
  const supabase = args.supabase ?? createServiceClient()
  const summary: SweepOutcome = {
    venuesChecked: 0,
    venuesDerived: 0,
    venuesSkipped: 0,
    venuesFailed: 0,
    perVenue: [],
  }

  // Find every venue with at least one APPLIED derivation. The sweep
  // only runs against venues that have gone through the operator-apply
  // flow at least once — otherwise we have nothing to drift FROM.
  // Pick the MOST-RECENT derived_at per venue (whether applied or not)
  // so the cadence respects all attempts, not just applied ones.
  const { data: derivRows } = await supabase
    .from('voice_dna_derivations')
    .select('venue_id, derived_at, applied')
    .order('derived_at', { ascending: false })
    .limit(5000)

  const latestByVenue = new Map<string, { derived_at: string; everApplied: boolean }>()
  for (const row of (derivRows ?? []) as Array<{ venue_id: string; derived_at: string; applied: boolean }>) {
    const cur = latestByVenue.get(row.venue_id)
    if (!cur) {
      latestByVenue.set(row.venue_id, {
        derived_at: row.derived_at,
        everApplied: row.applied,
      })
    } else {
      if (row.applied && !cur.everApplied) {
        cur.everApplied = true
      }
      // derived_at already DESC-sorted; cur is the newest by construction.
    }
  }

  const cutoffMs = Date.now() - DRIFT_INTERVAL_DAYS * 24 * 60 * 60 * 1000

  for (const [venueId, latest] of latestByVenue.entries()) {
    summary.venuesChecked++

    // Skip if the venue has never applied a derivation. Drift cadence
    // is only meaningful for venues that have a baseline to drift FROM.
    if (!latest.everApplied) {
      summary.venuesSkipped++
      summary.perVenue.push({ venueId, outcome: 'skipped', reason: 'never_applied' })
      continue
    }

    // Skip if the last derivation is too recent.
    const latestMs = new Date(latest.derived_at).getTime()
    if (Number.isFinite(latestMs) && latestMs > cutoffMs) {
      summary.venuesSkipped++
      summary.perVenue.push({ venueId, outcome: 'skipped', reason: 'too_recent' })
      continue
    }

    // Enqueue + run.
    try {
      // Insert the queue row first so we have an audit anchor even on
      // mid-derivation failure.
      const { data: jobRow } = await supabase
        .from('voice_dna_jobs')
        .insert({
          venue_id: venueId,
          status: 'running',
          trigger_signal: 'cron_drift_60d',
          started_at: new Date().toISOString(),
        })
        .select('id')
        .single()
      const jobId = (jobRow as { id: string } | null)?.id

      const result = await deriveVoiceDNA({
        venueId,
        supabase,
        actor: 'cron:voice_dna_sweep',
        jobId,
      })

      if (result.ok) {
        summary.venuesDerived++
        summary.perVenue.push({
          venueId,
          outcome: 'derived',
          derivationId: result.derivationId,
          costCents: result.costCents,
        })
      } else {
        summary.venuesSkipped++
        summary.perVenue.push({
          venueId,
          outcome: 'skipped',
          reason: result.reason,
        })
        // Reflect failure in the job row too.
        if (jobId) {
          await supabase
            .from('voice_dna_jobs')
            .update({
              status: result.reason === 'gated' || result.reason === 'insufficient_evidence' ? 'skipped' : 'failed',
              completed_at: new Date().toISOString(),
              error_text: result.details ?? result.reason,
            })
            .eq('id', jobId)
        }
      }
    } catch (err) {
      summary.venuesFailed++
      summary.perVenue.push({
        venueId,
        outcome: 'failed',
        reason: err instanceof Error ? err.message : 'unknown',
      })
    }
  }

  return summary
}
