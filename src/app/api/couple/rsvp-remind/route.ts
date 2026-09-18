import { NextResponse } from 'next/server'
import { getCoupleAuth, refuseDemo } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { sendEmail } from '@/lib/services/email/transport'
import { logEvent } from '@/lib/observability/logger'

export const runtime = 'nodejs'

/**
 * POST /api/couple/rsvp-remind
 *
 * The couple asks us to nudge the guests who haven't answered. Their
 * choice, on their guests, in their words. One email per guest who has
 * an address and no answer yet, with the website's RSVP link. Nothing
 * is scheduled and nothing repeats on its own: the couple presses the
 * button each time.
 */
export async function POST(request: Request) {
  const auth = await getCoupleAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const demo = refuseDemo(auth)
  if (demo) return demo

  const body = (await request.json().catch(() => ({}))) as { note?: unknown }
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : ''

  const supabase = createServiceClient()
  const [{ data: site }, { data: wedding }] = await Promise.all([
    supabase
      .from('wedding_website_settings')
      .select('slug, share_token, is_published, couple_names')
      .eq('wedding_id', auth.weddingId)
      .maybeSingle(),
    supabase.from('weddings').select('wedding_date').eq('id', auth.weddingId).maybeSingle(),
  ])
  if (!site?.slug || !site.share_token || !site.is_published) {
    return NextResponse.json(
      { error: 'Your wedding website needs to be published before guests can be reminded, because the reminder links to its RSVP page.' },
      { status: 409 },
    )
  }

  const { data: guests } = await supabase
    .from('guest_list')
    .select('id, first_name, last_name, email, rsvp_status, person:people(first_name, last_name, email)')
    .eq('wedding_id', auth.weddingId)
    .eq('rsvp_status', 'pending')
    .limit(500)

  type Row = {
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
    person: { first_name: string | null; last_name: string | null; email: string | null } | null
  }
  const targets = ((guests ?? []) as unknown as Row[])
    .map((g) => ({
      id: g.id,
      name: `${g.first_name ?? g.person?.first_name ?? ''} ${g.last_name ?? g.person?.last_name ?? ''}`.trim() || 'there',
      email: (g.email ?? g.person?.email ?? '').trim().toLowerCase(),
    }))
    .filter((g) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(g.email))

  const seen = new Set<string>()
  const unique = targets.filter((g) => (seen.has(g.email) ? false : (seen.add(g.email), true)))
  if (unique.length === 0) {
    return NextResponse.json({ sent: 0, skipped: (guests ?? []).length, reason: 'no_addresses' })
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''
  const link = `${appUrl}/w/${encodeURIComponent(site.slug)}?t=${encodeURIComponent(site.share_token)}#rsvp`
  const couple = site.couple_names ?? 'The couple'
  const when = wedding?.wedding_date
    ? new Date(`${wedding.wedding_date}T00:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : null
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

  let sent = 0
  let failed = 0
  for (const g of unique) {
    const html = `
      <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; color: #2A2A28;">
        <p style="font-size: 16px; line-height: 1.6;">Hi ${esc(g.name.split(' ')[0])},</p>
        <p style="font-size: 16px; line-height: 1.6;">A quick note from ${esc(couple)}${when ? `, whose wedding is on ${esc(when)}` : ''}: we haven't heard whether you can make it, and it takes a minute to let us know.</p>
        ${note ? `<p style="font-size: 16px; line-height: 1.6;">${esc(note)}</p>` : ''}
        <p style="margin: 28px 0;">
          <a href="${link}" style="display: inline-block; background: #575C4F; color: #FDFAF6; padding: 14px 32px; border-radius: 999px; text-decoration: none; font-weight: 500;">Reply now</a>
        </p>
        <p style="font-size: 14px; line-height: 1.6; color: #6A7060;">Or copy this link: <a href="${link}" style="color: #575C4F;">${link}</a></p>
      </div>`
    const r = await sendEmail({
      to: g.email,
      subject: `${couple}: can you make it?`,
      html,
      venueId: auth.venueId,
      fromName: couple,
    })
    if (r.ok) sent++
    else failed++
  }

  logEvent({
    level: 'info',
    msg: 'couple.rsvp_reminders_sent',
    event_type: 'couple.rsvp_remind',
    outcome: failed === 0 ? 'ok' : 'fail',
    venueId: auth.venueId,
    data: { wedding_id: auth.weddingId, sent, failed, skipped: (guests ?? []).length - unique.length },
  })

  return NextResponse.json({ sent, failed, skipped: (guests ?? []).length - unique.length })
}
