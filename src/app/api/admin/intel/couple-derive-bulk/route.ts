/**
 * Wave 5A — per-couple intel derive bulk endpoint.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 5A action layer)
 *   - bloom-wave4-5-6-master-plan.md (Wave 5A spec)
 *
 * Auth (mirrors /api/admin/identity/reconstruct-bulk):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId REQUIRED
 *     in body so the operator picks a target venue explicitly.
 *   - else getPlatformAuth (coordinator UI). venueId is taken from
 *     auth; any explicit body.venueId is ignored.
 *
 * POST body:
 *   {
 *     venueId?: string,
 *     limit?: number,
 *     offset?: number,
 *     force?: boolean,
 *     mode?: 'enqueue' | 'sync'
 *   }
 *
 * mode='enqueue' (recommended):
 *   - Iterates non-tombstoned weddings in venue that already have a
 *     couple_identity_profile row, ordered by last_reconstructed_at
 *     desc (fresh profiles first).
 *   - For each, calls enqueueCoupleIntel (24h dedupe per wedding).
 *     Cron sweep picks them up over time.
 *
 * mode='sync' (small targeted batches; bounded by maxDuration):
 *   - Calls deriveCoupleIntel inline per wedding.
 *   - Honours force: when false, skips weddings whose last_derived_at
 *     is within 24h.
 *   - Returns succeeded / failed counts plus aggregate cost.
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
import {
  deriveCoupleIntel,
  getStoredCoupleIntel,
} from '@/lib/services/intel/per-couple-derive'
import { enqueueCoupleIntel } from '@/lib/services/intel/enqueue-couple-intel'

export const maxDuration = 300

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const SYNC_TIMEBOX_MS = 280_000

const SYNC_FRESH_WINDOW_MS = 24 * 60 * 60 * 1000

interface BulkBody {
  venueId?: string
  limit?: number
  offset?: number
  force?: boolean
  mode?: 'enqueue' | 'sync'
}

interface AuthContext {
  isCron: boolean
  venueId: string
}

async function resolveAuth(
  req: NextRequest,
  body: BulkBody,
): Promise<{ ctx: AuthContext } | NextResponse> {
  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (cronAuth) {
    if (!body.venueId || typeof body.venueId !== 'string') {
      return badRequest('CRON_SECRET path requires venueId in body')
    }
    return { ctx: { isCron: true, venueId: body.venueId } }
  }

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot run bulk couple intel derive')
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  return { ctx: { isCron: false, venueId: auth.venueId } }
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(n), MAX_LIMIT)
}

function clampOffset(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
}

interface ProfilePick {
  wedding_id: string
}

export async function POST(req: NextRequest) {
  let body: BulkBody = {}
  try {
    body = (await req.json()) as BulkBody
  } catch {
    body = {}
  }

  const authResolved = await resolveAuth(req, body)
  if (authResolved instanceof NextResponse) return authResolved
  const { venueId } = authResolved.ctx

  const limit = clampLimit(body.limit ?? DEFAULT_LIMIT)
  const offset = clampOffset(body.offset ?? 0)
  const mode: 'enqueue' | 'sync' = body.mode === 'sync' ? 'sync' : 'enqueue'
  const force = body.force === true

  const supabase = createServiceClient()

  // Confirm the venue exists.
  const { data: venueRow } = await supabase
    .from('venues')
    .select('id')
    .eq('id', venueId)
    .maybeSingle()
  if (!venueRow) return notFound('venue')

  // Total count of profiles available for derive.
  const { count: totalCount } = await supabase
    .from('couple_identity_profile')
    .select('wedding_id', { count: 'exact', head: true })
    .eq('venue_id', venueId)

  // Page of weddings to process — restrict to those that already have a
  // forensic profile (Wave 4 must run first).
  const { data: profiles, error: pageErr } = await supabase
    .from('couple_identity_profile')
    .select('wedding_id')
    .eq('venue_id', venueId)
    .order('last_reconstructed_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (pageErr) {
    return NextResponse.json(
      { ok: false, error: `profile page fetch failed: ${pageErr.message}` },
      { status: 500 },
    )
  }

  const rows = (profiles ?? []) as ProfilePick[]

  const startedAt = Date.now()
  const result = {
    ok: true,
    mode,
    venueId,
    limit,
    offset,
    totalCount: totalCount ?? 0,
    processed: 0,
    enqueued: 0,
    succeeded: 0,
    failed: 0,
    skipped_dedupe: 0,
    skipped_fresh: 0,
    timeboxed: false,
    costCents: 0,
    hasMore: false,
    nextOffset: offset + rows.length,
    failures: [] as Array<{ weddingId: string; error: string }>,
  }

  if (mode === 'enqueue') {
    for (const p of rows) {
      result.processed += 1
      const r = await enqueueCoupleIntel({
        weddingId: p.wedding_id,
        venueId,
        triggerSignal: 'manual_bulk',
        supabase,
      })
      if (r.skipped) {
        if (r.reason === 'dedupe_24h') result.skipped_dedupe += 1
        else result.failed += 1
      } else {
        result.enqueued += 1
      }
    }
  } else {
    for (const p of rows) {
      if (Date.now() - startedAt >= SYNC_TIMEBOX_MS) {
        result.timeboxed = true
        break
      }
      result.processed += 1

      if (!force) {
        const stored = await getStoredCoupleIntel(p.wedding_id, { supabase })
        if (stored) {
          const last = Date.parse(stored.lastDerivedAt)
          if (Number.isFinite(last) && Date.now() - last < SYNC_FRESH_WINDOW_MS) {
            result.skipped_fresh += 1
            continue
          }
        }
      }

      try {
        const out = await deriveCoupleIntel(p.wedding_id, { supabase })
        result.succeeded += 1
        result.costCents += out.costCents
      } catch (err) {
        result.failed += 1
        result.failures.push({
          weddingId: p.wedding_id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  result.hasMore =
    result.totalCount > 0 && offset + rows.length < (result.totalCount ?? 0)
  result.costCents = Math.round(result.costCents * 10_000) / 10_000

  return NextResponse.json(result)
}
