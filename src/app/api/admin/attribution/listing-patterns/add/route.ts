/**
 * Wave 23 — Operator pattern-curation endpoint (add).
 *
 * POST: paste a new template pattern for a specific listing platform.
 *
 * Body:
 *   {
 *     venueId?: string,         // omit for cron path
 *     platform: ListingPlatform,
 *     patternType: 'exact_phrase' | 'regex' | 'similarity_threshold',
 *     patternValue: string,
 *     weight?: number,          // default 60; clamped to [0, 100]
 *     scope?: 'venue' | 'global', // default 'venue' for coordinator path,
 *                                 // 'global' is super-admin only
 *     source?: string,          // free-text audit label; defaults to 'operator_paste'
 *   }
 *
 * Auth:
 *   - Authorization: Bearer ${CRON_SECRET} → ops path; venueId required;
 *     scope='venue' enforced (cron should not silently mutate globals).
 *   - else getPlatformAuth (coordinator UI). venueId taken from auth.
 *     scope='global' requires role='super_admin'.
 *
 * Anchor docs:
 *   - bloom-constitution.md (operator-curated forensic signals; the
 *     pattern table is the human knob on top of the deterministic
 *     detector)
 *   - listing-platform-detector.ts (consumer)
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
  notFound,
} from '@/lib/api/auth-helpers'

export const maxDuration = 30

// Mirror of listing-platform-detector's ListingPlatform — kept in
// sync with migration 289's CHECK constraint. Keeping it duplicated
// here (instead of importing the TS type) lets us validate at the
// edge without pulling the detector into the route module's bundle.
const PLATFORM_VALUES = [
  'the_knot',
  'weddingwire',
  'hctg',
  'brides_com',
  'zola',
  'junebug',
  'carats_cake',
  'style_me_pretty',
  'other',
] as const
type PlatformValue = typeof PLATFORM_VALUES[number]

const PATTERN_TYPES = ['exact_phrase', 'regex', 'similarity_threshold'] as const
type PatternType = typeof PATTERN_TYPES[number]

interface AddBody {
  venueId?: string
  platform?: string
  patternType?: string
  patternValue?: string
  weight?: number
  scope?: 'venue' | 'global'
  source?: string
}

interface AuthCtx {
  isCron: boolean
  isSuperAdmin: boolean
  venueId: string
}

async function resolveAuth(
  req: NextRequest,
  body: AddBody,
): Promise<{ ctx: AuthCtx } | NextResponse> {
  const cronAuth = req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (cronAuth) {
    if (!body.venueId || typeof body.venueId !== 'string') {
      return badRequest('CRON_SECRET path requires venueId in body')
    }
    if (body.scope === 'global') {
      return forbidden('cron path may not create global patterns')
    }
    return { ctx: { isCron: true, isSuperAdmin: false, venueId: body.venueId } }
  }
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot curate listing patterns')
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  return {
    ctx: {
      isCron: false,
      isSuperAdmin: auth.role === 'super_admin',
      venueId: auth.venueId,
    },
  }
}

function isPlatform(v: unknown): v is PlatformValue {
  return typeof v === 'string' && (PLATFORM_VALUES as readonly string[]).includes(v)
}

function isPatternType(v: unknown): v is PatternType {
  return typeof v === 'string' && (PATTERN_TYPES as readonly string[]).includes(v)
}

function clampWeight(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return 60
  return Math.max(0, Math.min(100, Math.round(n)))
}

export async function POST(req: NextRequest) {
  let body: AddBody = {}
  try {
    body = (await req.json()) as AddBody
  } catch {
    return badRequest('invalid JSON body')
  }

  const authResolved = await resolveAuth(req, body)
  if (authResolved instanceof NextResponse) return authResolved
  const ctx = authResolved.ctx

  if (!isPlatform(body.platform)) {
    return badRequest(`platform must be one of: ${PLATFORM_VALUES.join(', ')}`)
  }
  if (!isPatternType(body.patternType)) {
    return badRequest(`patternType must be one of: ${PATTERN_TYPES.join(', ')}`)
  }
  if (typeof body.patternValue !== 'string' || body.patternValue.trim().length === 0) {
    return badRequest('patternValue required (non-empty string)')
  }
  // Defensive: cap pattern length so a coordinator pasting a whole
  // email body doesn't poison the detector with a 5kb substring
  // search.
  if (body.patternValue.length > 500) {
    return badRequest('patternValue too long; cap is 500 chars')
  }

  // Regex sanity check at edge — compile to surface bad patterns
  // before they hit the detector loop.
  if (body.patternType === 'regex') {
    try {
      new RegExp(body.patternValue, 'im')
    } catch (err) {
      return badRequest(
        `regex did not compile: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const scope: 'venue' | 'global' = body.scope === 'global' ? 'global' : 'venue'
  if (scope === 'global' && !ctx.isSuperAdmin) {
    return forbidden('global patterns are super_admin only')
  }

  const weight = clampWeight(body.weight ?? 60)
  const source = (body.source ?? 'operator_paste').slice(0, 64)
  const venueIdToWrite: string | null = scope === 'global' ? null : ctx.venueId

  const sb = createServiceClient()

  // Verify the venue exists when scope='venue'. For cron the body
  // could supply a stale id, and for coordinator UI the trusted id
  // comes from auth — verify both paths.
  if (venueIdToWrite) {
    const { data: venueRow } = await sb
      .from('venues')
      .select('id')
      .eq('id', venueIdToWrite)
      .maybeSingle()
    if (!venueRow) return notFound('venue')
  }

  const { data: inserted, error } = await sb
    .from('listing_platform_patterns')
    .insert({
      venue_id: venueIdToWrite,
      platform: body.platform,
      // platform_canonical intentionally NULL on operator-paste — the
      // canonical domain is informational metadata for seeded rows
      // only; coordinator paste rarely has a domain to attach.
      platform_canonical: null,
      pattern_type: body.patternType,
      pattern_value: body.patternValue,
      weight,
      source,
      enabled: true,
    })
    .select('id, platform, pattern_type, pattern_value, weight, source, enabled, venue_id, created_at')
    .single()

  if (error) {
    return NextResponse.json(
      { ok: false, error: `insert failed: ${error.message}` },
      { status: 500 },
    )
  }

  return NextResponse.json({ ok: true, pattern: inserted })
}
