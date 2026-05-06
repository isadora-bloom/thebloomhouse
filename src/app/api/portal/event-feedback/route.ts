import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { callAI } from '@/lib/ai/client'
import {
  getPlatformAuth,
  isDemoVenueAllowed,
  unauthorized,
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

    // Authorization: the authenticated user must have access to the
    // feedback's venue. Demo allowlist applies only to demo cookies.
    // Non-admins must match auth.venueId; admins (org_admin / super_admin)
    // may access any venue (RLS policies on dependent reads add a
    // belt-and-suspenders check).
    const venueId = feedback.venue_id as string
    const isAdmin = auth.role === 'org_admin' || auth.role === 'super_admin'
    if (auth.isDemo) {
      if (!isDemoVenueAllowed(venueId)) {
        return NextResponse.json(
          { error: 'Forbidden: feedback belongs to a non-demo venue' },
          { status: 403 }
        )
      }
    } else if (!isAdmin && venueId !== auth.venueId) {
      return NextResponse.json(
        { error: 'Forbidden: feedback belongs to another venue' },
        { status: 403 }
      )
    }

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

    // Build the AI prompt
    const systemPrompt = `You are a professional wedding venue coordinator crafting a proactive response draft.
This response is prepared in advance in case the couple leaves a public review.
It should be warm, professional, and empathetic. Acknowledge specific positives from the event.
If there were any issues, acknowledge them gracefully without being defensive.
The tone should match a high-end wedding venue — elegant, personal, and sincere.
Keep the response between 150-250 words.`

    const vendorSummary = (vendorRatings ?? [])
      .map((v: { vendor_name: string; vendor_type: string; rating: number; notes: string | null }) =>
        `- ${v.vendor_name} (${v.vendor_type}): ${v.rating}/5${v.notes ? ` — ${v.notes}` : ''}`
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
- Guest Complaints: ${feedback.guest_complaint_count ?? 0} complaints${feedback.guest_complaints ? ` — ${feedback.guest_complaints}` : ''}

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

Write a warm, professional response that the venue team could use if a review comes in. Start with "Thank you" and address the couple by first names if known.`

    const result = await callAI({
      systemPrompt,
      userPrompt,
      maxTokens: 1000,
      temperature: 0.5,
      venueId,
      taskType: 'review_response_draft',
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
