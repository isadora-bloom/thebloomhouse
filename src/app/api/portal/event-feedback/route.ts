import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { callAI } from '@/lib/ai/client'
import { buildCouplePrompt } from '@/lib/ai/couple-prompt'
import {
  getPlatformAuth,
  assertCanAccessVenue,
  unauthorized,
  forbidden,
} from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// POST — Generate proactive review response draft
// Body: { eventFeedbackId } — venueId is derived from the feedback record
// after authorization, NOT trusted from client input. Pre-fix this route
// accepted body.venueId as authoritative; an attacker could pass another
// venue's eventFeedbackId together with their own venueId, causing the
// route to fetch the OTHER venue's feedback and overwrite their
// proactive_response_draft with attacker-controlled AI output (multi-
// tenant write tampering + read leak). Per 2026-05-06 audit (Lens 1).
// Returns: { draft }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()

    // Tier-C #128 — per-user rate limit. callAI fires per request.
    const { checkRateLimit, secondsUntil } = await import('@/lib/rate-limit')
    const rl = await checkRateLimit({
      key: `event-feedback:${auth.userId}`,
      limit: 30,
      windowSec: 60,
    })
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Too many requests, try again in a moment' },
        {
          status: 429,
          headers: { 'Retry-After': String(secondsUntil(rl.resetAt)) },
        },
      )
    }

    const body = await request.json()
    const { eventFeedbackId } = body

    if (!eventFeedbackId) {
      return NextResponse.json(
        { error: 'eventFeedbackId is required' },
        { status: 400 }
      )
    }

    const supabase = createServiceClient()

    // Fetch the feedback record FIRST. We do not trust any client-supplied
    // venueId — venue ownership comes from the row itself.
    const { data: feedback, error: fbErr } = await supabase
      .from('event_feedback')
      .select('*')
      .eq('id', eventFeedbackId)
      .single()

    if (fbErr || !feedback) {
      return NextResponse.json(
        { error: 'Feedback not found' },
        { status: 404 }
      )
    }

    // Authorization: org-aware via assertCanAccessVenue. org_admin
    // bypass is now scoped to their org's venues, not "any venue."
    const venueId = feedback.venue_id as string
    const decision = await assertCanAccessVenue(auth, venueId)
    if (!decision.ok) return forbidden(`feedback ${decision.reason}`)

    // Fetch vendor ratings
    const { data: vendorRatings } = await supabase
      .from('event_feedback_vendors')
      .select('vendor_name, vendor_type, rating, notes, would_recommend')
      .eq('event_feedback_id', eventFeedbackId)

    // Fetch wedding + couple info
    const { data: wedding } = await supabase
      .from('weddings')
      .select('id, wedding_date, guest_count_estimate')
      .eq('id', feedback.wedding_id)
      .single()

    const { data: people } = await supabase
      .from('people')
      .select('first_name, last_name, role')
      .eq('wedding_id', feedback.wedding_id)

    // T5-Rixey-EEE Bug 1 (defense-in-depth): dedupe by name so the
    // notification doesn't list the same human twice.
    const { dedupePeopleByName } = await import('@/lib/utils/couple-name')
    const coupleNames = dedupePeopleByName(
      (people ?? []).filter((p: { role: string }) =>
        ['partner1', 'partner2', 'bride', 'groom', 'partner'].includes(p.role)
      )
    )
      .map((p) => `${p.first_name} ${p.last_name}`)
      .join(' & ')

    // Fetch venue name
    const { data: venue } = await supabase
      .from('venues')
      .select('name')
      .eq('id', venueId)
      .single()

    // Build the AI prompt via the canonical couple-facing assembler so
    // the proactive draft sounds like the same configured concierge the
    // couple already hears in chat / contract Q&A. wedding link is set
    // because partner names + guest count are in scope here.
    const built = await buildCouplePrompt({
      venueId,
      weddingId: feedback.wedding_id as string | null,
      fileContext: null,
      task: 'event_feedback',
      taskInstructions:
        'Draft a proactive response that the venue team can use if the couple posts a public review. Warm, sincere, and specific. Start with "Thank you" and address the couple by first names if known. 150-250 words.',
    })

    const vendorSummary = (vendorRatings ?? [])
      .map((v: { vendor_name: string; vendor_type: string; rating: number; notes: string | null }) =>
        `- ${v.vendor_name} (${v.vendor_type}): ${v.rating}/5${v.notes ? `: ${v.notes}` : ''}`
      )
      .join('\n')

    const userPrompt = `Draft a proactive review response for the following wedding event:

**Venue:** ${venue?.name ?? 'Unknown Venue'}
**Couple:** ${coupleNames || 'Unknown'}
**Date:** ${wedding?.wedding_date ?? 'Unknown'}
**Guest Count:** ${wedding?.guest_count_estimate ?? 'Unknown'}

**Coordinator's Feedback:**
- Overall Rating: ${feedback.overall_rating}/5
- Couple Satisfaction: ${feedback.couple_satisfaction ?? 'Not rated'}/5
- Timeline: ${feedback.timeline_adherence ?? 'Not noted'}
${feedback.delay_notes ? `- Delay Notes: ${feedback.delay_notes}` : ''}
- Guest Complaints: ${feedback.guest_complaint_count ?? 0} complaints${feedback.guest_complaints ? `: ${feedback.guest_complaints}` : ''}

**Catering:**
- Quality: ${feedback.catering_quality ?? 'Not rated'}/5
- Dietary Handling: ${feedback.dietary_handling ?? 'Not rated'}/5
- Service Timing: ${feedback.service_timing ?? 'Not rated'}/5
${feedback.catering_notes ? `- Notes: ${feedback.catering_notes}` : ''}

**Vendor Ratings:**
${vendorSummary || 'No vendor ratings submitted'}

**What Went Well:** ${feedback.what_went_well ?? 'Not provided'}
**What to Change:** ${feedback.what_to_change ?? 'Not provided'}
**Review Readiness:** ${feedback.review_readiness ?? 'Unknown'}

Write a warm, professional response the venue team could use if a review comes in. Start with "Thank you" and address the couple by first names if known.`

    const result = await callAI({
      systemPrompt: built.systemPrompt,
      userPrompt,
      maxTokens: 1000,
      temperature: 0.5,
      venueId,
      taskType: 'review_response_draft',
      contentTier: built.contentTier,
      promptVersion: built.promptVersion,
    })

    // Save the draft to the feedback record
    await supabase
      .from('event_feedback')
      .update({
        proactive_response_draft: result.text,
        updated_at: new Date().toISOString(),
      })
      .eq('id', eventFeedbackId)

    return NextResponse.json({ draft: result.text })
  } catch (err) {
    console.error('[event-feedback] Draft generation failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to generate draft' },
      { status: 500 }
    )
  }
}
