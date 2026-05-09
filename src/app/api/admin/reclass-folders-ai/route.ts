// ---------------------------------------------------------------------------
// /api/admin/reclass-folders-ai -- one-shot AI reclassification of inbox
// rows currently bucketed as 'other'.
// ---------------------------------------------------------------------------
//
// Live rule chain in lifecycle.ts handles ~50% of Isadora's inbox cleanly,
// but the long tail (vendors not linked to people.role='vendor', cold
// SaaS spam from random gmail accounts) ends up in 'other'. This endpoint
// lets an admin sweep the existing 'other' rows through Haiku to relabel
// the high-confidence ones.
//
// Auth: any authenticated venue user. The query is hard-scoped to the
// caller's auth.venueId so a venue owner can only reclass their own
// inbox -- no cross-venue blast radius. Demo mode is rejected.
// (Initial spec gated this to super_admin but Isadora is the venue
// owner not a platform super_admin and got 403'd; the per-venue scope
// is the real safety boundary, not the role.)
//
// Behaviour:
//   - Selects interactions where lifecycle_folder='other' AND from_email
//     IS NOT NULL AND length(full_body) >= 30 AND venue_id matches the
//     caller's auth.venueId, ordered by created_at desc.
//   - Processes in batches of {batchSize} (default 20, max 50). Each row
//     gets one Haiku call. Total scanned capped at {maxRows} (default
//     2000, max 5000).
//   - Updates lifecycle_folder ONLY when AI confidence >= 70 AND the new
//     folder is not 'other'. Anything below the bar is left alone.
//   - Wraps every per-row AI call in try/catch. A single failure logs
//     and skips that row -- the sweep never aborts mid-batch.
//
// Cost ceiling: ~$0.0003/Haiku call. 2000 rows = $0.60 worst case.
// ---------------------------------------------------------------------------

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import { classifyFolderAI } from '@/lib/services/inbox/folder-ai-classifier'
import type { LifecycleFolder } from '@/lib/services/inbox/lifecycle'
import { promoteVendorDomain } from '@/lib/services/inbox/vendor-domains'

// 5-minute cap. Vercel Pro functions allow up to 300s. A full 2000-row
// sweep at 200ms/row = 400s, so the UI must call with a smaller cap if
// it wants to finish in one request -- the endpoint will return early
// when the budget is hit.
export const maxDuration = 300

const DEFAULT_BATCH_SIZE = 20
const MAX_BATCH_SIZE = 50
const DEFAULT_MAX_ROWS = 2000
const HARD_MAX_ROWS = 5000
const CONFIDENCE_THRESHOLD = 70
// Vendor-domain auto-promotion uses a stricter bar than reclass.
// Reclass at ≥ 70 is safe because we're labelling ONE row; auto-promoting
// a domain to the venue's vendor allow-list affects every FUTURE email
// from that domain, so we want a clearly-confident Haiku call. Mismatch
// the constants on purpose — the comment is the spec.
const VENDOR_PROMOTION_THRESHOLD = 80
// Stop processing new batches when the elapsed time crosses this bound.
// Leaves headroom for the final batch + JSON serialization before the
// platform's 300s wall.
const TIME_BUDGET_MS = 280_000

interface ReclassRow {
  id: string
  venue_id: string
  from_email: string | null
  from_name: string | null
  subject: string | null
  full_body: string | null
  direction: string | null
}

