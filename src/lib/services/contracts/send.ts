/**
 * Email the couple their contract.
 *
 * Goes through `sendEmail` in src/lib/services/email/transport.ts, the same
 * guarded transport every other outbound path uses. This one is not
 * assistant-written prose: the body is a fixed template of the venue's own
 * words, rendered from figures already in the database, with no model
 * anywhere in the call chain. It is disclosure-justified at the call site
 * for that reason, the way the couple invitation and the team invite are.
 *
 * White-label follows the couple invitation exactly: the venue's business
 * name on the From line, their colour on the header and the button, their
 * logo when they have one, replies going to their coordinator. A couple
 * opening this should have no reason to learn that Bloom exists.
 *
 * The link carries a token that this function mints. Re-sending mints a
 * fresh one and retires the old link, which is what a coordinator means
 * when they press send again.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { sendEmail } from '@/lib/services/email/transport'
import { redactError } from '@/lib/observability/redact'
import { escapeHtml } from './templates'
import { readGeneratedFrom } from './generate'
import { mintSignToken } from './sign'
import { asContractStatus, canSend } from './status'

type Db = SupabaseClient

export interface SendResult {
  ok: boolean
  reason?: string
  /** The signing link, so a coordinator can read it down the phone. */
  signUrl?: string
  recipients?: string[]
}

/** Where the couple lands. Under /join, which is already a public prefix. */
export function signUrlFor(token: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL || 'https://bloom-house-iota.vercel.app'
  return `${base.replace(/\/+$/, '')}/join/contract/${token}`
}

/**
 * The couple's email addresses for a wedding: both partners where both
 * have one, de-duplicated, because a couple who share an inbox should get
 * one email rather than two links racing each other.
 */
async function recipientsFor(db: Db, weddingId: string): Promise<string[]> {
  const { data } = await db
    .from('people')
    .select('email')
    .eq('wedding_id', weddingId)
    .in('role', ['partner1', 'partner2'])
    .is('merged_into_id', null)
    .not('email', 'is', null)

  const seen = new Map<string, string>()
  for (const row of (data ?? []) as Array<{ email: string | null }>) {
    const addr = row.email?.trim()
    if (!addr) continue
    seen.set(addr.toLowerCase(), addr)
  }
  return [...seen.values()]
}

