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
 *   - Durable per-venue and per-IP rate limits (src/lib/rate-limit.ts,
 *     Postgres-backed). A CDN rule in front is still the right place for
 *     the first order of magnitude.
 *   - The unique (venue, anon_visitor_id, occurred_at minute) check
 *     dedupes accidental double-fires.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { createHash } from 'crypto'
import { checkRateLimit } from '@/lib/rate-limit'
import { clientIpForRateLimit } from '@/lib/security/client-ip'

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

// Rate limiting lives in Postgres (src/lib/rate-limit.ts), not a
// module-scope Map. Under Vercel each function instance had its own Map,
// so the old limiter divided by however many instances were warm and
// horizontal scale defeated it entirely — on a public, CORS-open,
// unauthenticated endpoint that inserts a row per call. Same bug class
// as PROJECT-AUDIT-V2 BUG-12, which is why the durable limiter exists.
//
// Two keys, neither shared: the venue, so one site's traffic cannot
// starve another's, and the caller's IP, so one machine cannot flood a
// venue's numbers with invented pageviews.
const VISITS_PER_VENUE_PER_MINUTE = 240
const VISITS_PER_IP_PER_MINUTE = 60

/**
 * How far from now a pixel-supplied timestamp may sit. The pixel sends
 * the browser's clock, which is attacker-controlled and also just wrong
 * on plenty of real machines. Unclamped, `ts` wrote web_visits rows dated
 * 1970 or 2074 and quietly bent every attribution window that reads
 * occurred_at. A day back covers a queued beacon and honest clock skew;
 * anything outside the window falls back to server time.
 */
const TS_PAST_MS = 24 * 60 * 60 * 1000
const TS_FUTURE_MS = 5 * 60 * 1000

function clampOccurredAt(ts: unknown): string {
  const now = Date.now()
  if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) {
    if (ts >= now - TS_PAST_MS && ts <= now + TS_FUTURE_MS) {
      return new Date(ts).toISOString()
    }
  }
  return new Date(now).toISOString()
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

  // Caller limit first: it needs no database lookup beyond the limiter
  // itself, so an unknown key costs one round trip, not two.
  const clientIp = clientIpForRateLimit(request)
  const ipRl = await checkRateLimit({
    key: `visit-ip:${clientIp}`,
    limit: VISITS_PER_IP_PER_MINUTE,
    windowSec: 60,
  })
  if (!ipRl.ok) {
    return new Response(null, { status: 429, headers: CORS_HEADERS })
  }

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

  const venueRl = await checkRateLimit({
    key: `visit:${venueId}`,
    limit: VISITS_PER_VENUE_PER_MINUTE,
    windowSec: 60,
  })
  if (!venueRl.ok) {
    return new Response(null, { status: 429, headers: CORS_HEADERS })
  }

  // Hash IP + UA with the ingest key as salt. The salt is per-venue so
  // hashes from different venues don't collide and aren't comparable.
  //
  // The helper invents a per-request `anon:<uuid>` when it cannot identify
  // the caller, which is right for a rate-limit bucket and wrong for a
  // stored hash — it would look like a distinct visitor every time. An
  // unidentifiable caller records no ip_hash, same as before.
  const ipHeader = clientIp.startsWith('anon:') ? null : clientIp
  const uaHeader = request.headers.get('user-agent')
  const ipHash = hashIp(ipHeader, ingestKey)
  const userAgentHash = hashUserAgent(uaHeader ?? null, ingestKey)

  const occurredAt = clampOccurredAt(payload.ts)

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
