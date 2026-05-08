/**
 * Dunning escalation service. D3 (2026-05-08).
 *
 * Daily cron walks venues with past_due_since set and advances them
 * through the escalation ladder. Forward-only: each stage fires once
 * per past_due episode. When subscription returns to active, the
 * Stripe webhook clears past_due_since + dunning_stage.
 *
 *   Day 8:  reminder_1     -> email (per pricing-policy.md)
 *   Day 14: reminder_2     -> email + in-app banner via dunning_stage
 *   Day 21: sage_paused    -> autonomous_paused = true
 *   Day 30: read_only      -> dunning_stage = 'read_only' (route guards
 *                              honour this in a follow-up commit)
 *
 * Idempotent. Re-runs are safe; we only advance dunning_stage forward.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { createNotification } from '@/lib/services/admin-notifications'

const DAY_MS = 24 * 60 * 60 * 1000

interface VenueRow {
  id: string
  name: string | null
  past_due_since: string | null
  dunning_stage: string | null
  dunning_extension_until: string | null
  autonomous_paused: boolean | null
}

export interface DunningEscalateResult {
  scanned: number
  reminder_1_fired: number
  reminder_2_fired: number
  sage_paused_fired: number
  read_only_fired: number
  skipped_extension: number
  errors: string[]
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / DAY_MS)
}

/** Returns the stage the venue SHOULD be at given days_past_due. */
function targetStage(days: number): VenueRow['dunning_stage'] {
  if (days >= 30) return 'read_only'
  if (days >= 21) return 'sage_paused'
  if (days >= 14) return 'reminder_2'
  if (days >= 8) return 'reminder_1'
  return null
}

const STAGE_ORDER: Array<NonNullable<VenueRow['dunning_stage']>> = [
  'reminder_1',
  'reminder_2',
  'sage_paused',
  'read_only',
]

function isAdvance(from: VenueRow['dunning_stage'], to: VenueRow['dunning_stage']): boolean {
  if (!to) return false
  if (!from) return true
  return STAGE_ORDER.indexOf(to) > STAGE_ORDER.indexOf(from)
}

export async function runDunningEscalate(): Promise<DunningEscalateResult> {
  const result: DunningEscalateResult = {
    scanned: 0,
    reminder_1_fired: 0,
    reminder_2_fired: 0,
    sage_paused_fired: 0,
    read_only_fired: 0,
    skipped_extension: 0,
    errors: [],
  }

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('venues')
    .select('id, name, past_due_since, dunning_stage, dunning_extension_until, autonomous_paused')
    .not('past_due_since', 'is', null)
  if (error) {
    result.errors.push(`venues read: ${error.message}`)
    return result
  }

  const nowIso = new Date().toISOString()

  for (const v of (data ?? []) as VenueRow[]) {
    result.scanned += 1
    if (!v.past_due_since) continue

    if (v.dunning_extension_until && v.dunning_extension_until > nowIso) {
      result.skipped_extension += 1
      continue
    }

    const days = daysSince(v.past_due_since)
    const target = targetStage(days)
    if (!isAdvance(v.dunning_stage, target)) continue

    try {
      // Stage-specific side effect.
      if (target === 'reminder_1' || target === 'reminder_2') {
        const isFirst = target === 'reminder_1'
        await createNotification({
          venueId: v.id,
          type: isFirst ? 'dunning_reminder_1' : 'dunning_reminder_2',
          title: isFirst
            ? 'Payment update needed'
            : 'Payment still outstanding',
          body: isFirst
            ? `Your payment did not go through last week. Please update your billing in /settings/billing to keep your account active. Sage drafts pause at day 21 if unresolved.`
            : `Your payment is now ${days} days past due. Sage drafts pause at day 21 and your account moves to read-only at day 30. Update billing in /settings/billing.`,
          priority: 'high',
        })
        if (isFirst) result.reminder_1_fired += 1
        else result.reminder_2_fired += 1
      }

      if (target === 'sage_paused') {
        // Pause autonomous-sender. autonomous_paused is the existing
        // venue-wide kill switch from the cost-ceiling system; reusing
        // it keeps the autonomous-sender skip path simple.
        await supabase
          .from('venue_config')
          .update({ autonomous_paused: true })
          .eq('venue_id', v.id)
        await createNotification({
          venueId: v.id,
          type: 'dunning_sage_paused',
          title: 'Sage drafts paused (billing past due)',
          body: `Your account is ${days} days past due. Sage will not auto-draft new emails until billing is resolved. You can still manually send via Gmail. Update at /settings/billing.`,
          priority: 'urgent',
        })
        result.sage_paused_fired += 1
      }

      if (target === 'read_only') {
        // Read-only enforcement at the API layer ships in a follow-up.
        // For now the dunning_stage flag itself is the signal; UI
        // banners + writers will check it.
        await createNotification({
          venueId: v.id,
          type: 'dunning_read_only',
          title: 'Account moved to read-only (billing past due)',
          body: `Your account is ${days} days past due and is now read-only. You can still resolve billing at /settings/billing. After 60 days past due your account will be cancelled and data archived.`,
          priority: 'urgent',
        })
        result.read_only_fired += 1
      }

      // Advance the stage on the venue row.
      const { error: upErr } = await supabase
        .from('venues')
        .update({ dunning_stage: target })
        .eq('id', v.id)
      if (upErr) {
        result.errors.push(`venue ${v.id} stage update: ${upErr.message}`)
      }
    } catch (err) {
      result.errors.push(`venue ${v.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log(
    `[dunning_escalate] scanned=${result.scanned} r1=${result.reminder_1_fired} r2=${result.reminder_2_fired} sage=${result.sage_paused_fired} ro=${result.read_only_fired} extension_skipped=${result.skipped_extension}`,
  )
  return result
}
