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
    | 'crm_import_ui' | 'sage_identity' | 'forbidden_topics' | 'tone_preferences'
    | 'web_form_import_ui' | 'extract_packages_ui' | 'tour_scheduler_import_ui'
    | 'utm_tagging' | 'seed_agencies'
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
    title: 'Connect + Import bookings',
    subtitle: "Wire Gmail in, set Sage's identity + tone + safety rails, import everything you have on your booked couples, THEN pull 12 months of email history.",
    steps: [
      {
        key: 'gmail_oauth',
        label: 'Connect the inquiry Gmail account',
        description:
          'OAuth into the Gmail account that receives venue inquiries. Bloom subscribes to the inbox and starts ingesting new messages immediately. Auto-detects completion when a gmail_connections row goes status=active.',
        actionKey: 'oauth_gmail',
        linkHref: '/agent/settings',
        linkLabel: 'Open Gmail connection',
      },
      {
        key: 'sage_identity',
        label: "Set Sage's name + sending email + escalation address",
        description:
          'Pick the AI assistant name (white-label or Sage default), the email address it sends from, and the escalation address printed in Sage\'s outbound footer for "need a human?" routing. Without these, drafts ship with the brand-leak fallback and the escalation footer falls back silently to coordinator_email. Auto-detects completion when venue_ai_config has ai_name + ai_email + escalation_email all set.',
        actionKey: 'sage_identity',
        linkHref: '/settings/sage-identity',
        linkLabel: 'Open Sage identity',
      },
      {
        key: 'forbidden_topics',
        label: 'Configure forbidden topics',
        description:
          'Per-venue topic keywords that escalate instead of getting drafted (e.g., specific competitor names, sensitive policies, in-flight legal matters). Adds to the global ESCALATION_KEYWORDS set. Auto-detects completion when at least one venue_forbidden_topics row exists for the venue.',
        actionKey: 'forbidden_topics',
        linkHref: '/agent/forbidden-topics',
        linkLabel: 'Open forbidden topics',
      },
      {
        key: 'tone_preferences',
        label: 'Set tone preferences',
        description:
          'Warmth / formality / playfulness / brevity / enthusiasm sliders that shape every Sage draft. Defaults are middling; coordinators dial them in for the venue voice. Auto-detects completion when venue_ai_config has at least one personality slider set away from the default.',
        actionKey: 'tone_preferences',
        linkHref: '/settings/personality',
        linkLabel: 'Open personality',
      },
      {
        // MUST run before the email backfill. The Backwards Tracer
        // anchors on booked couples; if 12 months of email history is
        // ingested before any booked couples exist, reconstruction
        // cold-starts and the email signals have nothing to attach to.
        key: 'crm_export',
        label: 'Upload everything you have on your booked couples',
        description:
          'Import your booked couples FIRST — before the email backfill. Upload a HoneyBook / Dubsado / Aisle Planner export (or the Generic CSV adapter with a column mapping). Include every column your CRM offers: revenue, deposit, booked date, guest count, package — all of it is read and recorded, and any column Bloom has no field for is preserved and surfaced on the Data Fields page. These booked couples are the anchors the whole reconstruction is built from. Imported rows are tagged confidence_flag=imported_medium. Completes once weddings has 1+ row tagged imported_medium.',
        actionKey: 'crm_import_ui',
        linkHref: '/onboarding/crm-import',
        linkLabel: 'Open CRM import',
      },
      {
        key: 'backfill_12mo',
        label: 'Run 12-month email backfill',
        description:
          'Now that your booked couples are in as anchors, pull the last 12 months of inquiry messages, classify, and stamp confidence_flag=imported_low so downstream surfaces know these are backfilled. Run from the Gmail backfill control on Agent settings.',
        actionKey: 'backfill_email',
        linkHref: '/agent/settings',
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
        // Wave 6E — agency tracker. Optional but high-value: lets the
        // TBH Report contrast agency-claimed metrics against Bloom's
        // ground truth. Coordinator skips if they manage marketing
        // in-house. Each registered agency gets engaged with the
        // channels they manage so first-touch attribution rolls up.
        key: 'marketing_agencies',
        label: 'Add marketing agencies you work with',
        description:
          "Optional, but unlocks the TBH Report. If a boutique agency manages any of your channels (Hawthorn, Elite Wedding Marketing, Path & Compass, your in-house Google Ads person, etc.), add them here and tie them to the channels they manage. Bloom contrasts what they claim with what they actually delivered (first-touch leads → tours → bookings). Skip this step if you do all your marketing in-house.",
        actionKey: 'seed_agencies',
        linkHref: '/intel/agencies',
        linkLabel: 'Open marketing agencies',
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
      {
        key: 'web_form_import',
        label: 'Import web-form submissions',
        description:
          'Upload submissions from your own pricing calculator or web form (Rixey calculator, Typeform, Jotform, Google Forms, custom HTML). Each becomes a wedding row + interaction + tangential signal, tagged confidence_flag=imported_high (first-party data). Independent from CRM-import on Day 3 — a venue with both a calculator AND HoneyBook can use both.',
        actionKey: 'web_form_import_ui',
        linkHref: '/onboarding/web-form-import',
        linkLabel: 'Open web-form import',
      },
      {
        // Stream WWW (migration 205): UTM-tracking readiness step.
        // Before the web form starts capturing UTM, the embed code on
        // the venue's site has to actually pass UTM through. Once the
        // landing page preserves them (most paid-ad campaigns auto-tag
        // with utm_source / utm_medium / utm_campaign), every
        // submission lands a wedding row with the original acquisition
        // channel attached — and Bloom's never-overwrite policy keeps
        // it intact through HoneyBook contract import.
        //
        // The actual configuration is one-time HTML / link change on
        // the venue's site, not a Bloom UI surface. Step is informational
        // (linkHref=null) — coordinator marks done after dropping the
        // tracking template into their landing page.
        key: 'utm_tagging',
        label: 'Add UTM tracking to your web form',
        description:
          'Before submissions can carry their original acquisition channel, your landing page or embed code has to preserve UTM parameters from the inbound link. Standard pattern:\n\n  https://yourvenue.com/inquire?utm_source=knot&utm_campaign=storefront\n\nFor Google Ads / Meta Ads, enable auto-tagging at the campaign level — the platforms set the UTM keys for you. Once tagged inquiries start flowing, Bloom captures every UTM key on form submission and preserves it through HoneyBook contract import (never overwrites a non-NULL UTM value), so your Google Ads spend gets credit for the bookings it actually drove.',
        actionKey: 'utm_tagging',
        linkHref: null,
      },
      {
        key: 'tour_scheduler_import',
        label: 'Import tour scheduler history',
        description:
          'Backfill historical tour bookings + post-booking touchpoints from your scheduling tool (Calendly fully supported; Acuity / Square Appointments / generic .ics scaffolded). Each event type is bucketed (tour vs post-booking touchpoint vs service interaction); coordinator overrides per-event-type during preview. Custom Q&A on the booking form (lead source, partner name, guest count, wedding-date hint) auto-routes to the right Bloom field.',
        actionKey: 'tour_scheduler_import_ui',
        linkHref: '/onboarding/tour-scheduler-import',
        linkLabel: 'Open tour scheduler import',
      },
      {
        key: 'extract_packages',
        label: 'Extract package catalog from form schema',
        description:
          'Many venues encode their pricing tiers, upgrades, and discounts inside the form they expose to couples. This one-time extractor walks the form schema and proposes a packages catalog you can confirm with one click. Confirmed packages feed Sage’s pricing context, the temporal-trigger booking-value resolver, and pricing-history reconciliation.',
        actionKey: 'extract_packages_ui',
        linkHref: '/onboarding/extract-packages',
        linkLabel: 'Open package extractor',
      },
    ],
  },
  {
    day: 3,
    title: 'Pricing history + triage',
    subtitle: 'Reconstruct historical pricing and triage anything that did not auto-match. (Booked-couple CRM import moved to Day 1 — it must precede the email backfill.)',
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
        key: 'recover_booked_data',
        label: 'Recover historical booking values',
        description:
          'Walks every booked / completed wedding with missing booking_value and tries three recovery paths: dedup against HoneyBook duplicates, calculator-estimate email extract, and HoneyBook export-payload recover. The daily booked_data_recovery cron handles the bulk; this step surfaces the residual count so the coordinator can mark the unrecoverable ones as coordinator-supplied. (Per-row "Mark coordinator-supplied" affordance lands in a follow-up stream — for now the readiness page links here and shows the count.)',
        actionKey: 'manual',
        // No linkHref yet — the per-row "Mark coordinator-supplied" UI is a
        // follow-up stream. Setting linkHref breaks the onboarding step
        // because /onboarding/recover-booked-data does not exist; the
        // server route at /api/admin/recover-booked-data is service-role
        // only. The cron handles the bulk; this step is informational
        // until the coordinator UI lands.
        linkHref: null,
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
    const { computeBackfillScore } = await import('./backfill')
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
 * T5-followup-Z: detect Day-1 step completion from underlying state.
 *
 * Day-1 sub-steps are quick coordinator actions on other surfaces
 * (Gmail OAuth, Sage identity, forbidden topics, tone). Rather than
 * relying on the coordinator to come back and "Mark done" after each
 * one, we read the live state and auto-mark any step whose downstream
 * row exists.
 *
 * Returns a set of step keys that are auto-detected as complete based
 * on real DB state. Caller merges this into the existing
 * coordinator_notes.day_1 map so the UI shows green checks without
 * forcing the coordinator to revisit each tile.
 *
 * Defensive: any query failure short-circuits to "not complete" for
 * that step. We never falsely mark a step done — the coordinator can
 * always click Mark done manually as a fallback.
 */
export async function detectDay1Completion(
  supabase: SupabaseClient,
  venueId: string,
): Promise<Set<string>> {
  const done = new Set<string>()

  // gmail_oauth — at least one gmail_connections row with status='active'.
  try {
    const { data, error } = await supabase
      .from('gmail_connections')
      .select('id')
      .eq('venue_id', venueId)
      .eq('status', 'active')
      .limit(1)
    if (!error && data && data.length > 0) done.add('gmail_oauth')
  } catch { /* swallow */ }

  // sage_identity — venue_ai_config has ai_name AND ai_email AND
  // escalation_email all set. ai_name has a fallback default ('Sage')
  // so we require ai_email specifically — coordinator must have made
  // an explicit choice for that. Stream EEEE adds escalation_email
  // (migration 206): the address printed in Sage's outbound footer
  // for the "need a human?" route. The renderer falls back to
  // coordinator_email then owner_email at footer-render time, but the
  // step is only marked done when the explicit column is populated —
  // legacy rows without it still need coordinator action.
  try {
    const { data, error } = await supabase
      .from('venue_ai_config')
      .select('ai_name, ai_email, escalation_email')
      .eq('venue_id', venueId)
      .maybeSingle()
    const aiName = (data as { ai_name?: string | null } | null)?.ai_name
    const aiEmail = (data as { ai_email?: string | null } | null)?.ai_email
    const escalationEmail = (data as { escalation_email?: string | null } | null)?.escalation_email
    if (
      !error &&
      aiName && aiName.trim() &&
      aiEmail && aiEmail.trim() &&
      escalationEmail && escalationEmail.trim()
    ) {
      done.add('sage_identity')
    }
  } catch { /* swallow */ }

  // forbidden_topics — at least one venue_forbidden_topics row.
  try {
    const { data, error } = await supabase
      .from('venue_forbidden_topics')
      .select('id')
      .eq('venue_id', venueId)
      .limit(1)
    if (!error && data && data.length > 0) done.add('forbidden_topics')
  } catch { /* swallow — table may not exist on early-stage venues */ }

  // tone_preferences — venue_ai_config has at least one slider set
  // away from the platform defaults (warmth=7, formality=4,
  // playfulness=5, brevity=6, enthusiasm=6 per migration 001).
  try {
    const { data, error } = await supabase
      .from('venue_ai_config')
      .select('warmth_level, formality_level, playfulness_level, brevity_level, enthusiasm_level')
      .eq('venue_id', venueId)
      .maybeSingle()
    if (!error && data) {
      const row = data as Record<string, number | null>
      const defaults = {
        warmth_level: 7,
        formality_level: 4,
        playfulness_level: 5,
        brevity_level: 6,
        enthusiasm_level: 6,
      }
      const tweaked = Object.entries(defaults).some(
        ([k, def]) => row[k] != null && row[k] !== def,
      )
      if (tweaked) done.add('tone_preferences')
    }
  } catch { /* swallow */ }

  // backfill_12mo — relies on coordinator marking done after running
  // the backfill button. We don't have a clean auto-signal for this
  // (sync runs touch many counters); rely on the coordinator action.

  return done
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
