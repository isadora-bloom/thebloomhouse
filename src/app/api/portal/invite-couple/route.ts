import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { sendEmail } from '@/lib/services/email'
import {
  getPlatformAuth,
  assertCanAccessVenue,
  unauthorized,
  forbidden,
} from '@/lib/api/auth-helpers'

/**
 * POST /api/portal/invite-couple
 *
 * Sends an invitation email to a couple with their event code and
 * registration link via Resend. White-label:
 *   - Display name on the envelope = venue's business name so couples see
 *     "Rixey Manor" in their inbox, not "The Bloom House".
 *   - replyTo = venue's coordinator email so any reply goes to the venue,
 *     not to Bloom.
 *   - Header background + button colour come from venue_config.primary_color.
 *   - Venue logo embedded in the header when venue_config.logo_url is set.
 *   - AI assistant name in body copy comes from venue_ai_config.ai_name.
 *   - No "Powered by The Bloom House" footer — couples shouldn't know Bloom
 *     exists.
 *
 * Infrastructure carry-forward: the full envelope address is still
 * Bloom's verified Resend domain (the brand domain is thebloomhouse.AI).
 * Fully custom `from@venue.com` needs each venue to verify their own
 * domain in Resend — tracked as infra work, not a Phase 2 blocker.
 */
