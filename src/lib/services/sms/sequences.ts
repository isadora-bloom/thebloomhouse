/**
 * Bloom House: SMS Sequence Runner
 *
 * Pattern 9 W2: voice-channel parity. Mirrors
 * src/lib/services/email/follow-up-sequences.ts but for the SMS path.
 *
 * Three SMS trigger types (mig 318 extended follow_up_sequences):
 *
 *   sms_no_reply       . couple sent inbound SMS, venue replied, then
 *                         silence for N hours (config: hours_after)
 *   sms_tour_reminder  . outbound SMS reminder T-N hours before tour
 *                         (config: hours_before_tour)
 *   sms_post_tour      . post-tour SMS check-in for SMS-only leads
 *                         (config: hours_after_tour)
 *
 * Cadence: SMS expects faster response than email. The cron tick for this
 * runner is every 15 minutes (configured in vercel.json / cron/route.ts as
 * job='sms_sequences'). Trigger windows default to hours, not days.
 *
 * IMPORTANT DEFERRAL: the actual SMS send path doesn't exist yet
 * (BLOOM-PATTERNS-ZOOM-OUT.md P6 routability guard noted this). For now,
 * the runner generates a Haiku draft and lands it in pending_sms_drafts
 * with status='pending' + reason='sequence'. The operator hits Send
 * manually from the coordinator surface. When P6 lands, this is the
 * point where status='auto_send_pending' + a 5-min cancellation window
 * would engage.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { generateSmsDraft, SMS_BRAIN_PROMPT_VERSION } from './draft-brain'
import type { SmsInteractionRow } from './draft-brain'
import { createNotification } from '@/lib/services/admin-notifications'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SmsTriggerType = 'sms_no_reply' | 'sms_tour_reminder' | 'sms_post_tour'

const SMS_TRIGGERS: ReadonlyArray<SmsTriggerType> = [
  'sms_no_reply',
  'sms_tour_reminder',
  'sms_post_tour',
]

interface SmsSequenceRow {
  id: string
  venue_id: string
  trigger_type: SmsTriggerType
  trigger_config: Record<string, unknown> | null
  is_active: boolean
}

interface SmsCandidate {
  weddingId: string
  personId: string | null
  toPhone: string
  triggerInteractionId: string | null
  sequence: SmsSequenceRow
  triggerType: SmsTriggerType
}

// ---------------------------------------------------------------------------
// Config readers
// ---------------------------------------------------------------------------

function readHours(
  config: Record<string, unknown> | null | undefined,
  key: string,
  fallback: number,
): number {
  if (!config) return fallback
  const raw = config[key]
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw
  if (typeof raw === 'string') {
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return fallback
}

// ---------------------------------------------------------------------------
// Candidate scanners
// ---------------------------------------------------------------------------

type SupabaseClient = ReturnType<typeof createServiceClient>

/**
 * sms_no_reply candidates. Find weddings where:
 *   - the most recent SMS is an outbound from the venue
 *   - that outbound is >= hours_after old
 *   - the wedding is in an active state (not lost / cancelled / booked /
 *     completed)
 *   - we have not already drafted a sms_no_reply nudge in the last
 *     hours_after window (de-dupe)
 */
