/**
 * Operator alert for AI provider fallback / outage.
 *
 * The cold-open lesson was "nothing paged me". This is the pager. When
 * floor two (the OpenAI fallback) fires, or when both providers fail, the
 * operator hears about it the same day rather than finding out by clicking
 * a button two weeks later. The structured log lines in client.ts record
 * every fallback, but a log you have to go and read is not an alert.
 *
 * Design notes:
 *  - Rate-limited in-process, per function instance, the same shape as the
 *    circuit breaker. A sustained incident sends at most one email per
 *    kind per ALERT_INTERVAL_MS instead of one per request. Cross-instance
 *    de-dupe would need Redis / Vercel KV; per-instance is enough for v1.
 *  - Fire-and-forget. Callers use `void alertFallbackFired(...)`; it never
 *    blocks an AI call and never throws.
 *  - Zero-config-safe. Recipient is OPS_ALERT_EMAIL. With it unset the
 *    alert is logged but not mailed, so nothing breaks before the env is
 *    set.
 */

import { sendEmail } from '@/lib/services/email/transport'

type AlertKind = 'fallback_fired' | 'total_outage' | 'model_stale'

// Mute repeat alerts of the same kind for 15 minutes so an outage doesn't
// turn into an inbox flood.
const ALERT_INTERVAL_MS = 15 * 60 * 1000

const lastSent: Record<AlertKind, number> = {
  fallback_fired: 0,
  total_outage: 0,
  model_stale: 0,
}

export interface FallbackAlert {
  kind: AlertKind
  /** taskType of the AI call that tripped the alert (e.g. 'contract_qa'). */
  taskType: string
  /** True when the call was a vision call. */
  vision: boolean
  /** Why Claude was skipped, for fallback_fired: force_fallback | breaker_tripped | claude_failed. */
  skipReason?: string
}

export async function alertFallbackFired(alert: FallbackAlert): Promise<void> {
  try {
    const now = Date.now()
    if (now - lastSent[alert.kind] < ALERT_INTERVAL_MS) return
    lastSent[alert.kind] = now

    const to = process.env.OPS_ALERT_EMAIL

    // Always leave a breadcrumb, even when email isn't configured, so the
    // decision "did we try to page?" is visible in the logs.
    console.warn(
      JSON.stringify({
        opsAlert: alert.kind,
        taskType: alert.taskType,
        vision: alert.vision,
        skipReason: alert.skipReason,
        emailed: Boolean(to),
      })
    )

    if (!to) return

    const subject =
      alert.kind === 'total_outage'
        ? 'Bloom AI outage: both providers failed'
        : 'Bloom AI fallback fired: serving on OpenAI'

    const lines = [
      alert.kind === 'total_outage'
        ? 'Both Claude and the OpenAI fallback failed. Couples are getting the warm holding message, not real answers.'
        : 'Claude was unavailable, so a request was served by the OpenAI fallback (gpt-4o-mini).',
      '',
      `Task: ${alert.taskType}${alert.vision ? ' (vision)' : ''}`,
      alert.skipReason ? `Reason: ${alert.skipReason}` : '',
      '',
      `Further alerts of this kind are muted for ${ALERT_INTERVAL_MS / 60000} minutes.`,
    ].filter(Boolean)

    // disclosure-justified: operator alert email, not couple-facing Sage content
    await sendEmail({
      to,
      subject,
      html: `<pre style="font:14px/1.5 ui-monospace,monospace">${lines.join('\n')}</pre>`,
      text: lines.join('\n'),
    })
  } catch {
    // Alerting must never break an AI call.
  }
}

/**
 * Alert that a configured model ID no longer appears in the list its
 * provider currently serves — the cold-open failure, caught on a schedule
 * instead of by a dead button. Same rate-limit + zero-config-safe
 * behaviour as alertFallbackFired.
 */
export async function alertModelStale(
  stale: Array<{ provider: string; id: string }>
): Promise<void> {
  try {
    if (stale.length === 0) return
    const now = Date.now()
    if (now - lastSent.model_stale < ALERT_INTERVAL_MS) return
    lastSent.model_stale = now

    const to = process.env.OPS_ALERT_EMAIL
    const list = stale.map((s) => `${s.provider}: ${s.id}`).join(', ')

    console.warn(JSON.stringify({ opsAlert: 'model_stale', stale: list, emailed: Boolean(to) }))

    if (!to) return

    const lines = [
      'A configured AI model no longer appears in the list its provider currently serves.',
      'This is the cold-open failure: the model ID is going stale underneath the code.',
      '',
      `Stale: ${list}`,
      '',
      'Update the model constant in src/lib/ai/client.ts before the feature goes dead.',
      '',
      `Further alerts of this kind are muted for ${ALERT_INTERVAL_MS / 60000} minutes.`,
    ]

    // disclosure-justified: operator alert email, not couple-facing Sage content
    await sendEmail({
      to,
      subject: 'Bloom AI model stale: configured model not served by provider',
      html: `<pre style="font:14px/1.5 ui-monospace,monospace">${lines.join('\n')}</pre>`,
      text: lines.join('\n'),
    })
  } catch {
    // Alerting must never throw into a check.
  }
}

/** Test-only — reset the in-process mute state. */
export function _resetAlertState(): void {
  lastSent.fallback_fired = 0
  lastSent.total_outage = 0
  lastSent.model_stale = 0
}
