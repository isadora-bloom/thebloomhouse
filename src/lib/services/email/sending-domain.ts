/**
 * Resend domain-verification flow for per-venue sending domains (W55,
 * NOVEMBER-PLAN.md wave 8).
 *
 * Wraps the Resend Domains API so a coordinator can add their venue's own
 * domain, see the DNS records Resend wants, and check whether they've been
 * added correctly — the same three-step flow Resend's own dashboard walks
 * through, surfaced inside Settings -> Sending domain instead.
 *
 *   createSendingDomain   POST /domains          — register the domain,
 *                          returns the DNS records to add (SPF, DKIM, and
 *                          sometimes DMARC).
 *   verifySendingDomain   POST /domains/{id}/verify, then GET /domains/{id}
 *                          — ask Resend to re-check DNS right now, then
 *                          read back the resulting status. This is what
 *                          the settings page's "check now" button calls.
 *   refreshSendingDomainStatus   GET /domains/{id} only — read the current
 *                          status without forcing a new check. This is
 *                          what the daily cron piggyback calls (see
 *                          cron/route.ts heat_decay case), so a venue that
 *                          fixed their DNS days ago flips to verified on
 *                          its own without anyone clicking a button.
 *
 * Env-gated on RESEND_API_KEY exactly like transport.ts: with no key set,
 * every function here returns `{ ok: false, error: ... }` rather than
 * throwing or touching the network, so local/dev and CI never need a real
 * Resend account. No function in this file writes to the database — the
 * callers (the settings API route, the cron piggyback) own persisting the
 * result to venue_config.
 */

import { logEvent } from '@/lib/observability/logger'

/** Mirrors venue_config.sending_domain_status (migration 408). */
export type SendingDomainStatus = 'unverified' | 'pending' | 'verified' | 'failed'

/** One DNS record the coordinator needs to add at their domain registrar.
 *  Shape matches what Resend's `records` array returns on create/get,
 *  trimmed to the fields the settings page actually renders. */
export interface DomainDnsRecord {
  /** What this record proves: 'SPF' | 'DKIM' | 'DMARC' (Resend also emits
   *  bare MX entries under the SPF record — kept as-is rather than
   *  re-labelled, since the DNS type (MX/TXT/CNAME) already distinguishes
   *  them). */
  record: string
  /** DNS record type to select in the registrar's UI: TXT, MX, CNAME. */
  type: string
  name: string
  value: string
  priority?: number
  /** Resend's own per-record status, when it returns one. Null when not
   *  reported (e.g. straight off a fresh create()). */
  status: string | null
}

export interface DomainCreateResult {
  ok: boolean
  domainId?: string
  status?: SendingDomainStatus
  records?: DomainDnsRecord[]
  error?: string
}

export interface DomainStatusResult {
  ok: boolean
  status?: SendingDomainStatus
  records?: DomainDnsRecord[]
  error?: string
}

/**
 * Resend's DomainStatus is five values (pending | verified | failed |
 * temporary_failure | not_started); venue_config.sending_domain_status is
 * the simpler four the settings page and transport.ts actually branch on.
 * not_started (nothing attempted yet, straight off create()) reads as
 * unverified; temporary_failure collapses into failed — both read to a
 * coordinator as "fix your DNS and check again", so a fifth status would
 * only add a case nothing distinguishes.
 */
function mapResendStatus(status: string | undefined | null): SendingDomainStatus {
  switch (status) {
    case 'verified':
      return 'verified'
    case 'pending':
      return 'pending'
    case 'failed':
    case 'temporary_failure':
      return 'failed'
    case 'not_started':
    default:
      return 'unverified'
  }
}

interface RawResendRecord {
  record?: string
  type?: string
  name?: string
  value?: string
  priority?: number
  status?: string
}

function mapRecords(records: RawResendRecord[] | undefined | null): DomainDnsRecord[] {
  return (records ?? []).map((r) => ({
    record: r.record ?? 'TXT',
    type: r.type ?? 'TXT',
    name: r.name ?? '',
    value: r.value ?? '',
    priority: r.priority,
    status: r.status ?? null,
  }))
}

/** Loads the Resend client, or null when RESEND_API_KEY isn't set. Dynamic
 *  import mirrors transport.ts so a project without `resend` installed
 *  doesn't break the build, and so no network call happens at module
 *  load time (import-time side effects break `npx vitest run` in CI). */
