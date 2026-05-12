/**
 * POST /api/v1/visit  (Wave 6E follow-up — pixel ingest)
 *
 * Public endpoint hit by /public/bloom-pixel.js on every pageview of
 * the venue's marketing site. CORS-open (the venue site is on a
 * different origin), validates the per-venue pixel_ingest_key, dedupes
 * within a short window (so a hot-reloading SPA doesn't flood the
 * table), and inserts a web_visits row.
 *
 * What the pixel posts:
 *   {
 *     k:    "<pixel_ingest_key>",        // venue identity
 *     v:    "<anon_visitor_id>",         // first-party cookie value
 *     u:    "<page_url>",                // full URL incl. search
 *     r:    "<document.referrer>" | "",  // from previous page
 *     ts:   <epoch_ms>,                  // pixel-side clock
 *     utm:  { source, medium, campaign, term, content },
 *     cids: { gclid, fbclid, ttclid, msclkid }   // any present
 *   }
 *
 * No PII. Anonymous body shape only. The form-submission path (see
 * web-form adapter) carries the cookie value separately so this
 * endpoint never sees the visitor's identity directly.
 *
 * Throughput envelope:
 *   - Per-venue rate limit at the in-memory layer (best effort). A
 *     real production deployment should put a CDN rate limit in front.
 *   - The unique (venue, anon_visitor_id, occurred_at minute) check
 *     dedupes accidental double-fires.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { createHash } from 'crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 5

// CORS — the venue marketing site is on a different origin. We allow
// any origin to POST because the ingest key is the authorization (and
// the response carries no data the page can read).
const CORS_HEADERS: HeadersInit = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

// In-process rate limiter. Crude — works inside a single serverless
// instance. A production-scale deployment puts a CDN edge rule in
// front. For our scale today this is fine.
const rateBuckets = new Map<string, { count: number; windowStart: number }>()
const RATE_WINDOW_MS = 60_000
const RATE_LIMIT_PER_WINDOW = 240 // pageviews per minute per key

function checkRate(key: string): boolean {
  const now = Date.now()
  const bucket = rateBuckets.get(key)
  if (!bucket || now - bucket.windowStart > RATE_WINDOW_MS) {
    rateBuckets.set(key, { count: 1, windowStart: now })
    return true
  }
  bucket.count++
  return bucket.count <= RATE_LIMIT_PER_WINDOW
}

// Garbage-collect rate buckets occasionally so we don't leak memory.
function gcBuckets() {
  if (rateBuckets.size < 1000) return
  const now = Date.now()
  for (const [k, b] of rateBuckets.entries()) {
    if (now - b.windowStart > RATE_WINDOW_MS * 4) rateBuckets.delete(k)
  }
}

function hashIp(ip: string | null, salt: string): string | null {
  if (!ip) return null
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 32)
}

function hashUserAgent(ua: string | null, salt: string): string | null {
  if (!ua) return null
  return createHash('sha256').update(`${salt}:${ua}`).digest('hex').slice(0, 32)
}

function parsePathOnly(url: string | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}`.slice(0, 1000)
  } catch {
    return url.slice(0, 1000)
  }
}

interface PixelPayload {
  k?: string
  v?: string
  u?: string
  r?: string
  ts?: number
  utm?: {
    source?: string
    medium?: string
    campaign?: string
    term?: string
    content?: string
  }
  cids?: {
    gclid?: string
    fbclid?: string
    ttclid?: string
    msclkid?: string
  }
}

function pick(s: unknown): string | null {
  if (typeof s !== 'string') return null
  const trimmed = s.trim()
  return trimmed.length === 0 ? null : trimmed.slice(0, 500)
}

export async function POST(request: NextRequest) {
  let payload: PixelPayload
  try {
    payload = (await request.json()) as PixelPayload
  } catch {
    return new Response(null, { status: 400, headers: CORS_HEADERS })
  }

  const ingestKey = typeof payload.k === 'string' ? payload.k.trim() : ''
  if (!ingestKey || ingestKey.length < 16) {
    return new Response(null, { status: 400, headers: CORS_HEADERS })
  }
  const visitorId = typeof payload.v === 'string' ? payload.v.trim() : ''
  if (!visitorId || visitorId.length < 8 || visitorId.length > 128) {
    return new Response(null, { status: 400, headers: CORS_HEADERS })
  }

  if (!checkRate(ingestKey)) {
    return new Response(null, { status: 429, headers: CORS_HEADERS })
  }
  gcBuckets()

  const service = createServiceClient()

  // Resolve venue from the ingest key.
  const { data: venueConfig } = await service
    .from('venue_config')
    .select('venue_id, pixel_installed_at')
    .eq('pixel_ingest_key', ingestKey)
    .maybeSingle()
  if (!venueConfig?.venue_id) {
    return new Response(null, { status: 401, headers: CORS_HEADERS })
  }
  const venueId = venueConfig.venue_id as string

  // First successful visit per venue stamps pixel_installed_at so the
  // TBH Report coverage disclosure can read it.
  if (!venueConfig.pixel_installed_at) {
    void service
      .from('venue_config')
      .update({ pixel_installed_at: new Date().toISOString() })
      .eq('venue_id', venueId)
  }

  // Hash IP + UA with the ingest key as salt. The salt is per-venue so
  // hashes from different venues don't collide and aren't comparable.
  const ipHeader =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip')
  const uaHeader = request.headers.get('user-agent')
  const ipHash = hashIp(ipHeader ?? null, ingestKey)
  const userAgentHash = hashUserAgent(uaHeader ?? null, ingestKey)

  const occurredAt =
    typeof payload.ts === 'number' && payload.ts > 0
      ? new Date(payload.ts).toISOString()
      : new Date().toISOString()

  const insert = await service.from('web_visits').insert({
    venue_id: venueId,
    anon_visitor_id: visitorId,
    utm_source: pick(payload.utm?.source),
    utm_medium: pick(payload.utm?.medium),
    utm_campaign: pick(payload.utm?.campaign),
    utm_term: pick(payload.utm?.term),
    utm_content: pick(payload.utm?.content),
    gclid: pick(payload.cids?.gclid),
    fbclid: pick(payload.cids?.fbclid),
    ttclid: pick(payload.cids?.ttclid),
    msclkid: pick(payload.cids?.msclkid),
    referrer: pick(payload.r),
    landing_path: parsePathOnly(payload.u),
    ip_hash: ipHash,
    user_agent_hash: userAgentHash,
    occurred_at: occurredAt,
  })

  if (insert.error) {
    console.warn('[api/v1/visit] insert failed', insert.error.message)
    return new Response(null, { status: 500, headers: CORS_HEADERS })
  }

  return new Response(null, { status: 204, headers: CORS_HEADERS })
}
