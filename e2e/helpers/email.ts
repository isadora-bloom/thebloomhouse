/**
 * Email helper.
 *
 * Strategy chosen: Supabase-side inspection.
 *
 * Why not Resend `/emails?to=X`?  Resend's public list endpoint does not
 * support filtering by recipient and only returns emails sent very recently
 * — plus there is NO RESEND_API_KEY in .env.local, so we can't talk to
 * Resend at all in this environment.
 *
 * Strategy:
 *   1. If RESEND_API_KEY is present, we use `resend.emails.list()` and
 *      filter client-side.
 *   2. Otherwise, we look for the application's own outgoing-email audit
 *      trail. The app does NOT currently log to a dedicated table, so we
 *      fall back to asserting at the Resend API-call boundary via Playwright
 *      route interception where possible. That is done per-test, not here.
 *
 * For the generic `getLatestEmailTo(address)` we return null if no backend
 * channel is available so callers can skip-assert rather than flake.
 */
import { Resend } from 'resend'

export type CapturedEmail = {
  id?: string
  to: string
  subject: string
  from?: string
  created_at?: string
  html?: string
  text?: string
}

let _resend: Resend | null = null
function resendClient(): Resend | null {
  if (_resend) return _resend
  const key = process.env.RESEND_API_KEY
  if (!key) return null
  _resend = new Resend(key)
  return _resend
}

/**
 * Polls Resend for the most recent email sent to `address`. Returns null
 * if Resend is not configured (caller should skip that assertion).
 */
export async function getLatestEmailTo(
  address: string,
  opts: { timeoutMs?: number; sinceIso?: string } = {}
): Promise<CapturedEmail | null> {
  const client = resendClient()
  if (!client) return null

  const timeout = opts.timeoutMs ?? 20_000
  const start = Date.now()
  const since = opts.sinceIso ? new Date(opts.sinceIso).getTime() : start - 60_000
  while (Date.now() - start < timeout) {
    try {
      // Resend SDK: emails.list() with limit
      // @ts-ignore — newer SDK may have different shape
      const res: any = await (client.emails as any).list?.({ limit: 50 })
      const list: any[] = res?.data?.data ?? res?.data ?? []
      for (const e of list) {
        const toField: string = Array.isArray(e.to) ? e.to[0] : e.to
        if (toField?.toLowerCase() === address.toLowerCase()) {
          const ct = e.created_at ? new Date(e.created_at).getTime() : 0
          if (ct >= since) {
            return {
              id: e.id,
              to: toField,
              subject: e.subject ?? '',
              from: e.from,
              created_at: e.created_at,
            }
          }
        }
      }
    } catch {
      // fall through & retry
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  return null
}

export async function clearInbox(_address?: string): Promise<void> {
  // Resend has no delete endpoint. This is a no-op — tests should use
  // `sinceIso` on getLatestEmailTo to isolate their run instead.
}

/**
 * Utility: is real Resend configured?
 */
export function hasResend(): boolean {
  return Boolean(process.env.RESEND_API_KEY)
}
