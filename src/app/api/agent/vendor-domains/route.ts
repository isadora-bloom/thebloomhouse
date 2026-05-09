/**
 * /api/agent/vendor-domains
 *
 * CRUD for the per-venue vendor-domain allow-list (migration 258).
 *
 *   GET    → list rows for the authed venue, ordered by added_at desc
 *   POST   → manual add { domain, note? }   (source='manual', confidence=100)
 *   DELETE → remove by ?id=...               (venue-scoped delete)
 *
 * Auth: getPlatformAuth + auth.venueId. Demo mode is denied — the demo
 * coordinator should not be able to mutate the allow-list of the demo
 * venues that ship with seed data.
 *
 * Cache: every successful write calls clearVendorDomainCache(venueId)
 * so the lifecycle hot path picks up the change on the next pipeline
 * tick (5min cache TTL, manual invalidation kicks in immediately).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import { clearVendorDomainCache } from '@/lib/services/inbox/vendor-domains'

// Tightest acceptable shape for a domain string. Mirrors the CHECK
// constraint on the table (lower-case, non-empty) plus a basic syntax
// guard so a coordinator can't paste "@gibsonrental.com" or
// "https://gibsonrental.com" — neither match the lifecycle pipeline's
// `from_email.split('@').pop()` shape.
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i

function normaliseDomain(raw: string | null | undefined): string | null {
  if (!raw) return null
  let v = String(raw).trim().toLowerCase()
  // Tolerant: strip "@", protocol, path, leading/trailing dots.
  v = v.replace(/^@/, '')
  v = v.replace(/^https?:\/\//, '')
  v = v.split('/')[0] ?? v
  v = v.replace(/^\.+|\.+$/g, '')
  if (!v) return null
  if (!DOMAIN_RE.test(v)) return null
  if (v.length > 253) return null // RFC 1035
  return v
}

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot read vendor-domain allow-list')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('venue_vendor_domains')
    .select('id, domain, source, confidence, note, added_at, updated_at, added_by')
    .eq('venue_id', auth.venueId)
    .order('added_at', { ascending: false })

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true, domains: data ?? [] })
}

export async function POST(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot write vendor-domain allow-list')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const body = (await req.json().catch(() => null)) as
    | { domain?: string; note?: string | null }
    | null
  if (!body) return badRequest('Invalid JSON body')

  const domain = normaliseDomain(body.domain)
  if (!domain) return badRequest('Invalid domain — expected e.g. gibsonrental.com')

  const supabase = createServiceClient()
  // Upsert pattern: if the domain already exists for this venue (e.g.
  // ai_classifier promoted it last week), bump confidence to 100 +
  // flip source to 'manual' so the UI reflects the coordinator's
  // confirmation. Confidence is the max of existing and new (100).
  const { data: existing } = await supabase
    .from('venue_vendor_domains')
    .select('id, confidence, source')
    .eq('venue_id', auth.venueId)
    .eq('domain', domain)
    .maybeSingle()

  if (existing) {
    const { data, error } = await supabase
      .from('venue_vendor_domains')
      .update({
        source: 'manual',
        confidence: 100,
        note: body.note?.trim() || null,
        added_by: auth.userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id as string)
      .select('id, domain, source, confidence, note, added_at, updated_at, added_by')
      .single()
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    }
    clearVendorDomainCache(auth.venueId)
    return NextResponse.json({ ok: true, domain: data, upserted: true })
  }

  const { data, error } = await supabase
    .from('venue_vendor_domains')
    .insert({
      venue_id: auth.venueId,
      domain,
      source: 'manual',
      confidence: 100,
      note: body.note?.trim() || null,
      added_by: auth.userId,
    })
    .select('id, domain, source, confidence, note, added_at, updated_at, added_by')
    .single()

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }
  clearVendorDomainCache(auth.venueId)
  return NextResponse.json({ ok: true, domain: data, upserted: false })
}

export async function DELETE(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot write vendor-domain allow-list')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return badRequest('id query param required')

  const supabase = createServiceClient()
  // Scope the delete to the caller's venue to prevent cross-tenant
  // deletion via id-guess.
  const { error } = await supabase
    .from('venue_vendor_domains')
    .delete()
    .eq('id', id)
    .eq('venue_id', auth.venueId)

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }
  clearVendorDomainCache(auth.venueId)
  return NextResponse.json({ ok: true })
}
