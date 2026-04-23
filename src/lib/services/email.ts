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
 *    overridden globally via EMAIL_FROM env var, or per-call via the `from`
 *    arg. Note: the brand domain is thebloomhouse.AI, not .com. An earlier
 *    draft had .com hardcoded, which would have caused Resend to reject
 *    sends silently (unverified domain) the moment RESEND_API_KEY was set.
 *  - Always returns { ok, error? } — never throws.
 *
 * Note: this is a transactional sender. Venue-authenticated Gmail flows
 * (see `./gmail`) remain separate and are used when replies should come
 * from the venue's own inbox.
 */

export interface SendEmailInput {
  to: string | string[]
  subject: string
  html: string
  from?: string
  text?: string
  replyTo?: string | string[]
}

export interface SendEmailResult {
  ok: boolean
  id?: string
  error?: string
}

const DEFAULT_FROM = 'The Bloom House <hello@thebloomhouse.ai>'

function resolveFrom(from?: string): string {
  return from || process.env.EMAIL_FROM || DEFAULT_FROM
}

function normalizeTo(to: string | string[]): string[] {
  return (Array.isArray(to) ? to : [to]).filter((addr): addr is string => Boolean(addr))
}

/**
 * Send a transactional email. Returns { ok, id?, error? }.
 * Never throws — errors are captured and logged.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const { to, subject, html, text, replyTo } = input
  const from = resolveFrom(input.from)
  const recipients = normalizeTo(to)

  if (recipients.length === 0) {
    const error = 'sendEmail called with no recipients'
    console.warn(`[email] ${error}`)
    return { ok: false, error }
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
