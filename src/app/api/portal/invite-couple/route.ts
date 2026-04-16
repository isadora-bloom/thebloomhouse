import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { sendEmail } from '@/lib/services/email'

/**
 * POST /api/portal/invite-couple
 *
 * Sends an invitation email to a couple with their event code and
 * registration link via Resend (falls back to console logging in dev if
 * RESEND_API_KEY is not set). Updates wedding.couple_invited_at.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { weddingId, venueId, email, partnerEmail, eventCode, coupleName } = body

    if (!weddingId || !venueId || !email || !eventCode) {
      return NextResponse.json(
        { error: 'Missing required fields: weddingId, venueId, email, eventCode' },
        { status: 400 }
      )
    }

    const supabase = createServiceClient()

    // Get venue details for branding
    const { data: venue } = await supabase
      .from('venues')
      .select('name, slug')
      .eq('id', venueId)
      .single()

    if (!venue) {
      return NextResponse.json({ error: 'Venue not found' }, { status: 404 })
    }

    const portalUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://bloom-house-iota.vercel.app'}/couple/${venue.slug}`
    const registerUrl = `${portalUrl}/register?code=${eventCode}`

    // Email content
    const subject = `You've been invited to your ${venue.name} wedding portal`
    const recipients = [email, partnerEmail].filter(Boolean) as string[]
    const safeCoupleName = coupleName || 'there'
    const htmlBody = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#FDFAF6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#2D2D2D;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#FFFFFF;border-radius:8px;overflow:hidden;">
    <tr>
      <td style="background:#7D8471;padding:28px;">
        <h1 style="margin:0;font-size:22px;font-weight:600;color:#FFFFFF;font-family:Georgia,serif;">
          ${venue.name}
        </h1>
        <p style="margin:6px 0 0;font-size:14px;color:rgba(255,255,255,0.85);">
          Your wedding planning portal
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:28px;">
        <h2 style="margin:0 0 12px;font-size:20px;">Hi ${safeCoupleName},</h2>
        <p style="margin:0 0 14px;font-size:15px;line-height:1.55;">
          You've been invited to your wedding portal at <strong>${venue.name}</strong>.
          It includes Sage (your AI wedding concierge), budget tracking, guest list,
          seating chart, timeline builder, and direct messaging with your coordinator.
        </p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.55;">
          Your event code: <strong style="font-family:monospace;background:#F3F4F6;padding:2px 8px;border-radius:4px;">${eventCode}</strong>
        </p>
        <p style="margin:0 0 24px;">
          <a href="${registerUrl}" style="display:inline-block;padding:12px 24px;background:#7D8471;color:#FFFFFF;text-decoration:none;border-radius:8px;font-weight:600;">
            Set up your account
          </a>
        </p>
        <p style="margin:0 0 12px;font-size:13px;color:#6B7280;">
          Or visit <a href="${registerUrl}" style="color:#7D8471;">${registerUrl}</a> and enter your code.
        </p>
        <p style="margin:0;font-size:13px;color:#6B7280;">
          This invitation link expires in 14 days. If you have any trouble, reply to this email.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:20px 28px;border-top:1px solid #F3F4F6;">
        <p style="margin:0;font-size:12px;color:#6B7280;text-align:center;">
          ${venue.name} &middot; Powered by The Bloom House
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
    })

    if (!emailResult.ok) {
      console.error('[invite-couple] Failed to send invitation email:', emailResult.error)
    } else {
      console.log(
        `[invite-couple] Sent invitation to ${recipients.join(', ')} (id: ${emailResult.id ?? 'n/a'})`
      )
    }

    // Update wedding record
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