function buildEmailHtml(input: {
  businessName: string
  primaryColor: string
  logoUrl: string | null
  coupleNames: string
  coordinatorName: string | null
  signUrl: string
  title: string
}): string {
  const logoBlock = input.logoUrl
    ? `<img src="${escapeHtml(input.logoUrl)}" alt="${escapeHtml(input.businessName)}" style="max-height:44px;display:block;margin-bottom:12px;" />`
    : `<h1 style="margin:0;font-size:22px;font-weight:600;color:#FFFFFF;font-family:Georgia,serif;">${escapeHtml(input.businessName)}</h1>`

  const signOff = input.coordinatorName
    ? `${escapeHtml(input.coordinatorName)}<br/><span style="color:rgba(0,0,0,0.6);font-weight:400;">${escapeHtml(input.businessName)}</span>`
    : escapeHtml(input.businessName)

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#FDFAF6;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#2D2D2D;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#FFFFFF;border-radius:8px;overflow:hidden;">
    <tr>
      <td style="background:${escapeHtml(input.primaryColor)};padding:28px;">
        ${logoBlock}
      </td>
    </tr>
    <tr>
      <td style="padding:28px;">
        <h2 style="margin:0 0 12px;font-size:20px;">Hi ${escapeHtml(input.coupleNames)},</h2>
        <p style="margin:0 0 14px;font-size:15px;line-height:1.55;">
          Here is your ${escapeHtml(input.title.toLowerCase())} with ${escapeHtml(input.businessName)}.
          Read it through, and when you are happy, type your name at the bottom to agree. It takes a minute.
        </p>
        <p style="margin:0 0 24px;">
          <a href="${escapeHtml(input.signUrl)}" style="display:inline-block;padding:12px 24px;background:${escapeHtml(input.primaryColor)};color:#FFFFFF;text-decoration:none;border-radius:8px;font-weight:600;">
            Read and sign
          </a>
        </p>
        <p style="margin:0 0 12px;font-size:13px;color:#6B7280;">
          Or paste this into your browser:
          <a href="${escapeHtml(input.signUrl)}" style="color:${escapeHtml(input.primaryColor)};">${escapeHtml(input.signUrl)}</a>
        </p>
        <p style="margin:0 0 24px;font-size:13px;color:#6B7280;">
          This link is just for you. If anything in the contract does not match what you were told,
          reply to this email before you sign and we will sort it out.
        </p>
        <p style="margin:0;font-size:14px;line-height:1.55;color:#2D2D2D;">
          ${signOff}
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:20px 28px;border-top:1px solid #F3F4F6;">
        <p style="margin:0;font-size:12px;color:#6B7280;text-align:center;">
          ${escapeHtml(input.businessName)}
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`
}

/**
 * Send one contract.
 *
 * Order: mint and store the token, send, then move the status. A token
 * stored before the send means the link in the email is live the moment it
 * arrives. A status moved only after a successful send means the
 * coordinator's page never claims a contract was sent when the email
 * bounced off the transport.
 */
export async function sendContract(input: {
  contractId: string
  venueId: string
  db?: Db
  now?: Date
}): Promise<SendResult> {
  const db = input.db ?? createServiceClient()
  const now = input.now ?? new Date()

  const { data: contract, error } = await db
    .from('contracts')
    .select('id, venue_id, wedding_id, kind, status, generated_from')
    .eq('id', input.contractId)
    .eq('venue_id', input.venueId)
    .maybeSingle()

  if (error) {
    console.error('[contracts/send] lookup failed:', redactError(error))
    return { ok: false, reason: 'We could not read that contract just now.' }
  }
  if (!contract) return { ok: false, reason: 'That contract could not be found.' }
  if (contract.kind !== 'generated') {
    return { ok: false, reason: 'Only a contract Bloom generated can be sent from here.' }
  }

  const permission = canSend(asContractStatus(contract.status))
  if (!permission.ok) return { ok: false, reason: permission.reason }

  const frozen = readGeneratedFrom(contract.generated_from)
  if (!frozen) {
    return {
      ok: false,
      reason: 'The figures behind this contract could not be read. Generate it again.',
    }
  }

  const weddingId = contract.wedding_id as string
  const recipients = await recipientsFor(db, weddingId)
  if (recipients.length === 0) {
    return {
      ok: false,
      reason: 'No email on file for this couple. Add a contact email first.',
    }
  }

  const { data: config } = await db
    .from('venue_config')
    .select('business_name, coordinator_name, coordinator_email, logo_url, primary_color')
    .eq('venue_id', input.venueId)
    .maybeSingle()

  const businessName =
    (config?.business_name as string | null)?.trim() || frozen.snapshot.venueName
  const primaryColor = (config?.primary_color as string | null) || '#7D8471'
  const coordinatorEmail = (config?.coordinator_email as string | null) || undefined
  const coordinatorName = (config?.coordinator_name as string | null) || null

  const { token, tokenHash } = mintSignToken()
  const signUrl = signUrlFor(token)

  // Store the credential before the email leaves. A link that arrives
  // before its row exists is dead on arrival and a couple staring at
  // "this link is not valid" has no way to tell that from being locked out.
  // Re-sending replaces the hash, which retires the previous link, and
  // clears viewed_at so "opened" can only ever mean opened since this send.
  const { error: tokenError } = await db
    .from('contracts')
    .update({ sign_token: tokenHash, viewed_at: null })
    .eq('id', contract.id as string)
    .eq('venue_id', input.venueId)

  if (tokenError) {
    console.error('[contracts/send] could not store the signing link:', redactError(tokenError))
    return { ok: false, reason: 'The contract could not be prepared for sending.' }
  }

  const doc = frozen.template
  const html = buildEmailHtml({
    businessName,
    primaryColor,
    logoUrl: (config?.logo_url as string | null) ?? null,
    coupleNames: frozen.snapshot.coupleNames,
    coordinatorName,
    signUrl,
    title: doc.title,
  })

  // disclosure-justified: not assistant-authored. The body is the venue's
  // own template rendered from figures already in their database, with no
  // model in the call chain, so an AI disclosure footer would be a false
  // claim about who wrote it. Same treatment as the couple invitation.
  const result = await sendEmail({
    to: recipients,
    subject: `Your ${doc.title.toLowerCase()} with ${businessName}`,
    html,
    // W55: the From address is the venue's own verified sending domain,
    // resolved inside the transport; here we only name who it is from.
    venueId: input.venueId,
    fromName: businessName,
    replyTo: coordinatorEmail,
  })

  if (!result.ok) {
    console.error('[contracts/send] transport refused the send:', result.error)
    return {
      ok: false,
      reason: 'The email did not go out. Nothing has changed; try again in a moment.',
      signUrl,
    }
  }

  const { error: statusError } = await db
    .from('contracts')
    .update({ status: 'sent', sent_at: now.toISOString() })
    .eq('id', contract.id as string)
    .eq('venue_id', input.venueId)

  if (statusError) {
    // The couple has the email. Say so rather than pretend it failed; the
    // status trail is the thing that is now wrong, not the send.
    console.error('[contracts/send] sent but could not record it:', redactError(statusError))
    return {
      ok: true,
      reason: 'Sent, but the status could not be saved. Refresh in a moment.',
      signUrl,
      recipients,
    }
  }

  return { ok: true, signUrl, recipients }
}
