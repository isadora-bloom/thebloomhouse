/**
 * Wave 4 Identity Reconstruction — bulk endpoint (Phase 2).
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic identity reconstruction)
 *   - bloom-wave4-identity-reconstruction.md (Phase 2 wires bulk +
 *     cron + signal-driven enqueue on top of the Phase 1 foundation)
 *
 * Auth (mirrors /api/admin/identity/reconstruct):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId REQUIRED
 *     in body so the operator picks a target venue explicitly.
 *   - else getPlatformAuth (coordinator UI). venueId is taken from
 *     auth; any explicit body.venueId is ignored.
 *
 * POST body:
 *   {
 *     venueId?: string,                        // required for cron path
 *     limit?: number,                          // default 50, max 200
 *     offset?: number,                         // default 0
 *     force?: boolean,                         // default false (sync mode only)
 *     mode?: 'enqueue' | 'sync'                // default 'enqueue'
 *   }
 *
 * mode='enqueue' (recommended for backfill):
 *   - Iterates non-tombstoned weddings in venue, ordered by created_at.
 *   - For each, calls enqueueIdentityReconstruction (24h dedupe per
 *     wedding). Cron sweep picks them up over time.
 *   - Returns counts; the actual LLM work happens in
 *     /api/cron/identity-judge-sweep.
 *   - Caller can paginate via limit/offset to enqueue the entire venue
 *     in chunks.
 *
 * mode='sync' (use for small targeted batches; bounded by maxDuration):
 *   - Calls reconstructCoupleIdentity inline per wedding.
 *   - Honours force: when false, skips weddings whose
 *     last_reconstructed_at is within 24h.
 *   - Returns succeeded / failed counts plus aggregate cost.
 *   - DO NOT use for the 671-wedding backfill — that's what
 *     mode='enqueue' + the cron sweep is for.
 *
 * Phase 2 scope: bulk endpoint enables an operator to backfill an
 * entire venue. It does NOT auto-fire a backfill — the operator
 * triggers it.
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
  reconstructCoupleIdentity,
  getStoredCoupleIdentityProfile,
} from '@/lib/services/identity/reconstruct'
import { enqueueIdentityReconstruction } from '@/lib/services/identity/enqueue-reconstruction'

// 5 min — Vercel Pro maxDuration ceiling. Cap inline-mode batch sizes
// so we don't blow this budget mid-sweep.
export const maxDuration = 300

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const SYNC_TIMEBOX_MS = 280_000 // stop launching new work at 280s; 20s buffer

const SYNC_FRESH_WINDOW_MS = 24 * 60 * 60 * 1000

interface BulkBody {
  venueId?: string
  limit?: number
  offset?: number
  force?: boolean
  mode?: 'enqueue' | 'sync'
  /**
   * C2 backfill scope (2026-05-13). When true, the bulk endpoint
   * pre-filters to weddings that DON'T have a couple_identity_profile
   * yet — the Pattern A cohort. Without this filter, an operator
   * running a full backfill would re-enqueue every wedding in the
   * venue (~929 at Rixey) including the 729 that already have profiles,
   * burning ~$0.02 × 729 = $14.58 of unnecessary LLM cost. Drift
   * refresh (judge-sweep, 7d) handles staleness for the already-
   * profiled rows independently.
   */
  onlyMissingProfile?: boolean
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
  if (auth.isDemo) return forbidden('demo cannot run bulk identity reconstruction')
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

interface WeddingPick {
  id: string
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

  // Defensive: confirm the venue exists. Cron path passes raw venueId;
  // a typo would silently sweep zero weddings. notFound() guides the
  // operator to the correct id.
  const { data: venueRow } = await supabase
    .from('venues')
    .select('id')
    .eq('id', venueId)
    .maybeSingle()
  if (!venueRow) return notFound('venue')

  const onlyMissingProfile = body.onlyMissingProfile === true

