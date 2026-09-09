/**
 * Bloom House — Post-Tour Nurture Sequence (3-email)
 *
 * Anchor docs (~/.claude memory/):
 *   - bloom-constitution.md (Sage drafts go to coordinator approval;
 *     voice-shape only on sensitive themes; auto-send gated)
 *   - bloom-may19-d6-ship.md (couple-keyed sequencing — one row per
 *     wedding / couple, not per interaction)
 *   - bloom-auto-send-cap-audit.md (per-thread + daily cap enforced by
 *     checkAutoSendEligible; this runner falls through the same gate)
 *   - bloom-house-progress.md (operator gap, 2026-05-27: 12 couples
 *     toured with no automated follow-up)
 *
 * WHAT THIS DOES
 * --------------
 * The platform already classifies tour outcomes (tour_outcome_classifier
 * cron stamps tours.outcome). On the FIRST hourly tick after a tour
 * lands with outcome='completed', this runner upserts a row into
 * post_tour_sequence (migration 376) anchored on the tour's
 * scheduled_at. Subsequent ticks fire 3 drafts on a fixed cadence:
 *
 *   email_1  T+24h   warm thanks + one specific reference
 *   email_2  T+3d    soft check-in ("any questions after your visit?")
 *   email_3  T+7d    nurture + clean off-ramp
 *
 * Each draft lands in the existing `drafts` table with:
 *   - context_type='client'  (the wedding has a tour → past the
 *                             inquiry phase per platform doctrine)
 *   - brain_used='post_tour_sequence'
 *   - follow_up_step='post_tour_email_1' | '_2' | '_3'
 *
 * Then runs checkAutoSendEligible exactly like follow-up-sequences.ts.
 * When eligible, the draft flips to status='auto_send_pending' with a
 * 5-min cancel notification. Otherwise it stays status='pending' for
 * coordinator review.
 *
 * PAUSE LOGIC
 * -----------
 *   - couple replies (any inbound after tour_completed_at) → paused
 *   - wedding status flips to booked / lost / cancelled → completed
 *   - coordinator manual override → paused (set externally)
 *
 * WIRING
 * ------
 * Not registered in vercel.json (Pro at the 40-cron cap). Hooked into
 * the existing hourly `follow_up_sequences` cron handler via
 * processAllVenuePostTourSequences() called from
 * follow-up-sequences.ts::processAllVenueFollowUps.
 *
 * COST
 * ----
 * Up to 3 Sonnet calls per couple over 7 days (~$0.06 worst case). The
 * sequence is gated by cost-ceiling (paused venues skipped) and by
 * the active-engagement skip (3-day in-portal-or-replying window).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { callAI } from '@/lib/ai/client'
import { checkAutoSendEligible } from './autonomous-sender'
import { createNotification } from '../admin-notifications'
import { filterActiveVenues } from '@/lib/services/cost-ceiling'

// ---------------------------------------------------------------------------
// Prompt revision
// ---------------------------------------------------------------------------
//
// PROMPTS-CHANGELOG.md / OPS-21.5.1. Bump when any of the per-step
// tone instructions or the system frame change. v1: initial ship.
export const POST_TOUR_SEQUENCE_PROMPT_VERSION =
  'post-tour-sequence.prompt.v1'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Step = 1 | 2 | 3

interface SequenceRow {
  id: string
  wedding_id: string
  venue_id: string
  tour_id: string | null
  tour_completed_at: string
  email_1_sent_at: string | null
  email_2_sent_at: string | null
  email_3_sent_at: string | null
  email_1_draft_id: string | null
  email_2_draft_id: string | null
  email_3_draft_id: string | null
  paused_at: string | null
  sequence_completed_at: string | null
}

interface CandidateTour {
  id: string
  wedding_id: string
  venue_id: string
  scheduled_at: string
}

interface ContactInfo {
  email: string
  coupleDisplayName: string | null
}

interface VenueVoice {
  aiName: string
  venueName: string
  coordinatorName: string | null
}

interface ProcessVenueResult {
  upserted: number
  drafted: number
  paused: number
  completed: number
  skipped: number
}

const STEP_DELAY_HOURS: Record<Step, number> = {
  1: 24,
  2: 24 * 3,
  3: 24 * 7,
}

const STEP_LABEL: Record<Step, string> = {
  1: 'post_tour_email_1',
  2: 'post_tour_email_2',
  3: 'post_tour_email_3',
}

const WINDOW_DAYS = 14

// ---------------------------------------------------------------------------
// Per-step prompt assembly
// ---------------------------------------------------------------------------

function stepTone(step: Step): string {
  switch (step) {
    case 1:
      return [
        'STEP 1 of 3 — sent ~24 hours after the tour.',
        'Open with a warm thank-you for visiting. Reference ONE specific',
        'detail from the tour or recent interactions (a question they',
        'asked, a vendor they mentioned, the way they responded to a',
        'space). A generic "thanks for coming" is a failure.',
        'Affirm lightly that the venue suits them, without overselling.',
        'Close with a low-friction next step (offer to send a proposal,',
        'hold the date, or just keep the conversation open).',
        'Length: ~120-180 words. Plain prose. No exclamation marks.',
      ].join(' ')
    case 2:
      return [
        'STEP 2 of 3 — sent ~3 days after the tour. Step 1 already',
        'went out. This is a soft check-in.',
        'Open with a brief, no-pressure question: "Any questions after',
        'your visit?" Offer multiple low-effort ways to answer (text,',
        'email, or a quick call / Zoom).',
        'Do NOT repeat the same specific reference from step 1 — pick',
        'a DIFFERENT detail or skip the reference entirely.',
        'Length: ~80-120 words. Plain prose. No exclamation marks.',
        'Do not push for a decision. The goal is to keep the door open.',
      ].join(' ')
    case 3:
      return [
        'STEP 3 of 3 — sent ~7 days after the tour. Final email in',
        'this sequence. Step 2 already went out with no reply.',
        'Open warmly: "just thinking of you." Acknowledge that timing',
        'shapes everything and that no answer is the right answer when',
        'a venue is not the right fit.',
        'Offer a clean off-ramp: explicitly say "if it is not the right',
        'fit, no worries at all, just let us know." Then leave the door',
        'open with one sentence inviting them back when timing is right.',
        'Length: ~80-120 words. Warm, no pressure, no guilt. No exclamation',
        'marks. The goal is graceful exit OR re-engagement, not a close.',
      ].join(' ')
  }
}

function buildSystemPrompt(
  step: Step,
  aiName: string,
  venueName: string,
): string {
  return `You are ${aiName}, the AI coordinator for ${venueName}.

You write personalised follow-up emails after wedding-venue tours. Your
drafts go to the human coordinator for approval BEFORE being sent — you
are not auto-sending. Write the FIRST GOOD DRAFT so the coordinator can
ship in one click or refine in three.

## STEP-SPECIFIC TONE

${stepTone(step)}

## HARD RULES

1. **Warmth via word choice, not punctuation.** No exclamation marks.
2. **No em dashes.** Use commas, periods, or hyphens.
3. **No marketing language.** No "premium", "exclusive", "unforgettable
   experience". Plain prose. The voice is a competent human colleague,
   not a brochure.
4. **No subject prefix.** No "Re:" or "Fwd:" — write a clean subject.
5. **Sign off as the coordinator** when their name is known. Otherwise
   sign off as ${aiName} from ${venueName}.
6. **One specific reference (step 1 only).** Steps 2 and 3 do NOT need
   one — they are nudges, not the warm thanks. Including a reference
   in steps 2/3 is OK only if it is DIFFERENT from step 1.
7. **No preamble.** No "Here's the draft:". No surrounding quotes. No
   markdown fences. Output ONLY the JSON object.

## OUTPUT SCHEMA

Return ONLY this JSON object — no prose preamble, no markdown fences:

{
  "subject": string,
  "body": string,
  "reasoning": string
}

Return ONLY the JSON. No markdown code fences. No prose before or after.`
}

interface UserPromptInput {
  step: Step
  venueName: string
  coupleDisplayName: string | null
  coordinatorName: string | null
  tourCompletedAt: string
  daysSinceTour: number
  briefSummary: string | null
  recentInteractions: Array<{
    direction: 'inbound' | 'outbound'
    subject: string | null
    body_excerpt: string | null
    timestamp: string | null
  }>
  previousEmailSubject: string | null
}

function buildUserPrompt(input: UserPromptInput): string {
  const lines: string[] = []
  lines.push('# POST-TOUR SEQUENCE — DRAFT TO COMPOSE')
  lines.push('')
  lines.push(`Step: ${input.step} of 3`)
  lines.push(`Venue: ${input.venueName}`)
  if (input.coupleDisplayName) {
    lines.push(`Couple: ${input.coupleDisplayName}`)
  }
  if (input.coordinatorName) {
    lines.push(`Coordinator sign-off name: ${input.coordinatorName}`)
  }
  lines.push(`Tour completed at: ${input.tourCompletedAt}`)
  lines.push(`Days since tour: ${input.daysSinceTour}`)
  lines.push('')

  if (input.briefSummary) {
    lines.push('## Tour-prep brief context (Wave 13)')
    lines.push(input.briefSummary)
    lines.push('')
  }

  if (input.previousEmailSubject && input.step > 1) {
    lines.push(
      `## Prior sequence subject: ${input.previousEmailSubject}`,
    )
    lines.push(
      '(Use a DIFFERENT subject for this step — they are a sequence, not a thread reply.)',
    )
    lines.push('')
  }

  if (input.recentInteractions.length > 0) {
    lines.push('## Recent interactions (most-recent-first)')
    for (const ix of input.recentInteractions.slice(0, 6)) {
      lines.push(`### ${ix.direction} @ ${ix.timestamp ?? 'unknown'}`)
      if (ix.subject) lines.push(`subject: ${ix.subject}`)
      if (ix.body_excerpt) {
        const truncated =
          ix.body_excerpt.length > 600
            ? ix.body_excerpt.slice(0, 600) + '\n[...truncated]'
            : ix.body_excerpt
        lines.push('body:')
        lines.push(truncated)
      }
    }
    lines.push('')
  }

  lines.push('Compose the draft now. Return ONLY the JSON object.')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function loadVenueVoice(
  supabase: SupabaseClient,
  venueId: string,
): Promise<VenueVoice> {
  const [ai, venue, cfg] = await Promise.all([
    supabase
      .from('venue_ai_config')
      .select('ai_name')
      .eq('venue_id', venueId)
      .maybeSingle(),
    supabase
      .from('venues')
      .select('name')
      .eq('id', venueId)
      .maybeSingle(),
    supabase
      .from('venue_config')
      .select('coordinator_name')
      .eq('venue_id', venueId)
      .maybeSingle(),
  ])
  const aiName =
    ((ai.data as { ai_name?: string | null } | null)?.ai_name) ?? 'Sage'
  const venueName =
    ((venue.data as { name?: string } | null)?.name) ?? 'the venue'
  const coordinatorName =
    ((cfg.data as { coordinator_name?: string | null } | null)
      ?.coordinator_name) ?? null
  return { aiName, venueName, coordinatorName }
}

async function loadContact(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<ContactInfo | null> {
  // contacts is keyed by person_id with type/value columns, so the old
  // wedding_id + email pre-check never returned a row. people.email is the
  // working source.
  let email: string | null = null
  if (!email) {
    const { data: person } = await supabase
      .from('people')
      .select('email')
      .eq('wedding_id', weddingId)
      .not('email', 'is', null)
      .limit(1)
      .maybeSingle()
    email = (person?.email as string | null) ?? null
  }
  if (!email) return null

  // Couple display name (best-effort).
  const { data: peopleRows } = await supabase
    .from('people')
    .select('first_name, role')
    .eq('wedding_id', weddingId)
    .in('role', ['partner1', 'partner2', 'bride', 'groom', 'partner'])
  const names = ((peopleRows ?? []) as Array<{ first_name: string | null }>)
    .map((p) => (p.first_name ?? '').trim())
    .filter((s) => s.length > 0)
  const coupleDisplayName =
    names.length > 0 ? names.slice(0, 2).join(' & ') : null

  return { email, coupleDisplayName }
}

async function loadBriefSummary(
  supabase: SupabaseClient,
  tourId: string | null,
): Promise<string | null> {
  if (!tourId) return null
  const { data } = await supabase
    .from('tour_prep_briefs')
    .select('brief_jsonb')
    .eq('tour_id', tourId)
    .maybeSingle()
  if (!data) return null
  const brief = (data as { brief_jsonb: Record<string, unknown> }).brief_jsonb
  // Extract the soft fields without leaking sensitive evidence_quote.
  const persona = brief['persona_summary']
  const lead = brief['what_to_lead_with']
  const avoid = brief['what_to_avoid']
  const signals = brief['recent_signals_summary']
  const parts: string[] = []
  if (typeof persona === 'string') parts.push(`persona: ${persona}`)
  if (typeof lead === 'string') parts.push(`what_to_lead_with: ${lead}`)
  if (typeof avoid === 'string') parts.push(`what_to_avoid: ${avoid}`)
  if (typeof signals === 'string') parts.push(`signals: ${signals}`)
  return parts.length > 0 ? parts.join('\n') : null
}

interface InteractionRow {
  direction: string | null
  subject: string | null
  full_body: string | null
  body_preview: string | null
  timestamp: string | null
}

async function loadRecentInteractions(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<UserPromptInput['recentInteractions']> {
  const { data } = await supabase
    .from('interactions')
    .select('direction, subject, full_body, body_preview, timestamp')
    .eq('wedding_id', weddingId)
    .order('timestamp', { ascending: false })
    .limit(6)
  return ((data ?? []) as InteractionRow[]).map((r) => ({
    direction:
      r.direction === 'outbound' ? ('outbound' as const) : ('inbound' as const),
    subject: r.subject,
    body_excerpt: r.full_body ?? r.body_preview ?? null,
    timestamp: r.timestamp,
  }))
}

// ---------------------------------------------------------------------------
// Pause-check helpers
// ---------------------------------------------------------------------------

async function shouldPauseForInbound(
  supabase: SupabaseClient,
  weddingId: string,
  tourCompletedAt: string,
): Promise<boolean> {
  // Any inbound interaction landing AFTER the tour completed is a sign
  // the couple is engaged — humans should take over.
  const { data, error } = await supabase
    .from('interactions')
    .select('id')
    .eq('wedding_id', weddingId)
    .eq('direction', 'inbound')
    .gt('timestamp', tourCompletedAt)
    .limit(1)
  if (error) return false
  return !!data && data.length > 0
}

async function checkTerminalStatus(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<{ terminal: boolean; status: string | null }> {
  const { data } = await supabase
    .from('weddings')
    .select('status')
    .eq('id', weddingId)
    .maybeSingle()
  const status = (data as { status: string | null } | null)?.status ?? null
  // 'booked' is success; 'lost' / 'cancelled' are losses. All terminate
  // the nurture sequence.
  const terminal =
    status === 'booked' ||
    status === 'lost' ||
    status === 'cancelled' ||
    status === 'completed'
  return { terminal, status }
}

// ---------------------------------------------------------------------------
// Step selection
// ---------------------------------------------------------------------------

function nextDueStep(
  row: SequenceRow,
  now: Date,
): Step | null {
  const tourCompletedMs = Date.parse(row.tour_completed_at)
  if (!Number.isFinite(tourCompletedMs)) return null
  const hoursSinceTour = (now.getTime() - tourCompletedMs) / (60 * 60 * 1000)

  // Find the lowest-numbered unsent step whose delay has elapsed.
  for (const step of [1, 2, 3] as const) {
    const sentAt =
      step === 1
        ? row.email_1_sent_at
        : step === 2
          ? row.email_2_sent_at
          : row.email_3_sent_at
    if (sentAt) continue
    if (hoursSinceTour >= STEP_DELAY_HOURS[step]) return step
    // Lower-numbered step still pending its delay → no later step fires
    // either. The sequence is strictly ordered.
    return null
  }
  return null
}

// ---------------------------------------------------------------------------
// Draft generation per step
// ---------------------------------------------------------------------------

interface DraftResult {
  draftId: string | null
  step: Step
  outcome: 'drafted' | 'skipped' | 'errored'
  detail: string
}

async function generateAndStampStep(
  supabase: SupabaseClient,
  row: SequenceRow,
  step: Step,
  now: Date,
): Promise<DraftResult> {
  const venueId = row.venue_id
  const weddingId = row.wedding_id

  // Resolve contact + venue voice + supporting context.
  const [voice, contact, briefSummary, interactions] = await Promise.all([
    loadVenueVoice(supabase, venueId),
    loadContact(supabase, weddingId),
    loadBriefSummary(supabase, row.tour_id),
    loadRecentInteractions(supabase, weddingId),
  ])

  if (!contact) {
    return {
      draftId: null,
      step,
      outcome: 'skipped',
      detail: 'no contact email resolvable',
    }
  }

  // Pull the previously-drafted subject (if any) so the LLM can vary it.
  // Step 2 references step 1; step 3 references the most-recently drafted
  // step (step 2 if present, else step 1).
  let previousEmailSubject: string | null = null
  if (step > 1) {
    const priorDraftId =
      step === 2
        ? row.email_1_draft_id
        : (row.email_2_draft_id ?? row.email_1_draft_id)
    if (priorDraftId) {
      const { data: prior } = await supabase
        .from('drafts')
        .select('subject')
        .eq('id', priorDraftId)
        .maybeSingle()
      previousEmailSubject =
        (prior as { subject: string | null } | null)?.subject ?? null
    }
  }

  const tourCompletedMs = Date.parse(row.tour_completed_at)
  const daysSinceTour = Math.floor(
    (now.getTime() - tourCompletedMs) / (24 * 60 * 60 * 1000),
  )

  const systemPrompt = buildSystemPrompt(step, voice.aiName, voice.venueName)
  const userPrompt = buildUserPrompt({
    step,
    venueName: voice.venueName,
    coupleDisplayName: contact.coupleDisplayName,
    coordinatorName: voice.coordinatorName,
    tourCompletedAt: row.tour_completed_at,
    daysSinceTour,
    briefSummary,
    recentInteractions: interactions,
    previousEmailSubject,
  })

  let aiResult: { text: string; inputTokens: number; outputTokens: number; cost: number }
  try {
    aiResult = await callAI({
      systemPrompt,
      userPrompt,
      tier: 'sonnet',
      taskType: 'post_tour_sequence',
      contentTier: 2,
      promptVersion: POST_TOUR_SEQUENCE_PROMPT_VERSION,
      venueId,
      maxTokens: 1000,
      temperature: 0.4,
    })
  } catch (err) {
    return {
      draftId: null,
      step,
      outcome: 'errored',
      detail: `callAI failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const cleaned = aiResult.text
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .trim()
  let parsed: { subject?: string; body?: string; reasoning?: string }
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return {
      draftId: null,
      step,
      outcome: 'errored',
      detail: 'LLM returned non-JSON',
    }
  }
  const subject = (parsed.subject ?? '').toString().trim()
  const body = (parsed.body ?? '').toString().trim()
  if (!subject || !body) {
    return {
      draftId: null,
      step,
      outcome: 'errored',
      detail: 'LLM output missing subject or body',
    }
  }

  // Insert the draft. context_type='client' because the wedding has a
  // completed tour (past inquiry). brain_used + follow_up_step tag the
  // sequence step so coordinator surfaces can filter / count.
  const { data: draft, error: draftErr } = await supabase
    .from('drafts')
    .insert({
      venue_id: venueId,
      wedding_id: weddingId,
      to_email: contact.email,
      subject,
      draft_body: body,
      status: 'pending',
      context_type: 'client',
      brain_used: 'post_tour_sequence',
      model_used: 'sonnet',
      tokens_used: aiResult.inputTokens + aiResult.outputTokens,
      cost: aiResult.cost,
      confidence_score: 80,
      auto_sent: false,
      follow_up_step: STEP_LABEL[step],
      prompt_version_used: POST_TOUR_SEQUENCE_PROMPT_VERSION,
    })
    .select('id')
    .single()

  if (draftErr || !draft) {
    return {
      draftId: null,
      step,
      outcome: 'errored',
      detail: `drafts insert failed: ${draftErr?.message ?? 'unknown'}`,
    }
  }
  const draftId = (draft as { id: string }).id

  // Stamp the matching email_N_sent_at + email_N_draft_id on the
  // sequence row. We stamp BEFORE the auto-send eligibility check so a
  // crash partway through cannot cause a double-draft next tick.
  const updatePatch: Record<string, unknown> = {}
  if (step === 1) {
    updatePatch.email_1_sent_at = now.toISOString()
    updatePatch.email_1_draft_id = draftId
  } else if (step === 2) {
    updatePatch.email_2_sent_at = now.toISOString()
    updatePatch.email_2_draft_id = draftId
  } else {
    updatePatch.email_3_sent_at = now.toISOString()
    updatePatch.email_3_draft_id = draftId
    // Step 3 sent → sequence complete.
    updatePatch.sequence_completed_at = now.toISOString()
    updatePatch.completed_reason = 'all_emails_sent'
  }
  const { error: stampErr } = await supabase
    .from('post_tour_sequence')
    .update(updatePatch)
    .eq('id', row.id)
  if (stampErr) {
    // We have a draft but the stamp failed. Log loudly — next tick
    // would re-draft. Coordinator surface should flag this.
    console.error(
      `[post-tour-sequence] stamp failed for row ${row.id} step ${step}: ${stampErr.message}`,
    )
  }

  // Fall into the same auto-send gate the inquiry follow-up cron uses.
  try {
    const { data: weddingBlock } = await supabase
      .from('weddings')
      .select('auto_send_blocked_at')
      .eq('id', weddingId)
      .maybeSingle()
    const injectionSuspected = !!weddingBlock?.auto_send_blocked_at

    const eligibility = await checkAutoSendEligible(venueId, {
      contextType: 'client',
      confidenceScore: 80,
      source: 'direct',
      direction: 'inbound',
      weddingId,
      injectionSuspected,
    })

    if (eligibility.eligible) {
      const sendAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString()
      const { error: pendingErr } = await supabase
        .from('drafts')
        .update({
          status: 'auto_send_pending',
          auto_sent: false,
          auto_send_source: 'direct',
          auto_send_attempts: 0,
        })
        .eq('id', draftId)
      if (!pendingErr) {
        await createNotification({
          venueId,
          weddingId,
          type: 'auto_send_pending',
          title: `Auto-sending post-tour ${STEP_LABEL[step]} to ${contact.email} in 5 minutes`,
          body: JSON.stringify({
            draftId,
            toEmail: contact.email,
            subject,
            sendAt,
            confidenceScore: 80,
            source: 'direct',
            followUpStep: STEP_LABEL[step],
          }),
        })
      }
    }
  } catch (eligErr) {
    console.error(
      `[post-tour-sequence] eligibility check failed for wedding ${weddingId} step ${step}:`,
      eligErr,
    )
    // Draft stays in 'pending' for manual approval — fail-safe.
  }

  return {
    draftId,
    step,
    outcome: 'drafted',
    detail: `step ${step} draft created`,
  }
}

// ---------------------------------------------------------------------------
// Per-venue processor
// ---------------------------------------------------------------------------

/**
 * For one venue:
 *   1. Find tours with outcome='completed' in the last WINDOW_DAYS days
 *      whose wedding_id is non-null. Upsert one sequence row per
 *      wedding (skipping weddings whose sequence is already terminal).
 *   2. Load all active sequence rows.
 *   3. For each row, decide the next action:
 *        - terminal wedding status → mark sequence_completed_at
 *        - couple replied inbound after tour → pause
 *        - next step due → generate + stamp draft
 *        - otherwise → noop
 *
 * Returns counts for logging.
 */
