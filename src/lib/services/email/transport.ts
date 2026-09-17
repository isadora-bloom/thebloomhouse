/**
 * Bloom House: Transactional Email Helper
 *
 * Thin wrapper around Resend for transactional emails (couple invitations,
 * daily digests fallback, team invites, etc.).
 *
 * Behavior:
 *  - If RESEND_API_KEY is set, sends via Resend.
 *  - If missing, logs a warning and falls back to console.log so local/dev
 *    still works without credentials.
 *  - Default `from` is "The Bloom House <hello@thebloomhouse.ai>" and can be
 *    overridden globally via EMAIL_FROM env var. Note: the brand domain is
 *    thebloomhouse.AI, not .com. An earlier draft had .com hardcoded, which
 *    would have caused Resend to reject sends silently (unverified domain)
 *    the moment RESEND_API_KEY was set.
 *  - Always returns { ok, error? } — never throws.
 *
 * Note: this is a transactional sender. Venue-authenticated Gmail flows
 * (see `./gmail`) remain separate and are used when replies should come
 * from the venue's own inbox.
 *
 * ---------------------------------------------------------------------
 * Per-venue sending domain (W55, NOVEMBER-PLAN.md wave 8)
 * ---------------------------------------------------------------------
 * Every send here used to go out on Bloom's own domain regardless of
 * which venue it was on behalf of — the "infrastructure carry-forward"
 * note that used to sit on the invite-couple route. One shared domain
 * means one venue's bounces or spam complaints can drag down every
 * other venue's deliverability, so `sendEmail` now resolves the From
 * address per venue:
 *
 *   - `venueId` is REQUIRED on every call (pass `null` explicitly for a
 *     genuine platform-level send — an operator alert, a cross-venue
 *     team invite — so "no venue" is always a decision a caller made,
 *     never an omission).
 *   - When venue_config.sending_domain_status = 'verified', the From
 *     header is `sending_from_name <hello@sending_domain>` — the
 *     venue's own domain, so its own reputation is what's at stake.
 *   - Every other status (including no venue_config row at all, or a
 *     lookup failure) falls back to the platform default. That
 *     fallback is never silent — it emits a structured
 *     `email.from_fallback` log line via the repo logger so a venue
 *     stuck on "pending" for months is visible, not just theoretical.
 *   - `venueId: null` is NOT a fallback. There is no venue to resolve,
 *     so nothing is logged; it's the caller's explicit choice.
 *
 * Domain create/verify/status-refresh against Resend lives in
 * `./sending-domain`, called from the Settings -> Sending domain
 * section and from the daily cron piggyback (cron/route.ts heat_decay
 * case). This file only ever READS venue_config; it never writes it.
 */

import { logEvent } from '@/lib/observability/logger'
import { isVenueFrozen } from '@/lib/services/billing/venue-freeze'

export interface SendEmailInput {
  to: string | string[]
  subject: string
  html: string
  /**
   * Which venue this send is on behalf of. Required — pass `null` for a
   * genuine platform-level send (an operator alert, a cross-venue team
   * invite) so "no venue" is always an explicit choice, never a
   * forgotten argument. See the module doc comment above.
   */
  venueId: string | null
  text?: string
  replyTo?: string | string[]
  /**
   * Display name to use on the From header when the venue's own domain
   * isn't verified yet (or there is no venue). Typically the venue's
   * business name. Ignored once venue_config.sending_domain_status is
   * 'verified' — sending_from_name from venue_config takes over then,
   * because that's the name the coordinator chose specifically for the
   * envelope. Also used as the display name for a `venueId: null` send.
   */
  fromName?: string
}

export interface SendEmailResult {
  ok: boolean
  id?: string
  error?: string
}

const DEFAULT_FROM = 'The Bloom House <hello@thebloomhouse.ai>'

/** The raw address half of the platform default, e.g. 'hello@thebloomhouse.ai'.
 *  Used as the envelope address for any send that isn't on a verified
 *  venue domain, regardless of what display name is showing. */
function platformEnvelopeAddress(): string {
  const envFrom = process.env.EMAIL_FROM
  const match = envFrom?.match(/<([^>]+)>/)?.[1]
  return match || envFrom || 'hello@thebloomhouse.ai'
}

function platformFrom(fromName?: string): string {
  if (!fromName) return process.env.EMAIL_FROM || DEFAULT_FROM
  return `${fromName} <${platformEnvelopeAddress()}>`
}

interface VenueSendingConfig {
  sending_domain: string | null
  sending_from_name: string | null
  sending_domain_status: string | null
}