export async function POST(request: NextRequest) {
  try {
    // Auth gate. Pre-fix this route would send a Resend-billed branded
    // invitation email to any address with any eventCode against any
    // venue's branding, AND stamp couple_invited_at on any wedding.
    // Resend-quota abuse + impersonation surface. Per 2026-05-06 audit
    // Lens 1.
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()

    const body = await request.json()
    const { weddingId, venueId: requestedVenueId, email, partnerEmail, eventCode, coupleName } = body

    if (!weddingId || !email || !eventCode) {
      return NextResponse.json(
        { error: 'Missing required fields: weddingId, email, eventCode' },
        { status: 400 }
      )
    }

    const supabase = createServiceClient()

    // Derive venueId from the wedding row, not from the request body.
    // Then verify auth ownership.
    const { data: wedding } = await supabase
      .from('weddings')
      .select('venue_id')
      .eq('id', weddingId)
      .maybeSingle()

    if (!wedding) {
      return NextResponse.json({ error: 'Wedding not found' }, { status: 404 })
    }

    const venueId = wedding.venue_id as string
    const decision = await assertCanAccessVenue(auth, venueId)
    if (!decision.ok) return forbidden(`wedding ${decision.reason}`)
    // If the caller supplied venueId, it MUST match the wedding's
    // venue_id (catches client-side bugs without breaking the contract).
    if (requestedVenueId && requestedVenueId !== venueId) {
      return NextResponse.json(
        { error: 'venueId does not match wedding owner' },
        { status: 400 }
      )
    }

    // Pull venue + branding + AI name in one round trip.
    const [{ data: venue }, { data: venueConfig }, { data: aiConfig }] = await Promise.all([
      supabase.from('venues').select('name, slug').eq('id', venueId).maybeSingle(),
      supabase
        .from('venue_config')
        .select(
          'business_name, coordinator_name, coordinator_email, logo_url, primary_color, portal_tagline'
        )
        .eq('venue_id', venueId)
        .maybeSingle(),
      supabase
        .from('venue_ai_config')
        .select('ai_name')
        .eq('venue_id', venueId)
        .maybeSingle(),
    ])

    if (!venue) {
      return NextResponse.json({ error: 'Venue not found' }, { status: 404 })
    }

    const businessName = venueConfig?.business_name || venue.name
    const coordinatorEmail = venueConfig?.coordinator_email || undefined
    const coordinatorName = venueConfig?.coordinator_name || undefined
    const logoUrl = venueConfig?.logo_url || null
    const primaryColor = venueConfig?.primary_color || '#7D8471'
    const tagline = venueConfig?.portal_tagline || 'Your wedding planning portal'
    // T5-β.1: refuse to send an invite that would brand-leak as "Sage"
    // when the venue hasn't named their AI yet.
    const resolvedAiName = (aiConfig?.ai_name as string | null | undefined)?.trim()
    if (!resolvedAiName) {
      return NextResponse.json(
        {
          error:
            'Cannot send invite: venue_ai_config.ai_name is not set. Run onboarding for this venue first.',
        },
        { status: 400 }
      )
    }
    const aiName = resolvedAiName

    const portalUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://bloom-house-iota.vercel.app'}/couple/${venue.slug}`
    const registerUrl = `${portalUrl}/register?code=${eventCode}`

    const subject = `You've been invited to your ${businessName} wedding portal`
    const recipients = [email, partnerEmail].filter(Boolean) as string[]
    // Fall back to partner1's first name when the caller didn't pass one
    // through. A bare "there" at the top of a personal invitation reads
    // like a mail-merge template that wasn't filled out.
    const safeCoupleName = coupleName?.trim() || 'there'

    // Sender display name = the venue. Envelope address stays on Bloom's
    // verified domain (the RESEND sender for all transactional mail) but
    // the couple's mail client shows the venue as the From line.
    const envelopeAddress = process.env.EMAIL_FROM?.match(/<([^>]+)>/)?.[1]
      || process.env.EMAIL_FROM
      || 'hello@thebloomhouse.ai'
    const fromHeader = `${businessName} <${envelopeAddress}>`

    // White-label email body. No references to Bloom anywhere a couple
    // can see.
    const logoBlock = logoUrl
      ? `<img src="${logoUrl}" alt="${businessName}" style="max-height:44px;display:block;margin-bottom:12px;" />`
      : `<h1 style="margin:0;font-size:22px;font-weight:600;color:#FFFFFF;font-family:Georgia,serif;">${businessName}</h1>`

    const signOffLine = coordinatorName
      ? `${coordinatorName}<br/><span style="color:rgba(0,0,0,0.6);font-weight:400;">${businessName}</span>`
      : businessName

    const htmlBody = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#FDFAF6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#2D2D2D;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#FFFFFF;border-radius:8px;overflow:hidden;">
    <tr>
      <td style="background:${primaryColor};padding:28px;">
        ${logoBlock}
        <p style="margin:6px 0 0;font-size:14px;color:rgba(255,255,255,0.85);">
          ${tagline}
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:28px;">
        <h2 style="margin:0 0 12px;font-size:20px;">Hi ${safeCoupleName},</h2>
        <p style="margin:0 0 14px;font-size:15px;line-height:1.55;">
          You've been invited to your wedding planning portal at <strong>${businessName}</strong>.
          It includes ${aiName} (your AI wedding concierge), budget tracking, guest list,
          seating chart, timeline builder, and direct messaging with your coordinator.
        </p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.55;">
          Your event code: <strong style="font-family:monospace;background:#F3F4F6;padding:2px 8px;border-radius:4px;">${eventCode}</strong>
        </p>
        <p style="margin:0 0 24px;">
          <a href="${registerUrl}" style="display:inline-block;padding:12px 24px;background:${primaryColor};color:#FFFFFF;text-decoration:none;border-radius:8px;font-weight:600;">
            Set up your account
          </a>
        </p>
        <p style="margin:0 0 12px;font-size:13px;color:#6B7280;">
          Or visit <a href="${registerUrl}" style="color:${primaryColor};">${registerUrl}</a> and enter your code.
        </p>
        <p style="margin:0 0 24px;font-size:13px;color:#6B7280;">
          This invitation link expires in 14 days. If you have any trouble, just reply to this email.
        </p>
        <p style="margin:0;font-size:14px;line-height:1.55;color:#2D2D2D;">
          ${signOffLine}
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:20px 28px;border-top:1px solid #F3F4F6;">
        <p style="margin:0;font-size:12px;color:#6B7280;text-align:center;">
          ${businessName}
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`

    const emailResult = await sendEmail({
      to: recipients,
      subject,
      html: htmlBody,
      from: fromHeader,
      replyTo: coordinatorEmail,
    })

    if (!emailResult.ok) {
      console.error('[invite-couple] Failed to send invitation email:', emailResult.error)
    } else {
      console.log(
        `[invite-couple] Sent invitation to ${recipients.join(', ')} (id: ${emailResult.id ?? 'n/a'})`
      )
    }

    await supabase
      .from('weddings')
      .update({ couple_invited_at: new Date().toISOString() })
      .eq('id', weddingId)

    return NextResponse.json({
      success: true,
      registerUrl,
      eventCode,
      emailSent: emailResult.ok,
      emailError: emailResult.ok ? undefined : emailResult.error,
    })
  } catch (err) {
    console.error('[INVITE EMAIL ERROR]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