export async function processPostTourSequencesForVenue(
  venueId: string,
  now: Date = new Date(),
  supabaseArg?: SupabaseClient,
): Promise<ProcessVenueResult> {
  const supabase = supabaseArg ?? createServiceClient()
  const result: ProcessVenueResult = {
    upserted: 0,
    drafted: 0,
    paused: 0,
    completed: 0,
    skipped: 0,
  }

  const windowStartIso = new Date(
    now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()

  // --- STEP A: upsert candidates ---
  // Pull recent completed tours for this venue. We only want tours whose
  // scheduled_at is in the past (the operator guard: "only act on tours
  // that have ACTUALLY COMPLETED"). The tour_outcome_classifier cron
  // already ensures outcome flips to 'completed' only after the slot
  // has elapsed, but we double-check here to defend against operator-
  // driven manual overrides.
  const nowIso = now.toISOString()
  const { data: tourRows } = await supabase
    .from('tours')
    .select('id, wedding_id, venue_id, scheduled_at')
    .eq('venue_id', venueId)
    .eq('outcome', 'completed')
    .not('wedding_id', 'is', null)
    .gte('scheduled_at', windowStartIso)
    .lte('scheduled_at', nowIso)
    .limit(500)

  const candidates: CandidateTour[] = ((tourRows ?? []) as Array<{
    id: string
    wedding_id: string
    venue_id: string
    scheduled_at: string | null
  }>)
    .filter((t) => !!t.scheduled_at)
    .map((t) => ({
      id: t.id,
      wedding_id: t.wedding_id,
      venue_id: t.venue_id,
      scheduled_at: t.scheduled_at as string,
    }))

  // Deduplicate by wedding (one sequence per wedding even if there are
  // multiple completed tours). Pick the MOST RECENT scheduled_at so the
  // anchor reflects the latest tour walk.
  const latestByWedding = new Map<string, CandidateTour>()
  for (const c of candidates) {
    const existing = latestByWedding.get(c.wedding_id)
    if (
      !existing ||
      Date.parse(c.scheduled_at) > Date.parse(existing.scheduled_at)
    ) {
      latestByWedding.set(c.wedding_id, c)
    }
  }

  // Check which weddings already have a sequence row (any state).
  const wedIds = Array.from(latestByWedding.keys())
  let existingByWedding = new Map<string, SequenceRow>()
  if (wedIds.length > 0) {
    const { data: existingRows } = await supabase
      .from('post_tour_sequence')
      .select(
        'id, wedding_id, venue_id, tour_id, tour_completed_at, ' +
          'email_1_sent_at, email_2_sent_at, email_3_sent_at, ' +
          'email_1_draft_id, email_2_draft_id, email_3_draft_id, ' +
          'paused_at, sequence_completed_at',
      )
      .eq('venue_id', venueId)
      .in('wedding_id', wedIds)
    existingByWedding = new Map(
      ((existingRows ?? []) as unknown as SequenceRow[]).map((r) => [
        r.wedding_id,
        r,
      ]),
    )
  }

  // Upsert: insert any wedding not already tracked.
  for (const [weddingId, candidate] of latestByWedding) {
    if (existingByWedding.has(weddingId)) continue
    const { error } = await supabase
      .from('post_tour_sequence')
      .insert({
        wedding_id: weddingId,
        venue_id: venueId,
        tour_id: candidate.id,
        tour_completed_at: candidate.scheduled_at,
      })
    if (error) {
      // Unique constraint violation: another concurrent run inserted
      // it first. Safe to ignore — next loop iteration will pick it up.
      if (!/duplicate|unique/i.test(error.message)) {
        console.error(
          `[post-tour-sequence] upsert failed for wedding ${weddingId}: ${error.message}`,
        )
      }
      continue
    }
    result.upserted++
  }

  // --- STEP B: load all active sequence rows for this venue ---
  const { data: activeRows } = await supabase
    .from('post_tour_sequence')
    .select(
      'id, wedding_id, venue_id, tour_id, tour_completed_at, ' +
        'email_1_sent_at, email_2_sent_at, email_3_sent_at, ' +
        'email_1_draft_id, email_2_draft_id, email_3_draft_id, ' +
        'paused_at, sequence_completed_at',
    )
    .eq('venue_id', venueId)
    .is('paused_at', null)
    .is('sequence_completed_at', null)
    .gte('tour_completed_at', windowStartIso)
    .order('tour_completed_at', { ascending: true })

  const rows = (activeRows ?? []) as unknown as SequenceRow[]

  // --- STEP C: per-row decision ---
  for (const row of rows) {
    // Terminal-status gate.
    const { terminal, status } = await checkTerminalStatus(supabase, row.wedding_id)
    if (terminal) {
      await supabase
        .from('post_tour_sequence')
        .update({
          sequence_completed_at: now.toISOString(),
          completed_reason: `wedding_status_${status}`,
        })
        .eq('id', row.id)
      result.completed++
      continue
    }

    // Pause gate: any inbound from the couple after tour completion.
    const inboundReply = await shouldPauseForInbound(
      supabase,
      row.wedding_id,
      row.tour_completed_at,
    )
    if (inboundReply) {
      await supabase
        .from('post_tour_sequence')
        .update({
          paused_at: now.toISOString(),
          paused_reason: 'couple_replied_inbound',
        })
        .eq('id', row.id)
      result.paused++
      continue
    }

    // Active-engagement skip (mirrors follow-up-sequences.ts). If the
    // couple sent a portal message or completed a checklist item in the
    // last 3 days, they're already engaged — don't nudge.
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString()
    const [recentMessages, recentChecklist] = await Promise.all([
      supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('wedding_id', row.wedding_id)
        .gte('created_at', threeDaysAgo),
      supabase
        .from('checklist_items')
        .select('id', { count: 'exact', head: true })
        .eq('wedding_id', row.wedding_id)
        .eq('completed', true)
        .gte('updated_at', threeDaysAgo),
    ])
    if ((recentMessages.count ?? 0) > 0 || (recentChecklist.count ?? 0) > 0) {
      result.skipped++
      continue
    }

    // Which step is due?
    const step = nextDueStep(row, now)
    if (step === null) {
      result.skipped++
      continue
    }

    // Generate the draft + stamp the row.
    const dr = await generateAndStampStep(supabase, row, step, now)
    if (dr.outcome === 'drafted') {
      result.drafted++
    } else {
      result.skipped++
      if (dr.outcome === 'errored') {
        console.error(
          `[post-tour-sequence] step ${step} errored for wedding ${row.wedding_id}: ${dr.detail}`,
        )
      }
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// All-venue orchestrator
// ---------------------------------------------------------------------------

/**
 * Cron entry point. Filters paused venues (cost-ceiling) and runs the
 * per-venue processor. Returns per-venue counts for cron-run logging.
 *
 * Wired from src/lib/services/email/follow-up-sequences.ts so the same
 * hourly cron tick that drains the inquiry sequence also drains the
 * post-tour sequence. No new vercel.json entry (Pro at 40-cron cap).
 */
export async function processAllVenuePostTourSequences(
  now: Date = new Date(),
): Promise<Record<string, ProcessVenueResult>> {
  const supabase = createServiceClient()
  const { data: venues, error } = await supabase
    .from('venues')
    .select('id, name')
  if (error || !venues || venues.length === 0) {
    console.warn('[post-tour-sequence] no venues found')
    return {}
  }

  const venueIds = venues.map((v) => v.id as string)
  const venueNames = new Map<string, string>(
    venues.map((v) => [v.id as string, (v.name as string) ?? (v.id as string)]),
  )
  const { active, skipped } = await filterActiveVenues(venueIds, {
    workType: 'post_tour_sequence',
  })
  if (skipped.length > 0) {
    console.log(
      `[post-tour-sequence] Skipping ${skipped.length} paused venue(s); running ${active.length}`,
    )
  }

  const results: Record<string, ProcessVenueResult> = {}
  for (const id of active) {
    const name = venueNames.get(id) ?? id
    try {
      const r = await processPostTourSequencesForVenue(id, now)
      results[id] = r
      if (r.drafted > 0 || r.upserted > 0 || r.paused > 0 || r.completed > 0) {
        console.log(
          `[post-tour-sequence] ${name}: upserted=${r.upserted} ` +
            `drafted=${r.drafted} paused=${r.paused} completed=${r.completed} ` +
            `skipped=${r.skipped}`,
        )
      }
    } catch (err) {
      console.error(`[post-tour-sequence] venue ${name} failed:`, err)
      results[id] = { upserted: 0, drafted: 0, paused: 0, completed: 0, skipped: 0 }
    }
  }
  return results
}
