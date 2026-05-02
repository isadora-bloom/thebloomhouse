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
    | 'import_crm' | 'orphan_triage' | 'voice_dna_seed' | 'voice_dna_extract'
    | 'kb_seed' | 'readiness_check' | 'manual' | 'pricing_history_ui'
    | 'crm_import_ui'
  /** External admin surface where the coordinator does the actual
   *  work for this step. Page renders this as a "Go to surface" link
   *  so coordinators don't have to memorise where each piece lives.
   *  null when the step is purely confirmation (no surface to visit). */
  linkHref: string | null
  /** Optional CTA label for the link button. Defaults to "Open surface" */
  linkLabel?: string
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
        linkHref: '/settings/gmail-connection',
        linkLabel: 'Open Gmail connection',
      },
      {
        key: 'backfill_12mo',
        label: 'Run 12-month email backfill',
        description:
          'Pull the last 12 months of inquiry messages, classify, and stamp confidence_flag=imported_low so downstream surfaces know these are backfilled. (Programmatic trigger landing as part of the T2-A follow-up; coordinator runs the legacy backfill button on the Gmail settings page for now.)',
        actionKey: 'backfill_email',
        linkHref: '/settings/gmail-connection',
        linkLabel: 'Trigger backfill',
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
          'Add every channel you actively market through. Quick-add suggestions cover the common platforms; long-tail channels (regional bridal magazines, podcasts, partner referrals) need a custom entry.',
        actionKey: 'seed_channels',
        linkHref: '/portal/marketing-channels-config',
        linkLabel: 'Open marketing channels',
      },
      {
        key: 'pricing_history',
        label: 'Reconstruct pricing history',
        description:
          'Walk back through pricing changes from the last 12 months. base_price + capacity edits auto-log via the migration 134 trigger; package-level + tier-restructure changes need manual entry on the reconstruction UI. Day-3 sub-step completes once 5+ rows are logged.',
        actionKey: 'pricing_history_ui',
        linkHref: '/onboarding/pricing-history',
        linkLabel: 'Open pricing-history reconstruction',
      },
    ],
  },
  {
    day: 3,
    title: 'CRM ingestion',
    subtitle: 'Import historical pricing + lead history from your existing CRM.',
    steps: [
      {
        key: 'pricing_history_reconstruct',
        label: 'Import pricing history',
        description:
          'Walk through historical package + pricing changes on the reconstruction UI. Single-row form for ad-hoc entries; CSV bulk upload for batches. Sub-step completes once pricing_history has 5+ coordinator-entered rows.',
        actionKey: 'pricing_history_ui',
        linkHref: '/onboarding/pricing-history',
        linkLabel: 'Open pricing-history reconstruction',
      },
      {
        key: 'crm_export',
        label: 'Import lead history from CRM',
        description:
          'Upload a HoneyBook / Dubsado / Aisle Planner export, or use the Generic CSV adapter with a custom column-mapping JSON. Imported rows are tagged confidence_flag=imported_medium so live pipeline data stays distinguishable. Sub-step completes once weddings has 1+ row tagged imported_medium.',
        actionKey: 'crm_import_ui',
        linkHref: '/onboarding/crm-import',
        linkLabel: 'Open CRM import',
      },
      {
        key: 'orphan_triage',
        label: 'Triage orphan transcripts + interactions',
        description:
          'Audio-capture transcripts that didn\'t auto-match a tour land in the audio inbox; orphan interactions land in the standard inbox queue. Triage these so identity-resolution has clean anchors.',
        actionKey: 'orphan_triage',
        linkHref: '/agent/audio-inbox',
        linkLabel: 'Open audio inbox',
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
          'Run voice DNA extraction over the 12mo Gmail backfill. Pulls coordinator-written outbound emails, identifies your greetings + signoffs + pet phrases + sentence rhythm, and writes them to the venue voice anchors. Click "Run extraction" below — no need to leave this page (T5-θ.3).',
        actionKey: 'voice_dna_extract',
        linkHref: null,
        linkLabel: 'Run extraction',
      },
      {
        key: 'voice_dna_confirm',
        label: 'Confirm extracted patterns',
        description:
          'Review the proposed voice anchors. Confirmed patterns seed the per-venue voice anchors; rejected ones move to a learning corpus for future iteration.',
        actionKey: 'manual',
        linkHref: '/settings/personality',
        linkLabel: 'Open personality',
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
          'Either pull from the existing 15-min wizard FAQs or hand-enter. KB feeds Sage\'s answer confidence — sparse KB = more coordinator escalations.',
        actionKey: 'kb_seed',
        linkHref: '/portal/kb',
        linkLabel: 'Open knowledge base',
      },
      {
        key: 'readiness_gate',
        label: 'Run readiness gate',
        description:
          'Evaluates minimum data-volume thresholds across Internal Context (channels, absences, pricing), Forensic Record (interactions, weddings), and Voice DNA. All limbs must pass before Go Live unlocks. (Library-side runner landing in T2-A follow-up; for now run scripts/onboarding-readiness.ts manually and paste the verdict into a coordinator note.)',
        actionKey: 'readiness_check',
        linkHref: null,
      },
      {
        key: 'go_live',
        label: 'Go Live',
        description:
          'Flips the venue from onboarding to live. Auto-send + drafts + intel surfaces all activate. Reversible via "Pause project" if something needs revisiting.',
        actionKey: 'manual',
        linkHref: null,
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
 * Minimum 12-month-backfill score required for paid venues to Go Live.
 * 80 = all required Internal Context categories complete OR skipped
 * with reason. Pre-fix: paid venues could Go Live with zero historical
 * context, hiding the macro-correlation USP for the first 6-12mo
 * (ARCH-18.2).
 */
export const MIN_BACKFILL_SCORE_FOR_PAID = 80

/**
 * Flip the project to live. Refuses unless status='go_live_pending'
 * AND readiness_passed_at IS NOT NULL. For PAID venues
 * (venues.requires_backfill=true) additionally requires
 * onboarding_backfill_progress score >= MIN_BACKFILL_SCORE_FOR_PAID
 * — closes the gap where paid venues Go Live'd with zero historical
 * Internal/External Context (ARCH-18.2 / 18.3-C / 18.3-D / LIMB-16.3).
 */
export async function activateLive(
  supabase: SupabaseClient,
  projectId: string,
): Promise<{ ok: true } | { ok: false; error: string; backfillScore?: number; missingCategories?: string[] }> {
  const { data: row } = await supabase
    .from('onboarding_projects')
    .select('status, readiness_passed_at, venue_id')
    .eq('id', projectId)
    .maybeSingle()
  if (!row) return { ok: false, error: 'project not found' }
  if (row.status !== 'go_live_pending') {
    return { ok: false, error: `cannot Go Live from status=${row.status}` }
  }
  if (!row.readiness_passed_at) {
    return { ok: false, error: 'readiness gate has not passed yet' }
  }

  // T5-β.1: white-label gate. A venue cannot Go Live without an
  // ai_name in venue_ai_config — otherwise every brain path silently
  // shipped as "Sage" / "sage@hawthornemanor.com" for the new venue.
  // The 5-day project flow doesn't have a Day-1 ai_name capture step
  // yet, so we backstop here.
  const { data: aiCfg } = await supabase
    .from('venue_ai_config')
    .select('ai_name')
    .eq('venue_id', row.venue_id as string)
    .maybeSingle()
  const aiName = (aiCfg?.ai_name as string | null | undefined)?.trim()
  if (!aiName) {
    // Backfill from venues.name to keep the activation path moving;
    // coordinator can rename via /settings/personality afterwards.
    const { data: ven } = await supabase
      .from('venues')
      .select('name')
      .eq('id', row.venue_id as string)
      .maybeSingle()
    const fallbackName = `${(ven?.name as string | null | undefined)?.trim() || 'Venue'} Concierge`
    const { error: aiErr } = await supabase
      .from('venue_ai_config')
      .upsert(
        { venue_id: row.venue_id as string, ai_name: fallbackName, updated_at: new Date().toISOString() },
        { onConflict: 'venue_id' },
      )
    if (aiErr) return { ok: false, error: `failed to seed venue_ai_config.ai_name: ${aiErr.message}` }
  }

  // Paid-venue backfill gate. Free / starter venues (requires_backfill
  // = false) skip this check.
  const { data: venue } = await supabase
    .from('venues')
    .select('requires_backfill')
    .eq('id', row.venue_id as string)
    .maybeSingle()
  if (venue?.requires_backfill) {
    // Lazy-load to avoid circular import (this module is imported at
    // service-init time; onboarding-backfill imports nothing from
    // here so the cycle is one-way).
    const { computeBackfillScore } = await import('./onboarding-backfill')
    const { score, coverages, categoriesRequired } = await computeBackfillScore(supabase, row.venue_id as string)
    if (score < MIN_BACKFILL_SCORE_FOR_PAID) {
      const missing = coverages
        .filter((c) => categoriesRequired.includes(c.category))
        .filter((c) => c.status !== 'complete' && c.status !== 'skipped')
        .map((c) => c.category)
      return {
        ok: false,
        error: `12-month backfill incomplete (score ${score}/100; need >= ${MIN_BACKFILL_SCORE_FOR_PAID}). Required categories not yet complete: ${missing.join(', ') || 'none'}.`,
        backfillScore: score,
        missingCategories: missing,
      }
    }
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

/**
 * Day-3 completion gate (T5-followup-Y / Pattern I closure).
 *
 * Day 3 advances when BOTH:
 *   - pricing_history has >= 5 manual rows (manual_form / manual_csv)
 *   - weddings has >= 1 row tagged confidence_flag='imported_medium'
 *     (CRM-import output)
 *
 * Used by the /onboarding/project page to decide whether the
 * "Advance to next day" button enables once Day-3 sub-steps are
 * marked done. The advanceDay function itself stays gate-agnostic
 * (so coordinator can override by skipping a sub-step + advancing
 * manually) — this helper just powers the UI affordance.
 */
export interface Day3Readiness {
  ready: boolean
  pricingRowCount: number
  importedWeddingCount: number
  pricingThreshold: 5
  weddingsThreshold: 1
}

export async function evaluateDay3Readiness(
  supabase: SupabaseClient,
  venueId: string,
): Promise<Day3Readiness> {
  // Manual pricing-history rows. Filter on source_provenance to skip
  // trigger-fired rows (which would otherwise let a venue with one
  // base_price bump count as "5 manual rows").
  const { count: pricingCount } = await supabase
    .from('pricing_history')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .in('source_provenance', ['manual_form', 'manual_csv'])

  const { count: weddingsCount } = await supabase
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .eq('confidence_flag', 'imported_medium')

  const pricingRowCount = pricingCount ?? 0
  const importedWeddingCount = weddingsCount ?? 0
  return {
    ready: pricingRowCount >= 5 && importedWeddingCount >= 1,
    pricingRowCount,
    importedWeddingCount,
    pricingThreshold: 5,
    weddingsThreshold: 1,
  }
}