/**
 * Resolve the From header for one send. Never throws — any failure
 * resolves to the platform default with a reason attached, same shape
 * as every other fallback path.
 */
async function resolveFrom(
  venueId: string | null,
  fromName: string | undefined,
): Promise<{ from: string; fallbackReason: string | null }> {
  if (!venueId) {
    // Explicit platform-level send — nothing to resolve, not a fallback.
    return { from: platformFrom(fromName), fallbackReason: null }
  }

  let config: VenueSendingConfig | null
  try {
    const { createServiceClient } = await import('@/lib/supabase/service')
    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('venue_config')
      .select('sending_domain, sending_from_name, sending_domain_status')
      .eq('venue_id', venueId)
      .maybeSingle()
    if (error) {
      return { from: platformFrom(fromName), fallbackReason: 'venue_config_lookup_failed' }
    }
    config = (data as VenueSendingConfig | null) ?? null
  } catch {
    return { from: platformFrom(fromName), fallbackReason: 'venue_config_lookup_threw' }
  }

  if (!config) {
    return { from: platformFrom(fromName), fallbackReason: 'venue_config_missing' }
  }

  const { sending_domain, sending_from_name, sending_domain_status } = config

  if (sending_domain_status === 'verified' && sending_domain && sending_from_name) {
    return { from: `${sending_from_name} <hello@${sending_domain}>`, fallbackReason: null }
  }

  const reason = !sending_domain
    ? 'sending_domain_not_configured'
    : !sending_from_name
      ? 'sending_from_name_not_configured'
      : `sending_domain_status_${sending_domain_status ?? 'unverified'}`

  // Keep whatever display name the venue already has (sending_from_name,
  // then the caller's fromName) so an unverified venue still looks like
  // itself in the couple's inbox — only the envelope domain changes once
  // verified. This preserves the white-label behaviour every venue had
  // before this domain work existed.
  return { from: platformFrom(sending_from_name || fromName), fallbackReason: reason }
}

function normalizeTo(to: string | string[]): string[] {
  return (Array.isArray(to) ? to : [to]).filter((addr): addr is string => Boolean(addr))
}

/**
 * Send a transactional email. Returns { ok, id?, error? }.
 * Never throws — errors are captured and logged.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const { to, subject, html, text, replyTo, venueId } = input
  const recipients = normalizeTo(to)

  if (recipients.length === 0) {
    const error = 'sendEmail called with no recipients'
    console.warn(`[email] ${error}`)
    return { ok: false, error }
  }

  // Frozen venue (trial ended, no subscription, migration 417): no mail
  // on its behalf. venueId null is platform mail and always goes.
  if (venueId && (await isVenueFrozen(venueId))) {
    console.warn(`[email] Refusing to send for frozen venue ${venueId}`)
    return { ok: false, error: 'venue_frozen' }
  }

  const { from, fallbackReason } = await resolveFrom(venueId, input.fromName)
  if (fallbackReason) {
    // Never a silent fallback — every send that lands on the platform
    // domain instead of a venue's own is visible in the structured log,
    // even when it's the expected/common case (most venues start out
    // unverified). See the module doc comment for the design rationale.
    logEvent({
      level: 'warn',
      msg: 'email.from_fallback',
      event_type: 'email.sending_domain',
      outcome: 'skip',
      venueId,
      data: { reason: fallbackReason },
    })
  }

  const apiKey = process.env.RESEND_API_KEY

  if (!apiKey) {
    console.warn(
      '[email] RESEND_API_KEY not set — falling back to console.log. ' +
        'Set RESEND_API_KEY in env to actually send mail.'
    )
    console.log('[email:dev-fallback]', {
      from,
      to: recipients,
      subject,
      htmlLength: html.length,
      replyTo,
    })
    return { ok: true, id: 'dev-fallback' }
  }

  try {
    // Dynamic import so projects without `resend` installed don't break build.
    const { Resend } = await import('resend')
    const client = new Resend(apiKey)

    const { data, error } = await client.emails.send({
      from,
      to: recipients,
      subject,
      html,
      text,
      replyTo,
    })

    if (error) {
      const message = error.message || String(error)
      console.error('[email] Resend returned error:', message)
      return { ok: false, error: message }
    }

    return { ok: true, id: data?.id }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[email] Unexpected failure sending email:', message)
    return { ok: false, error: message }
  }
}

// Exported for tests only — resolveFrom exercises the DB lookup + status
// branching directly without going through the Resend/console-fallback
// send path.
export const _internal = { resolveFrom, platformFrom, platformEnvelopeAddress }
