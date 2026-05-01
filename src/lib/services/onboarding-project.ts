/**
 * 5-day onboarding project orchestration (T2-A / Playbook Part 18).
 *
 * The 5-day enterprise/paid-plan onboarding flow that sits beside the
 * existing 15-min wizard at /onboarding. Both audiences supported per
 * coordinator approval (2026-05-01).
 *
 * Day-by-day structure (per Playbook 18):
 *   Day 1: OAuth + email backfill           — Gmail connection, 12mo backfill seeded
 *   Day 2: Marketing channels + pricing     — channel registry, pricing reconstruction
 *   Day 3: CRM exports + ingestion          — HoneyBook / Dubsado / Aisle Planner adapters
 *   Day 4: Voice DNA + coordinator confirm  — transcript-voice-learning over imports
 *   Day 5: KB seeding + readiness gate      — knowledge base, gate evaluates, Go Live
 *
 * Each day is a set of steps; coordinators progress through them at
 * their own pace. Each step write stamps a completion timestamp + an
 * optional coordinator note. The readiness gate (onboarding-readiness.ts)
 * runs at any time and persists its verdict into the project row.
 *
 * Data-model invariants:
 *   - One ACTIVE project per venue (in_progress / paused / go_live_pending).
 *     Enforced via partial unique index in migration 136.
 *   - Days complete in order. advanceDay refuses to skip.
 *   - Go Live requires status='go_live_pending' AND readiness_passed_at IS NOT NULL.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export const TOTAL_DAYS = 5

export interface DayPlan {
  day: number
  title: string
  subtitle: string
  steps: DayStep[]
}

export interface DayStep {
  key: string
  label: string
  description: string
  /** Action key the UI handler matches against. */
  actionKey: 'oauth_gmail' | 'backfill_email' | 'seed_channels' | 'reconstruct_pricing'
    | 'import_crm' | 'orphan_triage' | 'voice_dna_seed' | 'kb_seed' | 'readiness_check'
    | 'manual'
}

/**
 * Canonical day-by-day plan. Coordinators always see the same skeleton;
 * UI renders dynamic state per project row.
 */
export const PROJECT_PLAN: DayPlan[] = [
  {
    day: 1,
    title: 'Connect + Backfill',
    subtitle: 'Get Gmail wired up and pull 12 months of inquiry history.',
    steps: [
      {
        key: 'gmail_oauth',
        label: 'Connect the inquiry Gmail account',
        description:
          'OAuth into the Gmail account that receives venue inquiries. Bloom subscribes to the inbox and starts ingesting new messages immediately.',
        actionKey: 'oauth_gmail',
      },
      {
        key: 'backfill_12mo',
        label: 'Run 12-month email backfill',
        description:
          'Pull the last 12 months of inquiry messages, classify, and stamp confidence_flag=imported_low so downstream surfaces know these are backfilled.',
        actionKey: 'backfill_email',
      },
    ],
  },
  {
    day: 2,
    title: 'Marketing channels + pricing',
    subtitle: 'Register the channels you actively market through and reconstruct your historical pricing.',
    steps: [
      {
        key: 'marketing_channels',
        label: 'Register your marketing channels',
        description:
          'Go to /portal/marketing-channels-config and add every channel you actively market through. Quick-add suggestions cover the common platforms; long-tail channels (regional bridal magazines, podcasts, partner referrals) need a custom entry.',
        actionKey: 'seed_channels',
      },
      {
        key: 'pricing_history',
        label: 'Reconstruct pricing history',
        description:
          'Walk back through any pricing changes from the last 12 months. The pricing_history audit table captures these so the elasticity insight has signal to compute.',
        actionKey: 'reconstruct_pricing',
      },
    ],
  },
  {
    day: 3,
    title: 'CRM ingestion',
    subtitle: 'Import HoneyBook, Dubsado, or Aisle Planner exports + triage orphans.',
    steps: [
      {
        key: 'crm_export',
        label: 'Upload CRM export',
        description:
          'Drop the CRM export in /agent/imports. Adapter templates handle HoneyBook / Dubsado / Aisle Planner; other CRMs map to the same column shape via a one-time mapping pass.',
        actionKey: 'import_crm',
      },
      {
        key: 'orphan_triage',
        label: 'Triage orphan transcripts + interactions',
        description:
          'Audio-capture transcripts that didn\'t auto-match a tour land in /agent/audio-inbox; orphan interactions land in the standard inbox queue. Triage these so identity-resolution has clean anchors.',
        actionKey: 'orphan_triage',
      },
    ],
  },
  {
    day: 4,
    title: 'Voice DNA',
    subtitle: 'Seed Sage\'s voice from your imported messages, then confirm.',
    steps: [
      {
        key: 'voice_dna_extract',
        label: 'Extract voice patterns from imports',
        description:
          'Run transcript-voice-learning over the 12mo Gmail backfill + any tour transcripts. Patterns surface for confirmation — coordinator approves or rejects each.',
        actionKey: 'voice_dna_seed',
      },
      {
        key: 'voice_dna_confirm',
        label: 'Confirm extracted patterns',
        description:
          'Review the proposed voice anchors at /settings/personality. Confirmed patterns seed the per-venue voice_anchors table; rejected ones move to a learning corpus for future iteration.',
        actionKey: 'manual',
      },
    ],
  },
  {
    day: 5,
    title: 'KB + Go Live',
    subtitle: 'Knowledge base seeded + readiness gate evaluated. Coordinator ships.',
    steps: [
      {
        key: 'kb_seed',
        label: 'Seed knowledge base from FAQs',
        description:
          'Either pull from the existing 15-min wizard FAQs or hand-enter at /portal/kb. KB feeds Sage\'s answer confidence — sparse KB = more coordinator escalations.',
        actionKey: 'kb_seed',
      },
      {
        key: 'readiness_gate',
        label: 'Run readiness gate',
        description:
          'Evaluates minimum data-volume thresholds across Internal Context (channels, absences, pricing), Forensic Record (interactions, weddings), and Voice DNA. All limbs must pass before Go Live unlocks.',
        actionKey: 'readiness_check',
      },
      {
        key: 'go_live',
        label: 'Go Live',
        description:
          'Flips the venue from onboarding to live. Auto-send + drafts + intel surfaces all activate. Reversible via "Pause project" if something needs revisiting.',
        actionKey: 'manual',
      },
    ],
  },
]