async function findNoReplyCandidates(
  supabase: SupabaseClient,
  seq: SmsSequenceRow,
): Promise<SmsCandidate[]> {
  const hoursAfter = readHours(seq.trigger_config, 'hours_after', 24)
  const cutoffMs = Date.now() - hoursAfter * 60 * 60 * 1000
  const cutoffIso = new Date(cutoffMs).toISOString()

  // Pull recent outbound SMS for this venue. We then filter by "last
  // message direction is outbound + happened before cutoff" in memory
  // since Supabase can't express that easily in one query.
  const { data: outboundRows } = await supabase
    .from('interactions')
    .select('id, wedding_id, person_id, from_email, timestamp')
    .eq('venue_id', seq.venue_id)
    .eq('type', 'sms')
    .eq('direction', 'outbound')
    .lte('timestamp', cutoffIso)
    .not('wedding_id', 'is', null)
    .not('from_email', 'is', null)
    .order('timestamp', { ascending: false })
    .limit(500)

  if (!outboundRows || outboundRows.length === 0) return []

  // Dedup to one row per (wedding_id, phone). the most recent.
  const seen = new Set<string>()
  const candidates: SmsCandidate[] = []

  for (const r of outboundRows as Array<{
    id: string
    wedding_id: string
    person_id: string | null
    from_email: string | null
    timestamp: string | null
  }>) {
    if (!r.wedding_id || !r.from_email) continue
    const key = `${r.wedding_id}::${r.from_email}`
    if (seen.has(key)) continue
    seen.add(key)

    // Verify this outbound is actually the latest message on the thread.
    // If a more recent inbound exists, the couple replied; skip.
    const { data: latest } = await supabase
      .from('interactions')
      .select('direction, timestamp')
      .eq('venue_id', seq.venue_id)
      .eq('type', 'sms')
      .eq('from_email', r.from_email)
      .order('timestamp', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!latest || latest.direction !== 'outbound') continue

    // Wedding state check.
    const { data: w } = await supabase
      .from('weddings')
      .select('status, ai_opted_out, lost_at, booked_at')
      .eq('id', r.wedding_id)
      .maybeSingle()
    if (!w) continue
    if ((w.ai_opted_out as boolean | null) === true) continue
    const status = w.status as string | null
    if (
      status === 'lost' ||
      status === 'cancelled' ||
      status === 'completed' ||
      status === 'booked' ||
      !!w.lost_at ||
      !!w.booked_at
    ) {
      continue
    }

    // Dedup: skip if we already fired sms_no_reply on this thread within
    // the cutoff window.
    const { count: priorCount } = await supabase
      .from('pending_sms_drafts')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', seq.venue_id)
      .eq('to_phone', r.from_email)
      .eq('sequence_type', 'sms_no_reply')
      .gte('created_at', cutoffIso)
    if ((priorCount ?? 0) > 0) continue

    candidates.push({
      weddingId: r.wedding_id,
      personId: r.person_id ?? null,
      toPhone: r.from_email,
      triggerInteractionId: r.id,
      sequence: seq,
      triggerType: 'sms_no_reply',
    })
  }

  return candidates
}

/**
 * sms_tour_reminder candidates. Find tours scheduled within the next
 * hours_before_tour window for which:
 *   - the wedding has a phone we can text
 *   - the wedding has preferred_contact_channel = 'sms' OR no email-channel
 *     activity recently (SMS-leaning lead)
 *   - we have not already drafted a tour reminder for this tour
 */
async function findTourReminderCandidates(
  supabase: SupabaseClient,
  seq: SmsSequenceRow,
): Promise<SmsCandidate[]> {
  const hoursBefore = readHours(seq.trigger_config, 'hours_before_tour', 24)
  const now = Date.now()
  const upperMs = now + hoursBefore * 60 * 60 * 1000
  const upperIso = new Date(upperMs).toISOString()
  const lowerIso = new Date(now).toISOString()

  const { data: tours } = await supabase
    .from('tours')
    .select('id, wedding_id, scheduled_at, outcome')
    .eq('venue_id', seq.venue_id)
    .gte('scheduled_at', lowerIso)
    .lte('scheduled_at', upperIso)
    .or('outcome.is.null,outcome.eq.pending')
    .not('wedding_id', 'is', null)
    .limit(200)

  if (!tours || tours.length === 0) return []

  const candidates: SmsCandidate[] = []
  for (const t of tours as Array<{
    id: string
    wedding_id: string
    scheduled_at: string | null
    outcome: string | null
  }>) {
    // Find a phone for this wedding (people.phone).
    const { data: peopleRows } = await supabase
      .from('people')
      .select('id, phone, preferred_contact_channel')
      .eq('wedding_id', t.wedding_id)
      .not('phone', 'is', null)
      .limit(5)

    if (!peopleRows || peopleRows.length === 0) continue

    const phoneRow = (peopleRows as Array<{
      id: string
      phone: string | null
      preferred_contact_channel: string | null
    }>).find((r) => !!r.phone)
    if (!phoneRow || !phoneRow.phone) continue

    // Prefer SMS-leaning leads: preferred_contact_channel='sms' or absent.
    // Skip leads that explicitly prefer email. they get the email reminder.
    if (phoneRow.preferred_contact_channel === 'email') continue

    // Dedup: have we already drafted a reminder for this tour?
    const { count: priorCount } = await supabase
      .from('pending_sms_drafts')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', seq.venue_id)
      .eq('to_phone', phoneRow.phone)
      .eq('sequence_type', 'sms_tour_reminder')
      .gte('created_at', lowerIso)
    if ((priorCount ?? 0) > 0) continue

    candidates.push({
      weddingId: t.wedding_id,
      personId: phoneRow.id,
      toPhone: phoneRow.phone,
      triggerInteractionId: null,
      sequence: seq,
      triggerType: 'sms_tour_reminder',
    })
  }

  return candidates
}

/**
 * sms_post_tour candidates. Find tours that completed within the last
 * hours_after_tour window for SMS-leaning leads we haven't yet checked in
 * with via SMS.
 */