async function getResendClient() {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return null
  const { Resend } = await import('resend')
  return new Resend(apiKey)
}

const NOT_CONFIGURED_ERROR =
  'RESEND_API_KEY is not set — cannot reach Resend to create or check a sending domain.'

/**
 * Register a venue's domain with Resend. Returns the DNS records the
 * coordinator needs to add at their registrar. Does not verify anything
 * by itself — Resend's status starts at 'not_started'/'pending' until
 * verifySendingDomain (or Resend's own background check) runs.
 */
export async function createSendingDomain(
  domain: string,
  venueId: string,
): Promise<DomainCreateResult> {
  const client = await getResendClient()
  if (!client) return { ok: false, error: NOT_CONFIGURED_ERROR }

  try {
    const { data, error } = await client.domains.create({ name: domain })
    if (error || !data) {
      const message = error?.message ?? 'Resend returned no data for domain create'
      logEvent({
        level: 'warn',
        msg: 'sending_domain.create_failed',
        event_type: 'email.sending_domain',
        outcome: 'fail',
        venueId,
        data: { domain, message },
      })
      return { ok: false, error: message }
    }
    return {
      ok: true,
      domainId: data.id,
      status: mapResendStatus(data.status),
      records: mapRecords(data.records),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logEvent({
      level: 'error',
      msg: 'sending_domain.create_threw',
      event_type: 'email.sending_domain',
      outcome: 'fail',
      venueId,
      data: { domain, message },
    })
    return { ok: false, error: message }
  }
}

/**
 * Ask Resend to re-check this domain's DNS right now, then read back the
 * resulting status + records. This is the "check now" button's call — it
 * forces a fresh attempt rather than reporting Resend's last cached
 * status, which is what refreshSendingDomainStatus below does instead.
 */
export async function verifySendingDomain(
  resendDomainId: string,
  venueId: string,
): Promise<DomainStatusResult> {
  const client = await getResendClient()
  if (!client) return { ok: false, error: NOT_CONFIGURED_ERROR }

  try {
    const { error: verifyError } = await client.domains.verify(resendDomainId)
    if (verifyError) {
      const message = verifyError.message ?? 'Resend rejected the verify request'
      logEvent({
        level: 'warn',
        msg: 'sending_domain.verify_failed',
        event_type: 'email.sending_domain',
        outcome: 'fail',
        venueId,
        data: { resendDomainId, message },
      })
      return { ok: false, error: message }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logEvent({
      level: 'error',
      msg: 'sending_domain.verify_threw',
      event_type: 'email.sending_domain',
      outcome: 'fail',
      venueId,
      data: { resendDomainId, message },
    })
    return { ok: false, error: message }
  }

  // verify() itself only echoes {id, object} back — the resulting status
  // lives on get(), and DNS propagation means the check Resend just ran
  // may still land as 'pending' rather than 'verified' immediately.
  return refreshSendingDomainStatus(resendDomainId, venueId)
}

/**
 * Read Resend's current status for this domain without forcing a new
 * check. Used by the settings page on load (so a stale "pending" from
 * days ago shows current reality) and by the daily cron piggyback, so a
 * venue that fixed their DNS flips to verified without a manual click.
 */
export async function refreshSendingDomainStatus(
  resendDomainId: string,
  venueId: string,
): Promise<DomainStatusResult> {
  const client = await getResendClient()
  if (!client) return { ok: false, error: NOT_CONFIGURED_ERROR }

  try {
    const { data, error } = await client.domains.get(resendDomainId)
    if (error || !data) {
      const message = error?.message ?? 'Resend returned no data for domain get'
      logEvent({
        level: 'warn',
        msg: 'sending_domain.refresh_failed',
        event_type: 'email.sending_domain',
        outcome: 'fail',
        venueId,
        data: { resendDomainId, message },
      })
      return { ok: false, error: message }
    }
    return {
      ok: true,
      status: mapResendStatus(data.status),
      records: mapRecords(data.records),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logEvent({
      level: 'error',
      msg: 'sending_domain.refresh_threw',
      event_type: 'email.sending_domain',
      outcome: 'fail',
      venueId,
      data: { resendDomainId, message },
    })
    return { ok: false, error: message }
  }
}
