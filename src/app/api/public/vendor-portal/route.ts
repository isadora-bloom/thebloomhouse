import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { checkRateLimit } from '@/lib/rate-limit'
import { clientIpForRateLimit } from '@/lib/security/client-ip'

// ---------------------------------------------------------------------------
// /api/public/vendor-portal — Token-based vendor self-service (no auth)
//
// Auth model: 16-byte hex portal_token issued per-vendor. Rate limited
// per IP to limit blast radius of a leaked token. Token expiry is
// optional (mig 217) — NULL expires_at means grandfathered.
//
// Per 2026-05-06 audit Lens 8.
// ---------------------------------------------------------------------------

const TEXT_FIELD_MAX = 5000          // bio / pricing_info / special_offer / description
const URL_FIELD_MAX = 1000           // website_url, instagram_url, facebook_url
const SHORT_FIELD_MAX = 500          // contact_email, contact_phone
const PORTFOLIO_PHOTOS_MAX = 8
const PORTFOLIO_PHOTO_URL_MAX = 1000

async function rateLimit(request: NextRequest, prefix: 'get' | 'patch') {
  const ip = clientIpForRateLimit(request)
  return checkRateLimit({
    key: `vendor-portal:${prefix}:${ip}`,
    limit: prefix === 'patch' ? 30 : 120,
    windowSec: 3600,
  })
}

function rateLimited(rl: { resetAt: Date }) {
  return NextResponse.json(
    { error: 'Rate limit exceeded' },
    {
      status: 429,
      headers: {
        'Retry-After': String(
          Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000),
        ),
      },
    },
  )
}

// ---- GET ?token=xxx ----
export async function GET(request: NextRequest) {
  const rl = await rateLimit(request, 'get')
  if (!rl.ok) return rateLimited(rl)

  try {
    const { searchParams } = new URL(request.url)
    const token = searchParams.get('token')

    if (!token || typeof token !== 'string') {
      return NextResponse.json({ error: 'token is required' }, { status: 400 })
    }

    const supabase = createServiceClient()

    // Single query: pull vendor + venue join in one round trip. Pre-fix
    // this was two SELECTs against vendor_recommendations.
    const { data: vendor, error } = await supabase
      .from('vendor_recommendations')
      .select(
        `
        id, vendor_name, vendor_type, contact_email, contact_phone,
        website_url, description, logo_url, bio, instagram_url,
        facebook_url, pricing_info, special_offer, offer_expires_at,
        portfolio_photos, last_updated_by_vendor,
        portal_token_expires_at, venue_id
        `
      )
      .eq('portal_token', token)
      .maybeSingle()

    if (error || !vendor) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 404 })
    }

    // Token expiry check — only enforced when expires_at is non-null
    // (mig 217 grandfathers existing tokens with NULL expiry).
    if (
      vendor.portal_token_expires_at &&
      new Date(vendor.portal_token_expires_at as string).getTime() < Date.now()
    ) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 404 })
    }

    let venueName: string | null = null
    if (vendor.venue_id) {
      const { data: venue } = await supabase
        .from('venues')
        .select('name')
        .eq('id', vendor.venue_id as string)
        .maybeSingle()
      venueName = venue?.name ?? null
    }

    // Strip internal fields from response.
    const { venue_id: _venue_id, portal_token_expires_at: _expiry, ...publicVendor } = vendor as Record<string, unknown>

    return NextResponse.json({ data: { ...publicVendor, venue_name: venueName } })
  } catch (error) {
    console.error('[api/public/vendor-portal] GET error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---- PATCH ----
export async function PATCH(request: NextRequest) {
  const rl = await rateLimit(request, 'patch')
  if (!rl.ok) return rateLimited(rl)

  try {
    const body = await request.json()
    const { token, ...fields } = body

    if (!token || typeof token !== 'string') {
      return NextResponse.json({ error: 'token is required' }, { status: 400 })
    }

    const supabase = createServiceClient()

    // Verify token exists + is not expired.
    const { data: existing, error: lookupError } = await supabase
      .from('vendor_recommendations')
      .select('id, portal_token_expires_at')
      .eq('portal_token', token)
      .maybeSingle()

    if (lookupError || !existing) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 404 })
    }
    if (
      existing.portal_token_expires_at &&
      new Date(existing.portal_token_expires_at as string).getTime() < Date.now()
    ) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 404 })
    }

    // Allowlist + per-field length cap. Couples render these strings
    // in the portal so we cap to keep UI sane and limit XSS / DOS
    // payload size. (Server-side sanitization on render is the right
    // long-term fix; capping length is the immediate guard.)
    const stringCaps: Record<string, number> = {
      bio: TEXT_FIELD_MAX,
      pricing_info: TEXT_FIELD_MAX,
      special_offer: TEXT_FIELD_MAX,
      contact_email: SHORT_FIELD_MAX,
      contact_phone: SHORT_FIELD_MAX,
      website_url: URL_FIELD_MAX,
      instagram_url: URL_FIELD_MAX,
      facebook_url: URL_FIELD_MAX,
      offer_expires_at: SHORT_FIELD_MAX,
    }

    const updates: Record<string, unknown> = {}
    for (const [key, cap] of Object.entries(stringCaps)) {
      if (key in fields) {
        const val = fields[key]
        if (val === null || val === '') {
          updates[key] = null
        } else if (typeof val === 'string') {
          if (val.length > cap) {
            return NextResponse.json(
              { error: `${key} exceeds maximum length (${cap})` },
              { status: 400 },
            )
          }
          updates[key] = val
        } else {
          return NextResponse.json(
            { error: `${key} must be a string or null` },
            { status: 400 },
          )
        }
      }
    }

    // portfolio_photos: array of URLs, capped at 8, each capped in length.
    if ('portfolio_photos' in fields) {
      const photos = fields.portfolio_photos
      if (!Array.isArray(photos)) {
        return NextResponse.json(
          { error: 'portfolio_photos must be an array' },
          { status: 400 },
        )
      }
      if (photos.length > PORTFOLIO_PHOTOS_MAX) {
        return NextResponse.json(
          { error: `Maximum ${PORTFOLIO_PHOTOS_MAX} portfolio photos allowed` },
          { status: 400 },
        )
      }
      for (const url of photos) {
        if (typeof url !== 'string' || url.length > PORTFOLIO_PHOTO_URL_MAX) {
          return NextResponse.json(
            { error: `portfolio_photos entries must be strings under ${PORTFOLIO_PHOTO_URL_MAX} chars` },
            { status: 400 },
          )
        }
      }
      updates.portfolio_photos = photos
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
    }

    updates.last_updated_by_vendor = new Date().toISOString()

    const { data, error } = await supabase
      .from('vendor_recommendations')
      .update(updates)
      .eq('portal_token', token)
      .select(
        'id, vendor_name, vendor_type, contact_email, contact_phone, website_url, description, logo_url, bio, instagram_url, facebook_url, pricing_info, special_offer, offer_expires_at, portfolio_photos, last_updated_by_vendor'
      )
      .single()

    if (error) throw error

    return NextResponse.json({ data })
  } catch (error) {
    console.error('[api/public/vendor-portal] PATCH error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