async function findPostTourCandidates(
  supabase: SupabaseClient,
  seq: SmsSequenceRow,
): Promise<SmsCandidate[]> {
  const hoursAfter = readHours(seq.trigger_config, 'hours_after_tour', 24)
  const now = Date.now()
  const cutoffMs = now - hoursAfter * 60 * 60 * 1000
  const cutoffIso = new Date(cutoffMs).toISOString()
  const recentIso = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()

  const { data: tours } = await supabase
    .from('tours')
    .select('id, wedding_id, scheduled_at, outcome')
    .eq('venue_id', seq.venue_id)
    .eq('outcome', 'completed')
    .lte('scheduled_at', cutoffIso)
    .gte('scheduled_at', recentIso)
    .not('wedding_id', 'is', null)
    .limit(200)

  if (!tours || tours.length === 0) return []

  const candidates: SmsCandidate[] = []
  for (const t of tours as Array<{
    id: string
    wedding_id: string
    scheduled_at: string | null
  }>) {
    const { data: peopleRows } = await supabase
      .from('people')
      .select('id, phone, preferred_contact_channel')
      .eq('wedding_id', t.wedding_id)
      .not('phone', 'is', null)
      .limit(5)
    if (!peopleRows || peopleRows.length === 0) continue

    const phoneRow = (peopleRows as Array<{
      id: string
      phone: string | null
      preferred_contact_channel: string | null
    }>).find((r) => !!r.phone)
    if (!phoneRow || !phoneRow.phone) continue
    if (phoneRow.preferred_contact_channel === 'email') continue

    // Dedup against any prior post-tour SMS draft for this wedding.
    const { count: priorCount } = await supabase
      .from('pending_sms_drafts')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', seq.venue_id)
      .eq('wedding_id', t.wedding_id)
      .eq('sequence_type', 'sms_post_tour')
    if ((priorCount ?? 0) > 0) continue

    candidates.push({
      weddingId: t.wedding_id,
      personId: phoneRow.id,
      toPhone: phoneRow.phone,
      triggerInteractionId: null,
      sequence: seq,
      triggerType: 'sms_post_tour',
    })
  }

  return candidates
}

// ---------------------------------------------------------------------------
// Conversation loader (mirrors auto-reply.ts version)
// ---------------------------------------------------------------------------

