import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * POST /api/portal/invite-couple
 *
 * Sends an invitation email to a couple with their event code and
 * registration link. For now, logs the email content (no email service
 * wired yet). Updates wedding.couple_invited_at.
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
    const subject = `Welcome to your ${venue.name} wedding portal!`
    const htmlBody = `
      <h2>Hi ${coupleName}!</h2>
      <p>Congratulations on your upcoming wedding at <strong>${venue.name}</strong>!</p>
      <p>We've set up a personal planning portal just for you. It includes:</p>
      <ul>
        <li>Sage, your AI wedding concierge — available 24/7</li>
        <li>Budget tracking, guest list, seating chart, timeline builder</li>
        <li>Direct messaging with your coordinator</li>
        <li>Your own wedding website builder</li>
      </ul>
      <p><strong>Your event code: ${eventCode}</strong></p>
      <p><a href="${registerUrl}" style="display:inline-block;padding:12px 24px;background:#7D8471;color:white;text-decoration:none;border-radius:8px;">Set Up Your Account</a></p>
      <p>Or visit ${registerUrl} and enter your code.</p>
      <p>We can't wait to help you plan your perfect day!</p>
      <p>— The team at ${venue.name}</p>
    `

    // TODO: Wire real email service (Resend/SendGrid)
    // For now, log the email so it's visible in Vercel logs
    console.log('[INVITE EMAIL]', {
      to: [email, partnerEmail].filter(Boolean),
      subject,
      html: htmlBody,
      registerUrl,
      eventCode,
    })

    // Update wedding record
    await supabase
      .from('weddings')
      .update({ couple_invited_at: new Date().toISOString() })
      .eq('id', weddingId)

    return NextResponse.json({ success: true, registerUrl, eventCode })
  } catch (err) {
    console.error('[INVITE EMAIL ERROR]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
