/**
 * Bloom House: Follow-Up Sequence Engine
 *
 * Tracks where each lead is in an automated follow-up sequence and
 * generates appropriate follow-up drafts when they come due.
 *
 * Sequence logic (v1, hardcoded):
 *   Day 3  → Gentle check-in
 *   Day 7  → Warmer, adds value
 *   Day 14 → Final follow-up, leave the door open
 *
 * Designed to run as a cron job via processAllVenueFollowUps().
 */

import { createServiceClient } from '@/lib/supabase/service'
import { generateFollowUp } from './inquiry-brain'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SequenceStep {
  daysSinceLastContact: number
  type: string
}

export interface FollowUpDue {
  weddingId: string
  contactEmail: string
  daysSinceLastContact: number
  sequenceStep: number
  followUpType: string
}

export interface FollowUpStatus {
  currentStep: number
  nextStepDue: string | null
  followUpsSent: number
  maxFollowUps: number
  complete: boolean
}

// ---------------------------------------------------------------------------
// Sequence definition (v1 — hardcoded)
// ---------------------------------------------------------------------------

const INQUIRY_SEQUENCE: SequenceStep[] = [
  { daysSinceLastContact: 3, type: 'follow_up_3_day' },
  { daysSinceLastContact: 7, type: 'follow_up_7_day' },
  { daysSinceLastContact: 14, type: 'follow_up_final' },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Calculate days between a timestamp and now.
 */
function daysSince(isoTimestamp: string): number {
  const then = new Date(isoTimestamp)
  const now = new Date()
  return Math.floor((now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24))
}

/**
 * Calculate a future date string from now.
 */
function daysFromNowDate(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

// ---------------------------------------------------------------------------
// 1. checkFollowUpsDue
// ---------------------------------------------------------------------------

/**
 * Scans all inquiry/tour_scheduled weddings for a venue and determines
 * which ones are due for a follow-up based on the sequence definition.
 *
 * Checks:
 *   - Days since last outbound interaction
 *   - How many follow-ups have already been sent (from drafts)
 *   - Whether max_follow_ups has been reached (from venue_ai_config)
 *   - Whether the next sequence step is due
 */
export async function checkFollowUpsDue(
  venueId: string
): Promise<FollowUpDue[]> {
  const supabase = createServiceClient()

  // Get venue max_follow_ups setting
  const { data: aiConfig } = await supabase
    .from('venue_ai_config')
    .select('max_follow_ups')
    .eq('venue_id', venueId)
    .single()

  const maxFollowUps = (aiConfig?.max_follow_ups as number) ?? INQUIRY_SEQUENCE.length

  // Get all active inquiry/tour_scheduled weddings
  const { data: weddings, error: weddingsError } = await supabase
    .from('weddings')
    .select('id, status')
    .eq('venue_id', venueId)
    .in('status', ['inquiry', 'tour_scheduled'])

  if (weddingsError || !weddings || weddings.length === 0) {
    return []
  }

  const due: FollowUpDue[] = []

  for (const wedding of weddings) {
    const weddingId = wedding.id as string

    // Get the contact email for this wedding
    const { data: contact } = await supabase
      .from('contacts')
      .select('email')
      .eq('wedding_id', weddingId)
      .eq('is_primary', true)
      .limit(1)
      .single()

    // Fall back to people table if no primary contact
    let contactEmail = (contact?.email as string) ?? null
    if (!contactEmail) {
      const { data: person } = await supabase
        .from('people')
        .select('email')
        .eq('wedding_id', weddingId)
        .not('email', 'is', null)
        .limit(1)
        .single()

      contactEmail = (person?.email as string) ?? null
    }

    if (!contactEmail) continue

    // Get the last outbound interaction
    const { data: lastOutbound } = await supabase
      .from('interactions')
      .select('timestamp')
      .eq('wedding_id', weddingId)
      .eq('direction', 'outbound')
      .order('timestamp', { ascending: false })
      .limit(1)
      .single()

    if (!lastOutbound?.timestamp) continue

    const daysSinceContact = daysSince(lastOutbound.timestamp as string)

    // Count follow-up drafts already generated for this wedding
    const { count: followUpCount } = await supabase
      .from('drafts')
      .select('id', { count: 'exact', head: true })
      .eq('wedding_id', weddingId)
      .like('context_type', 'follow_up_%')

    const sent = followUpCount ?? 0

    // Check if max reached
    if (sent >= maxFollowUps) continue

    // Determine which sequence step they're at
    const nextStepIndex = sent // 0-indexed: 0 = first follow-up, 1 = second, etc.
    if (nextStepIndex >= INQUIRY_SEQUENCE.length) continue

    const nextStep = INQUIRY_SEQUENCE[nextStepIndex]

    // Is this step due?
    if (daysSinceContact >= nextStep.daysSinceLastContact) {
      due.push({
        weddingId,
        contactEmail,
        daysSinceLastContact: daysSinceContact,
        sequenceStep: nextStepIndex + 1,
        followUpType: nextStep.type,
      })
    }
  }

  return due
}

// ---------------------------------------------------------------------------
// 2. generateFollowUps
// ---------------------------------------------------------------------------

/**
 * Checks which follow-ups are due for a venue, then generates draft
 * emails for each one. Inserts drafts with status='pending'.
 *
 * Returns the number of drafts generated.
 */
export async function generateFollowUps(venueId: string): Promise<number> {
  const dueFollowUps = await checkFollowUpsDue(venueId)

  if (dueFollowUps.length === 0) {
    console.log(`[follow-ups] No follow-ups due for venue ${venueId}`)
    return 0
  }

  const supabase = createServiceClient()
  let generated = 0

  for (const followUp of dueFollowUps) {
    try {
      // Skip follow-up if the couple is actively engaged.
      // If they've sent a message or completed a checklist item in the last 3 days,
      // they don't need a nudge — they're already in the conversation.
      const threeDaysAgo = new Date()
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3)
      const recentCutoff = threeDaysAgo.toISOString()

      const [recentMessages, recentChecklist] = await Promise.all([
        supabase
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('wedding_id', followUp.weddingId)
          .gte('created_at', recentCutoff),
        supabase
          .from('checklist_items')
          .select('id', { count: 'exact', head: true })
          .eq('wedding_id', followUp.weddingId)
          .eq('completed', true)
          .gte('updated_at', recentCutoff),
      ])

      const messageCount = recentMessages.count ?? 0
      const checklistCount = recentChecklist.count ?? 0

      if (messageCount > 0 || checklistCount > 0) {
        console.log(
          `[follow-ups] Skipping wedding ${followUp.weddingId} — couple is actively engaged ` +
            `(${messageCount} messages, ${checklistCount} checklist items in last 3 days)`
        )
        continue
      }

      // Generate the follow-up draft via inquiry brain
      const result = await generateFollowUp({
        venueId,
        contactEmail: followUp.contactEmail,
        weddingId: followUp.weddingId,
        daysSinceLastContact: followUp.daysSinceLastContact,
      })

      // Insert the draft
      const { error } = await supabase.from('drafts').insert({
        venue_id: venueId,
        wedding_id: followUp.weddingId,
        contact_email: followUp.contactEmail,
        context_type: followUp.followUpType,
        status: 'pending',
        body: result.draft,
        confidence_score: result.confidence,
        ai_cost: result.cost,
        tokens_used: result.tokensUsed,
      })

      if (error) {
        console.error(
          `[follow-ups] Failed to insert draft for wedding ${followUp.weddingId}:`,
          error.message
        )
        continue
      }

      generated++
      console.log(
        `[follow-ups] Generated ${followUp.followUpType} for wedding ${followUp.weddingId} ` +
          `(step ${followUp.sequenceStep}, ${followUp.daysSinceLastContact} days since contact)`
      )
    } catch (err) {
      console.error(
        `[follow-ups] Error generating follow-up for wedding ${followUp.weddingId}:`,
        err
      )
    }
  }

  console.log(
    `[follow-ups] Generated ${generated}/${dueFollowUps.length} follow-ups for venue ${venueId}`
  )
  return generated
}

// ---------------------------------------------------------------------------
// 3. processAllVenueFollowUps
// ---------------------------------------------------------------------------

/**
 * Runs follow-up generation for all active venues.
 * Designed to be called from the cron route.
 */
export async function processAllVenueFollowUps(): Promise<
  Record<string, number>
> {
  const supabase = createServiceClient()

  const { data: venues, error } = await supabase
    .from('venues')
    .select('id, name')

  if (error || !venues || venues.length === 0) {
    console.warn('[follow-ups] No venues found')
    return {}
  }

  const results: Record<string, number> = {}

  for (const venue of venues) {
    const id = venue.id as string
    const name = (venue.name as string) ?? id

    try {
      const count = await generateFollowUps(id)
      results[id] = count
      if (count > 0) {
        console.log(`[follow-ups] ${name}: ${count} follow-ups generated`)
      }
    } catch (err) {
      console.error(`[follow-ups] Failed for venue ${name}:`, err)
      results[id] = 0
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// 4. getFollowUpStatus
// ---------------------------------------------------------------------------

/**
 * Returns where a specific lead is in the follow-up sequence.
 */
export async function getFollowUpStatus(
  venueId: string,
  weddingId: string
): Promise<FollowUpStatus> {
  const supabase = createServiceClient()

  // Get venue max_follow_ups setting
  const { data: aiConfig } = await supabase
    .from('venue_ai_config')
    .select('max_follow_ups')
    .eq('venue_id', venueId)
    .single()

  const maxFollowUps = (aiConfig?.max_follow_ups as number) ?? INQUIRY_SEQUENCE.length

  // Count follow-up drafts for this wedding
  const { count: followUpCount } = await supabase
    .from('drafts')
    .select('id', { count: 'exact', head: true })
    .eq('wedding_id', weddingId)
    .like('context_type', 'follow_up_%')

  const sent = followUpCount ?? 0
  const currentStep = sent // 0 = no follow-ups sent yet

  // Determine if complete
  const complete = sent >= maxFollowUps || sent >= INQUIRY_SEQUENCE.length

  // Calculate next step due date
  let nextStepDue: string | null = null

  if (!complete && currentStep < INQUIRY_SEQUENCE.length) {
    // Get the last outbound interaction to calculate from
    const { data: lastOutbound } = await supabase
      .from('interactions')
      .select('timestamp')
      .eq('wedding_id', weddingId)
      .eq('direction', 'outbound')
      .order('timestamp', { ascending: false })
      .limit(1)
      .single()

    if (lastOutbound?.timestamp) {
      const lastDate = new Date(lastOutbound.timestamp as string)
      const nextStep = INQUIRY_SEQUENCE[currentStep]
      const daysSinceContact = daysSince(lastOutbound.timestamp as string)
      const daysUntilDue = nextStep.daysSinceLastContact - daysSinceContact

      if (daysUntilDue > 0) {
        nextStepDue = daysFromNowDate(daysUntilDue)
      } else {
        // Already due
        nextStepDue = new Date().toISOString().split('T')[0]
      }
    }
  }

  return {
    currentStep,
    nextStepDue,
    followUpsSent: sent,
    maxFollowUps,
    complete,
  }
}