async function loadConversation(
  supabase: SupabaseClient,
  venueId: string,
  phone: string,
): Promise<SmsInteractionRow[]> {
  const { data } = await supabase
    .from('interactions')
    .select('id, direction, body_preview, full_body, timestamp, from_name')
    .eq('venue_id', venueId)
    .eq('type', 'sms')
    .eq('from_email', phone)
    .order('timestamp', { ascending: true })
    .limit(20)

  const rows = (data ?? []) as Array<{
    id: string
    direction: string | null
    body_preview: string | null
    full_body: string | null
    timestamp: string | null
    from_name: string | null
  }>

  return rows.map((r) => ({
    id: r.id,
    direction: r.direction === 'outbound' ? 'outbound' : 'inbound',
    body_preview: r.body_preview,
    full_body: r.full_body,
    timestamp: r.timestamp,
    from_name: r.from_name,
  })) as SmsInteractionRow[]
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

async function emitSmsSequenceDraft(
  supabase: SupabaseClient,
  candidate: SmsCandidate,
): Promise<boolean> {
  let draft
  try {
    const conversation = await loadConversation(
      supabase,
      candidate.sequence.venue_id,
      candidate.toPhone,
    )
    draft = await generateSmsDraft({
      venueId: candidate.sequence.venue_id,
      weddingId: candidate.weddingId,
      conversation,
      reason: 'sequence',
      sequenceType: candidate.triggerType,
    })
  } catch (err) {
    console.warn(
      `[sms-sequences:${candidate.triggerType}] draft generation failed (wedding ${candidate.weddingId}):`,
      err instanceof Error ? err.message : String(err),
    )
    return false
  }

  const { data: inserted, error: insertErr } = await supabase
    .from('pending_sms_drafts')
    .insert({
      venue_id: candidate.sequence.venue_id,
      wedding_id: candidate.weddingId,
      person_id: candidate.personId,
      trigger_interaction_id: candidate.triggerInteractionId,
      to_phone: candidate.toPhone,
      draft_body: draft.draft,
      status: 'pending',
      reason: 'sequence',
      sequence_id: candidate.sequence.id,
      sequence_type: candidate.triggerType,
      confidence_0_100: draft.confidence,
      prompt_version: SMS_BRAIN_PROMPT_VERSION,
      cost: draft.cost,
      tokens_used: draft.tokensUsed,
    })
    .select('id')
    .maybeSingle()

  if (insertErr || !inserted) {
    console.error(
      `[sms-sequences:${candidate.triggerType}] persist failed:`,
      insertErr?.message,
    )
    return false
  }

  const draftId = inserted.id as string

  try {
    await createNotification({
      venueId: candidate.sequence.venue_id,
      weddingId: candidate.weddingId,
      type: 'sms_draft_pending',
      title: `Sage drafted a ${candidate.triggerType} SMS for ${candidate.toPhone}`,
      body: JSON.stringify({
        draftId,
        toPhone: candidate.toPhone,
        sequenceType: candidate.triggerType,
        confidence_0_100: draft.confidence,
        excerpt: draft.draft.slice(0, 200),
      }),
      priority: 'normal',
    })
  } catch {
    // Non-fatal.
  }

  console.log(
    `[sms-sequences:${candidate.triggerType}] Generated draft for wedding ${candidate.weddingId} -> ${candidate.toPhone}`,
  )
  return true
}

// ---------------------------------------------------------------------------
// Per-venue + fan-out
// ---------------------------------------------------------------------------

/**
 * Evaluate every active SMS sequence for one venue. Returns the number of
 * drafts generated.
 */
export async function processSmsSequencesForVenue(
  venueId: string,
): Promise<number> {
  const supabase = createServiceClient()

  const { data: sequences, error } = await supabase
    .from('follow_up_sequences')
    .select('id, venue_id, trigger_type, trigger_config, is_active')
    .eq('venue_id', venueId)
    .eq('channel', 'sms')
    .eq('is_active', true)
    .in('trigger_type', SMS_TRIGGERS as unknown as string[])

  if (error) {
    console.error(
      `[sms-sequences] Failed to load sequences for venue ${venueId}:`,
      error.message,
    )
    return 0
  }
  if (!sequences || sequences.length === 0) return 0

  let generated = 0
  for (const raw of sequences as SmsSequenceRow[]) {
    const seq: SmsSequenceRow = {
      ...raw,
      trigger_config:
        (raw.trigger_config as Record<string, unknown> | null) ?? {},
    }

    let candidates: SmsCandidate[] = []
    try {
      switch (seq.trigger_type) {
        case 'sms_no_reply':
          candidates = await findNoReplyCandidates(supabase, seq)
          break
        case 'sms_tour_reminder':
          candidates = await findTourReminderCandidates(supabase, seq)
          break
        case 'sms_post_tour':
          candidates = await findPostTourCandidates(supabase, seq)
          break
      }
    } catch (err) {
      console.error(
        `[sms-sequences] Candidate scan failed for sequence ${seq.id} (${seq.trigger_type}):`,
        err,
      )
      continue
    }

    for (const c of candidates) {
      try {
        const emitted = await emitSmsSequenceDraft(supabase, c)
        if (emitted) generated++
      } catch (err) {
        console.error(
          `[sms-sequences:${c.triggerType}] Emit failed for wedding ${c.weddingId}:`,
          err,
        )
      }
    }
  }

  return generated
}

/**
 * Fan-out across every venue. Called from the cron route on the 15-min
 * cadence (job='sms_sequences').
 */
export async function processAllVenueSmsSequences(): Promise<
  Record<string, number>
> {
  const supabase = createServiceClient()

  const { data: venues } = await supabase.from('venues').select('id, name')
  if (!venues || venues.length === 0) return {}

  // Cost-ceiling gate: same posture as the email follow-up runner. Paused
  // venues don't burn Haiku calls on drafts that would immediately stall
  // in pending.
  const venueIds = (venues as Array<{ id: string; name: string | null }>).map(
    (v) => v.id,
  )
  const venueNames = new Map<string, string>(
    (venues as Array<{ id: string; name: string | null }>).map((v) => [
      v.id,
      v.name ?? v.id,
    ]),
  )

  const { filterActiveVenues } = await import('@/lib/services/cost-ceiling')
  const { active, skipped } = await filterActiveVenues(venueIds, {
    workType: 'sms_sequences',
  })
  if (skipped.length > 0) {
    console.log(
      `[sms-sequences] Skipping ${skipped.length} paused venue(s); running ${active.length}`,
    )
  }

  const results: Record<string, number> = {}
  for (const id of active) {
    const name = venueNames.get(id) ?? id
    try {
      const count = await processSmsSequencesForVenue(id)
      results[id] = count
      if (count > 0) {
        console.log(`[sms-sequences] ${name}: ${count} drafts generated`)
      }
    } catch (err) {
      console.error(`[sms-sequences] Failed for venue ${name}:`, err)
      results[id] = 0
    }
  }
  return results
}
