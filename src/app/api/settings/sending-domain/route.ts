/**
 * /api/settings/sending-domain (W55, NOVEMBER-PLAN.md wave 8).
 *
 * Backs the Settings -> Sending domain section. Server-side because
 * creating/verifying a domain needs RESEND_API_KEY, which never reaches
 * the browser.
 *
 *   GET    — current config (sending_domain, sending_from_name, status,
 *            checked_at) plus a live records read from Resend when a
 *            resend_domain_id is already on file, so a coordinator
 *            reopening the page sees today's status, not the status from
 *            whenever they last clicked something.
 *   POST    action: 'create' — registers a new domain with Resend, stores
 *            the result, returns the DNS records to add.
 *           action: 'check'  — forces Resend to re-check DNS right now
 *            ("check now" button), stores the resulting status.
 *
 * Both POST actions persist to venue_config with `.select()` after the
 * write so a PostgREST silent-failure (0 rows matched, no error) is
 * caught rather than reported as success.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import {
  createSendingDomain,
  verifySendingDomain,
  refreshSendingDomainStatus,
  type SendingDomainStatus,
  type DomainDnsRecord,
} from '@/lib/services/email/sending-domain'

interface StoredConfig {
  sending_domain: string | null
  sending_from_name: string | null
  sending_domain_status: SendingDomainStatus | null
  resend_domain_id: string | null
  sending_domain_checked_at: string | null
}

// Deliberately simple — this only needs to catch "that's not a domain"
// typos before we spend a Resend API call on it; Resend's own validation
// is the real gate. No protocol, no path, at least one dot.
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!auth.venueId) return NextResponse.json({ error: 'no_venue_in_scope' }, { status: 400 })

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('venue_config')
    .select('sending_domain, sending_from_name, sending_domain_status, resend_domain_id, sending_domain_checked_at')
    .eq('venue_id', auth.venueId)
    .maybeSingle()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const config = (data as StoredConfig | null) ?? null
  let records: DomainDnsRecord[] = []

  // Live read so the page shows today's Resend status, not a stale one
  // from whenever it was last written. Best-effort — a Resend hiccup
  // here just means the page falls back to the stored status.
  if (config?.resend_domain_id) {
    const live = await refreshSendingDomainStatus(config.resend_domain_id, auth.venueId)
    if (live.ok) {
      records = live.records ?? []
      if (live.status && live.status !== config.sending_domain_status) {
        const nowIso = new Date().toISOString()
        const { data: updated } = await supabase
          .from('venue_config')
          .update({ sending_domain_status: live.status, sending_domain_checked_at: nowIso })
          .eq('venue_id', auth.venueId)
          .select('sending_domain_status, sending_domain_checked_at')
          .maybeSingle()
        if (updated) {
          config.sending_domain_status = updated.sending_domain_status as SendingDomainStatus
          config.sending_domain_checked_at = updated.sending_domain_checked_at as string
        }
      }
    }
  }

  return NextResponse.json({
    domain: config?.sending_domain ?? null,
    fromName: config?.sending_from_name ?? null,
    status: config?.sending_domain_status ?? 'unverified',
    checkedAt: config?.sending_domain_checked_at ?? null,
    hasResendDomain: Boolean(config?.resend_domain_id),
    records,
  })
}

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!auth.venueId) return NextResponse.json({ error: 'no_venue_in_scope' }, { status: 400 })

  let body: { action?: string; domain?: string; fromName?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const supabase = createServiceClient()

  if (body.action === 'create') {
    const domain = (body.domain ?? '').trim().toLowerCase()
    const fromName = (body.fromName ?? '').trim()
    if (!domain || !DOMAIN_PATTERN.test(domain)) {
      return NextResponse.json({ error: 'That does not look like a domain (e.g. yourvenue.com).' }, { status: 400 })
    }
    if (!fromName) {
      return NextResponse.json({ error: 'Add the name you want couples to see in their inbox.' }, { status: 400 })
    }

    const created = await createSendingDomain(domain, auth.venueId)
    if (!created.ok) {
      return NextResponse.json({ error: created.error ?? 'Could not create the domain in Resend.' }, { status: 502 })
    }

    const nowIso = new Date().toISOString()
    const { data: updated, error: updateErr } = await supabase
      .from('venue_config')
      .update({
        sending_domain: domain,
        sending_from_name: fromName,
        sending_domain_status: created.status ?? 'unverified',
        resend_domain_id: created.domainId ?? null,
        sending_domain_checked_at: nowIso,
      })
      .eq('venue_id', auth.venueId)
      .select('sending_domain_status, sending_domain_checked_at')
      .maybeSingle()

    if (updateErr || !updated) {
      // The domain exists in Resend at this point even though the write
      // failed — surface that plainly rather than a generic 500 so the
      // coordinator (or Resend's own dashboard) isn't left guessing.
      return NextResponse.json(
        { error: `Domain created in Resend but saving it failed: ${updateErr?.message ?? 'no row updated'}` },
        { status: 500 },
      )
    }

    return NextResponse.json({
      domain,
      fromName,
      status: updated.sending_domain_status,
      checkedAt: updated.sending_domain_checked_at,
      hasResendDomain: true,
      records: created.records ?? [],
    })
  }

  if (body.action === 'check') {
    const { data: existing, error: readErr } = await supabase
      .from('venue_config')
      .select('resend_domain_id')
      .eq('venue_id', auth.venueId)
      .maybeSingle()

    if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 })
    const resendDomainId = (existing as { resend_domain_id: string | null } | null)?.resend_domain_id
    if (!resendDomainId) {
      return NextResponse.json({ error: 'No domain on file yet — add one first.' }, { status: 400 })
    }

    const checked = await verifySendingDomain(resendDomainId, auth.venueId)
    if (!checked.ok) {
      return NextResponse.json({ error: checked.error ?? 'Could not reach Resend to check the domain.' }, { status: 502 })
    }

    const nowIso = new Date().toISOString()
    const { data: updated, error: updateErr } = await supabase
      .from('venue_config')
      .update({
        sending_domain_status: checked.status ?? 'unverified',
        sending_domain_checked_at: nowIso,
      })
      .eq('venue_id', auth.venueId)
      .select('sending_domain, sending_from_name, sending_domain_status, sending_domain_checked_at')
      .maybeSingle()

    if (updateErr || !updated) {
      return NextResponse.json(
        { error: `Checked Resend but saving the result failed: ${updateErr?.message ?? 'no row updated'}` },
        { status: 500 },
      )
    }

    return NextResponse.json({
      domain: updated.sending_domain,
      fromName: updated.sending_from_name,
      status: updated.sending_domain_status,
      checkedAt: updated.sending_domain_checked_at,
      hasResendDomain: true,
      records: checked.records ?? [],
    })
  }

  return NextResponse.json({ error: 'unknown_action' }, { status: 400 })
}