export interface OnboardingProjectRow {
  id: string
  venue_id: string
  status: 'in_progress' | 'paused' | 'go_live_pending' | 'live' | 'archived'
  started_at: string
  target_go_live: string | null
  completed_at: string | null
  current_day: number
  current_step_key: string | null
  day_1_completed_at: string | null
  day_2_completed_at: string | null
  day_3_completed_at: string | null
  day_4_completed_at: string | null
  day_5_completed_at: string | null
  readiness_state: Record<string, unknown>
  readiness_passed_at: string | null
  readiness_failures: unknown[]
  coordinator_notes: Record<string, unknown>
  created_at: string
  updated_at: string
}

/**
 * Fetch the active project for a venue, if any.
 */
export async function getActiveProject(
  supabase: SupabaseClient,
  venueId: string,
): Promise<OnboardingProjectRow | null> {
  const { data, error } = await supabase
    .from('onboarding_projects')
    .select('*')
    .eq('venue_id', venueId)
    .in('status', ['in_progress', 'paused', 'go_live_pending'])
    .maybeSingle()
  if (error) {
    console.error('[onboarding-project] active fetch failed:', error.message)
    return null
  }
  return (data as OnboardingProjectRow | null) ?? null
}

/**
 * Start a fresh project. Idempotent — returns existing active project
 * if one already exists.
 */
export async function startProject(
  supabase: SupabaseClient,
  venueId: string,
  targetGoLive?: string,
): Promise<OnboardingProjectRow | null> {
  const existing = await getActiveProject(supabase, venueId)
  if (existing) return existing

  const { data, error } = await supabase
    .from('onboarding_projects')
    .insert({
      venue_id: venueId,
      status: 'in_progress',
      current_day: 1,
      target_go_live: targetGoLive ?? null,
    })
    .select('*')
    .single()
  if (error) {
    console.error('[onboarding-project] start failed:', error.message)
    return null
  }
  return data as OnboardingProjectRow
}

/**
 * Mark a step within a day as completed. Updates current_step_key +
 * appends a coordinator note (if provided).
 */