  // If filtering to weddings without a profile, fetch the set of
  // wedding_ids that DO have one and exclude them. couple_identity_profile
  // is venue-scoped via FK; we filter by venue at read time to keep the
  // exclusion list bounded. Typical venue: 700-1000 profiles, fits in
  // a single PostgREST page.
  let excludeIds = new Set<string>()
  if (onlyMissingProfile) {
    const { data: profileRows } = await supabase
      .from('couple_identity_profile')
      .select('wedding_id')
      .eq('venue_id', venueId)
      .limit(5000)
    excludeIds = new Set(
      (profileRows ?? []).map((r) => r.wedding_id as string),
    )
  }

  // Total count (non-tombstoned) for hasMore / paging UX.
  // When onlyMissingProfile, this is the count BEFORE excluding profiled
  // weddings — paginators should still walk the same range and let the
  // exclusion happen page-by-page.
  const { count: totalCount } = await supabase
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .is('merged_into_id', null)

  // Page of weddings to process.
  // When filtering, over-fetch by 4x so the in-memory exclude doesn't
  // leave the caller with a short page. Capped at MAX_LIMIT * 4 to keep
  // payload bounded.
  const fetchLimit = onlyMissingProfile
    ? Math.min(limit * 4, MAX_LIMIT * 4)
    : limit
  const { data: weddings, error: pageErr } = await supabase
    .from('weddings')
    .select('id')
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
    .order('created_at', { ascending: true })
    .range(offset, offset + fetchLimit - 1)

  if (pageErr) {
    return NextResponse.json(
      { ok: false, error: `wedding page fetch failed: ${pageErr.message}` },
      { status: 500 },
    )
  }

  const rawRows = (weddings ?? []) as WeddingPick[]
  const filteredRows = onlyMissingProfile
    ? rawRows.filter((r) => !excludeIds.has(r.id))
    : rawRows
  const rows = filteredRows.slice(0, limit)
  // Pagination: advance offset by RAW fetched count, not filtered count.
  // If a venue has 800 profiled weddings sorting before 100 unprofiled
  // ones, the first page fetches rows 0-799 raw, filters to 0 after
  // exclusion, but we still need to advance to offset=800 for the
  // next page to surface the unprofiled tail. Bug discovered during
  // step 5 bandaid recheck.
  const nextOffsetAdvance = onlyMissingProfile ? rawRows.length : rows.length

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
    nextOffset: offset + nextOffsetAdvance,
    failures: [] as Array<{ weddingId: string; error: string }>,
  }

  if (mode === 'enqueue') {
    for (const w of rows) {
      result.processed += 1
      const r = await enqueueIdentityReconstruction({
        weddingId: w.id,
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
    // sync mode — bounded inline reconstruction with timebox.
    for (const w of rows) {
      // Respect platform timeout — leave a 20s buffer.
      if (Date.now() - startedAt >= SYNC_TIMEBOX_MS) {
        result.timeboxed = true
        break
      }
      result.processed += 1

      // Skip-fresh check (unless force=true).
      if (!force) {
        const stored = await getStoredCoupleIdentityProfile(w.id, { supabase })
        if (stored) {
          const last = Date.parse(stored.lastReconstructedAt)
          if (Number.isFinite(last) && Date.now() - last < SYNC_FRESH_WINDOW_MS) {
            result.skipped_fresh += 1
            continue
          }
        }
      }

      try {
        const out = await reconstructCoupleIdentity(w.id, { supabase })
        result.succeeded += 1
        result.costCents += out.costCents
      } catch (err) {
        result.failed += 1
        result.failures.push({
          weddingId: w.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  result.hasMore =
    result.totalCount > 0 && offset + nextOffsetAdvance < (result.totalCount ?? 0)
  // Round cost to 4 dp (sub-cent precision matches couple_identity_profile.cost_cents).
  result.costCents = Math.round(result.costCents * 10_000) / 10_000

  return NextResponse.json(result)
}