export async function POST(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot reclass live rows')
  if (!auth.venueId) return forbidden('no venue scope on session')

  const body = (await req.json().catch(() => null)) as
    | { batchSize?: number; maxRows?: number }
    | null
  const batchSize = clampInt(
    body?.batchSize,
    DEFAULT_BATCH_SIZE,
    1,
    MAX_BATCH_SIZE,
  )
  const maxRows = clampInt(
    body?.maxRows,
    DEFAULT_MAX_ROWS,
    1,
    HARD_MAX_ROWS,
  )

  const venueId = auth.venueId
  if (!venueId) return badRequest('caller has no resolved venue')

  const supabase = createServiceClient()
  const startedAt = Date.now()

  // Pull the candidate set. We only need fields the classifier reads +
  // the id for the update. Order by created_at desc so the most recent
  // misclassifications get fixed first (newer rows are higher value to
  // a coordinator triaging today's inbox).
  // Restrict to inbound only. Outbound rows are messages WE sent
  // (Sage nurture sequences, coordinator replies). Classifying them
  // as "new inquiries" or "vendors" makes no sense — they are our
  // own voice. The lifecycle_folder column is per-thread so the
  // inbound row's classification represents the thread; outbound
  // rows can stay 'other' without harm.
  const { data: rows, error } = await supabase
    .from('interactions')
    .select('id, venue_id, from_email, from_name, subject, full_body, direction')
    .eq('venue_id', venueId)
    .eq('type', 'email')
    .eq('direction', 'inbound')
    .eq('lifecycle_folder', 'other')
    .not('from_email', 'is', null)
    .not('full_body', 'is', null)
    .order('created_at', { ascending: false })
    .limit(maxRows)

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    )
  }

  // Filter the body-length floor in JS rather than SQL. Postgres has a
  // length() filter but PostgREST's not.is.null + length() chain needs
  // an or() expression that's brittle; the JS filter is bounded by
  // maxRows anyway so the cost is negligible.
  const candidates = (rows ?? []).filter(
    (r) =>
      typeof r.full_body === 'string' &&
      r.full_body.length >= 30 &&
      typeof r.from_email === 'string' &&
      r.from_email.length > 0,
  ) as ReclassRow[]

  let scanned = 0
  let updated = 0
  let aiErrors = 0
  let lowConfidence = 0
  let vendorDomainsPromoted = 0
  // Track domains already promoted in this sweep so a venue with 47
  // Gibson Rental emails fires one upsert, not 47. Carries across
  // batches for the lifetime of the request.
  const firedVendorDomains = new Set<string>()
  const byFolder: Record<string, number> = {
    new_inquiry: 0,
    potential_client: 0,
    vendor: 0,
    advertiser: 0,
    other: 0,
  }

  for (let i = 0; i < candidates.length; i += batchSize) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) break

    const batch = candidates.slice(i, i + batchSize)

    // Process each row in parallel within a batch. Haiku tolerates this
    // easily and the per-call cost-tracker writes are async fire-and-forget.
    const results = await Promise.all(
      batch.map(async (row) => {
        scanned += 1
        try {
          const direction =
            row.direction === 'outbound' ? 'outbound' : 'inbound'
          const ai = await classifyFolderAI(
            venueId,
            {
              from: row.from_email ?? '',
              fromName: row.from_name ?? null,
              subject: row.subject ?? null,
              body: row.full_body ?? '',
              direction,
            },
            { correlationId: `reclass-folders-ai-${startedAt}` },
          )
          return { row, ai }
        } catch (err) {
          aiErrors += 1
          console.warn('[reclass-folders-ai] classifier threw', {
            id: row.id,
            err: err instanceof Error ? err.message : 'unknown',
          })
          return null
        }
      }),
    )

    // Group acceptable updates by target folder so we can issue a small
    // number of UPDATE statements rather than one per row.
    const updatesByFolder = new Map<LifecycleFolder, string[]>()

    for (const result of results) {
      if (!result) continue
      const { row, ai } = result
      if (ai.folder === 'other') {
        byFolder.other += 1
        continue
      }
      if (ai.confidence < CONFIDENCE_THRESHOLD) {
        lowConfidence += 1
        continue
      }
      const list = updatesByFolder.get(ai.folder) ?? []
      list.push(row.id)
      updatesByFolder.set(ai.folder, list)
    }

    // Vendor-domain auto-promotion (mig 258). Stricter confidence bar
    // than reclass (80 vs 70) because promoting a domain affects every
    // FUTURE email from it. Collect distinct domains in this batch
    // first, then fire one upsert per new-this-sweep domain. firedVendorDomains
    // dedupes across batches for the lifetime of the request.
    const batchDomainsToPromote = new Set<string>()
    for (const result of results) {
      if (!result) continue
      const { row, ai } = result
      if (ai.folder !== 'vendor') continue
      if (ai.confidence < VENDOR_PROMOTION_THRESHOLD) continue
      const fromEmail = (row.from_email ?? '').toLowerCase().trim()
      const at = fromEmail.lastIndexOf('@')
      const domain = at > 0 ? fromEmail.slice(at + 1) : ''
      if (!domain) continue
      if (firedVendorDomains.has(domain)) continue
      batchDomainsToPromote.add(domain)
    }
    for (const domain of batchDomainsToPromote) {
      firedVendorDomains.add(domain)
      try {
        const ok = await promoteVendorDomain({
          venueId,
          domain,
          confidence: VENDOR_PROMOTION_THRESHOLD,
          source: 'ai_classifier',
        })
        if (ok) vendorDomainsPromoted += 1
      } catch (err) {
        console.warn('[reclass-folders-ai] vendor-domain promotion failed', {
          domain,
          err: err instanceof Error ? err.message : 'unknown',
        })
      }
    }

    // Issue one UPDATE per target folder. Each update is scoped to the
    // caller's venue and the ids we just classified -- no risk of
    // re-stamping an already-correct row.
    for (const [folder, ids] of updatesByFolder) {
      if (ids.length === 0) continue
      const { error: updErr } = await supabase
        .from('interactions')
        .update({ lifecycle_folder: folder })
        .eq('venue_id', venueId)
        .in('id', ids)
      if (updErr) {
        console.warn('[reclass-folders-ai] update failed', {
          folder,
          count: ids.length,
          err: updErr.message,
        })
        continue
      }
      updated += ids.length
      byFolder[folder] = (byFolder[folder] ?? 0) + ids.length
    }
  }

  const durationMs = Date.now() - startedAt
  return NextResponse.json({
    ok: true,
    scanned,
    updated,
    vendor_domains_promoted: vendorDomainsPromoted,
    by_folder: byFolder,
    ai_errors: aiErrors,
    low_confidence: lowConfidence,
    duration_ms: durationMs,
    candidate_pool: candidates.length,
  })
}

function clampInt(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}