export async function recordStepCompletion(
  supabase: SupabaseClient,
  projectId: string,
  day: number,
  stepKey: string,
  note?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (day < 1 || day > TOTAL_DAYS) return { ok: false, error: `invalid day ${day}` }

  const { data: row, error: readErr } = await supabase
    .from('onboarding_projects')
    .select('coordinator_notes')
    .eq('id', projectId)
    .maybeSingle()
  if (readErr) return { ok: false, error: readErr.message }

  const notes = (row?.coordinator_notes ?? {}) as Record<string, Record<string, { completed_at: string; note?: string }>>
  const dayKey = `day_${day}`
  if (!notes[dayKey]) notes[dayKey] = {}
  notes[dayKey][stepKey] = {
    completed_at: new Date().toISOString(),
    note: note?.trim() || undefined,
  }

  const { error: updErr } = await supabase
    .from('onboarding_projects')
    .update({
      current_step_key: stepKey,
      coordinator_notes: notes,
    })
    .eq('id', projectId)
  if (updErr) return { ok: false, error: updErr.message }
  return { ok: true }
}

/**
 * Advance to the next day. Refuses to skip — must be (current+1).
 * Stamps the previous day's completed_at column.
 */
export async function advanceDay(
  supabase: SupabaseClient,
  projectId: string,
): Promise<{ ok: true; newDay: number } | { ok: false; error: string }> {
  const { data: row, error: readErr } = await supabase
    .from('onboarding_projects')
    .select('current_day, status')
    .eq('id', projectId)
    .maybeSingle()
  if (readErr || !row) return { ok: false, error: readErr?.message ?? 'project not found' }

  const cur = row.current_day as number
  if (cur >= TOTAL_DAYS) {
    // At Day 5, "advancing" means moving to go_live_pending.
    const { error } = await supabase
      .from('onboarding_projects')
      .update({
        status: 'go_live_pending',
        day_5_completed_at: new Date().toISOString(),
      })
      .eq('id', projectId)
    if (error) return { ok: false, error: error.message }
    return { ok: true, newDay: TOTAL_DAYS }
  }
  const dayCol = `day_${cur}_completed_at`
  const { error } = await supabase
    .from('onboarding_projects')
    .update({
      current_day: cur + 1,
      [dayCol]: new Date().toISOString(),
      current_step_key: null,
    })
    .eq('id', projectId)
  if (error) return { ok: false, error: error.message }
  return { ok: true, newDay: cur + 1 }
}

/**
 * Persist a readiness-gate evaluation. Called by onboarding-readiness.ts
 * after running its checks.
 */
export async function recordReadinessEvaluation(
  supabase: SupabaseClient,
  projectId: string,
  args: {
    state: Record<string, unknown>
    failures: unknown[]
    passed: boolean
  },
): Promise<void> {
  await supabase
    .from('onboarding_projects')
    .update({
      readiness_state: args.state,
      readiness_failures: args.failures,
      readiness_passed_at: args.passed ? new Date().toISOString() : null,
    })
    .eq('id', projectId)
}

/**
 * Flip the project to live. Refuses unless status='go_live_pending'
 * AND readiness_passed_at IS NOT NULL.
 */
export async function activateLive(
  supabase: SupabaseClient,
  projectId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: row } = await supabase
    .from('onboarding_projects')
    .select('status, readiness_passed_at')
    .eq('id', projectId)
    .maybeSingle()
  if (!row) return { ok: false, error: 'project not found' }
  if (row.status !== 'go_live_pending') {
    return { ok: false, error: `cannot Go Live from status=${row.status}` }
  }
  if (!row.readiness_passed_at) {
    return { ok: false, error: 'readiness gate has not passed yet' }
  }
  const { error } = await supabase
    .from('onboarding_projects')
    .update({
      status: 'live',
      completed_at: new Date().toISOString(),
    })
    .eq('id', projectId)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

/**
 * Pause an active project. Coordinator can resume later.
 */
export async function pauseProject(
  supabase: SupabaseClient,
  projectId: string,
): Promise<void> {
  await supabase
    .from('onboarding_projects')
    .update({ status: 'paused' })
    .eq('id', projectId)
}

export async function resumeProject(
  supabase: SupabaseClient,
  projectId: string,
): Promise<void> {
  await supabase
    .from('onboarding_projects')
    .update({ status: 'in_progress' })
    .eq('id', projectId)
}
