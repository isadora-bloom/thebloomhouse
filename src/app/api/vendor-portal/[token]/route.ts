import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { checkRateLimit } from '@/lib/rate-limit'

// ---------------------------------------------------------------------------
// /api/vendor-portal/[token] — Token-based booked-vendor self-service
//
// Distinct from /api/public/vendor-portal which targets vendor_recommendations
// (the venue's vendor catalog). This route targets booked_vendors — vendors
// hired for a specific wedding, with arrival/departure times, contact info,
// and notes scoped to that wedding's day-of plan.
//
// Auth model: 16-byte hex portal_token issued per-booked-vendor (mig 032).
// Rate-limited per IP. Token expiry optional (mig 217) — NULL grandfathers
// existing tokens.
//
// Per 2026-05-06 audit Lens 1 + Lens 8.
// ---------------------------------------------------------------------------

const TEXT_FIELD_MAX = 5000           // notes
const URL_FIELD_MAX = 1000            // website, instagram
const SHORT_FIELD_MAX = 500           // contact_name, contact_email, contact_phone, arrival/departure
const COUPLE_PREVIEW_MAX = 2          // people rows to fetch for couple-name display

function clientIp(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
}

async function rateLimit(request: NextRequest, prefix: 'get' | 'put') {
  const ip = clientIp(request)
  return checkRateLimit({
    key: `vendor-portal-booked:${prefix}:${ip}`,
    limit: prefix === 'put' ? 30 : 120,
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

// GET: fetch booked-vendor info by token (public, no auth)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const rl = await rateLimit(request, 'get')
  if (!rl.ok) return rateLimited(rl)

  try {
    const { token } = await params
    if (!token || typeof token !== 'string') {
      return NextResponse.json({ error: 'Invalid token' }, { status: 400 })
    }

    const supabase = createServiceClient()

    const { data: vendor, error } = await supabase
      .from('booked_vendors')
      .select(
        `
        id, vendor_type, vendor_name, contact_name, contact_email,
        contact_phone, website, instagram, arrival_time, departure_time,
        notes, portal_token, wedding_id, portal_token_expires_at
        `
      )
      .eq('portal_token', token)
      .maybeSingle()

    if (error || !vendor) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    if (
      vendor.portal_token_expires_at &&
      new Date(vendor.portal_token_expires_at as string).getTime() < Date.now()
    ) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // Fetch wedding date + couple display name in parallel.
    // Pre-fix the people query targeted a non-existent table called
    // 'wedding_people' (silently returned no rows on every request, so
    // every vendor saw no couple name). The canonical table is `people`.
    const [{ data: wedding }, { data: people }] = await Promise.all([
      supabase
        .from('weddings')
        .select('wedding_date')
        .eq('id', vendor.wedding_id as string)
        .maybeSingle(),
      supabase
        .from('people')
        .select('first_name, role')
        .eq('wedding_id', vendor.wedding_id as string)
        .in('role', ['partner1', 'partner2', 'bride', 'groom', 'partner'])
        .limit(COUPLE_PREVIEW_MAX),
    ])

    const coupleNames = (people ?? [])
      .map((p) => p.first_name as string | null)
      .filter(Boolean)
      .join(' & ') || null

    // Strip internal fields from response.
    const {
      portal_token: _t,
      portal_token_expires_at: _e,
      wedding_id: _w,
      ...publicVendor
    } = vendor as Record<string, unknown>

    return NextResponse.json({
      ...publicVendor,
      wedding_date: wedding?.wedding_date ?? null,
      couple_names: coupleNames,
    })
  } catch (error) {
    console.error('[api/vendor-portal/[token]] GET error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// PUT: vendor updates their own info (public, token is auth)
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const rl = await rateLimit(req, 'put')
  if (!rl.ok) return rateLimited(rl)

  try {
    const { token } = await params
    if (!token || typeof token !== 'string') {
      return NextResponse.json({ error: 'Invalid token' }, { status: 400 })
    }

    const body = await req.json()
    const supabase = createServiceClient()

    // Verify token + check expiry in one query.
    const { data: existing } = await supabase
      .from('booked_vendors')
      .select('id, portal_token_expires_at')
      .eq('portal_token', token)
      .maybeSingle()

    if (!existing) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    if (
      existing.portal_token_expires_at &&
      new Date(existing.portal_token_expires_at as string).getTime() < Date.now()
    ) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // Allowlist + length cap. notes can be longer (vendor day-of context);
    // contact / URL fields are short.
    const stringCaps: Record<string, number> = {
      contact_name: SHORT_FIELD_MAX,
      contact_email: SHORT_FIELD_MAX,
      contact_phone: SHORT_FIELD_MAX,
      arrival_time: SHORT_FIELD_MAX,
      departure_time: SHORT_FIELD_MAX,
      website: URL_FIELD_MAX,
      instagram: URL_FIELD_MAX,
      notes: TEXT_FIELD_MAX,
    }

    const updates: Record<string, unknown> = {}
    for (const [key, cap] of Object.entries(stringCaps)) {
      if (key in body) {
        const val = body[key]
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

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
    }

    updates.updated_at = new Date().toISOString()

    const { error } = await supabase
      .from('booked_vendors')
      .update(updates)
      .eq('id', existing.id as string)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[api/vendor-portal/[token]] PUT error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
