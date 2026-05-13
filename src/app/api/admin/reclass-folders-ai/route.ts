// ---------------------------------------------------------------------------
// /api/admin/reclass-folders-ai — historical reclass via the unified
// inbound classifier + deterministic folder writer.
// ---------------------------------------------------------------------------
//
// 2026-05-12 rewrite. The endpoint used to call classifyFolderAI directly
// (the retired 2-call architecture). After folder-AI was retired
// (commit c32b85b), folder = f(intent_class, wedding state) — so a
// reclass is really an INTENT reclass with a folder recompute as a
// downstream effect.
//
// New flow per row:
//   1. Re-run the unified classifier (classifyInboundRaw).
//   2. Force-stamp the new verdict on the row (forceOverwrite: true).
//   3. Recompute the folder via updateThreadLifecycleFolder. The folder
//      writer reads the freshly-stamped intent_class and re-derives the
//      folder deterministically.
//
// Auth: any authenticated venue user, scoped to their own venue. Demo
// blocked. ~$0.0003/row Haiku cost (one call per inbound).
// ---------------------------------------------------------------------------

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import {
  classifyInboundRaw,
  stampInboundVerdict,
} from '@/lib/services/intel/inbound-intent-classifier'
import {
  updateThreadLifecycleFolder,
  type LifecycleFolder,
} from '@/lib/services/inbox/lifecycle'

export const maxDuration = 300

const DEFAULT_BATCH_SIZE = 10
const MAX_BATCH_SIZE = 30
const DEFAULT_MAX_ROWS = 500
const HARD_MAX_ROWS = 5000
const TIME_BUDGET_MS = 280_000

interface ReclassRow {
  id: string
  venue_id: string
  from_email: string | null
  from_name: string | null
  subject: string | null
  full_body: string | null
  direction: string | null
  lifecycle_folder: LifecycleFolder | null
  gmail_thread_id: string | null
  type: string | null
}

export async function POST(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot reclass live rows')
  if (!auth.venueId) return forbidden('no venue scope on session')

  const body = (await req.json().catch(() => null)) as
    | { batchSize?: number; maxRows?: number; sourceFolders?: string[] }
    | null
  const batchSize = clampInt(body?.batchSize, DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE)
  const maxRows = clampInt(body?.maxRows, DEFAULT_MAX_ROWS, 1, HARD_MAX_ROWS)

  const ALLOWED_SOURCE_FOLDERS = new Set<LifecycleFolder>([
    'new_inquiry',
    'potential_client',
    'client',
    'vendor',
    'advertiser',
    'other',
  ])
  const requestedFolders = Array.isArray(body?.sourceFolders) ? body!.sourceFolders : null
  const sourceFolders: LifecycleFolder[] =
    requestedFolders && requestedFolders.length > 0
      ? requestedFolders.filter((f): f is LifecycleFolder =>
          typeof f === 'string' && ALLOWED_SOURCE_FOLDERS.has(f as LifecycleFolder),
        )
      : ['other']

  const venueId = auth.venueId
  if (!venueId) return badRequest('caller has no resolved venue')

  const supabase = createServiceClient()
  const startedAt = Date.now()

  const { data: rows, error } = await supabase
    .from('interactions')
    .select(
      'id, venue_id, from_email, from_name, subject, full_body, direction, lifecycle_folder, gmail_thread_id, type',
    )
    .eq('venue_id', venueId)
    .eq('type', 'email')
    .eq('direction', 'inbound')
    .in('lifecycle_folder', sourceFolders)
    .not('from_email', 'is', null)
    .not('full_body', 'is', null)
    .order('created_at', { ascending: false })
    .limit(maxRows)

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }

  const candidates = (rows ?? []).filter(
    (r) =>
      typeof r.full_body === 'string' &&
      r.full_body.length >= 30 &&
      typeof r.from_email === 'string' &&
      r.from_email.length > 0,
  ) as ReclassRow[]

  let scanned = 0
  let reclassified = 0
  let folderChanged = 0
  let aiErrors = 0
  const folderTransitions: Record<string, number> = {}
  // Dedup thread re-folder work across batches — many inbounds may share
  // a thread, but the folder writer updates every interaction on the
  // thread at once, so we only need to fire updateThreadLifecycleFolder
  // ONCE per gmail_thread_id per sweep.
  const refoldedThreads = new Set<string>()

  for (let i = 0; i < candidates.length; i += batchSize) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) break

    const batch = candidates.slice(i, i + batchSize)

    await Promise.all(
      batch.map(async (row) => {
        scanned += 1
        const correlationId = `reclass-${row.id}-${startedAt}`
        try {
          // Step 1: Re-classify via the unified classifier.
          const verdict = await classifyInboundRaw({
            body: row.full_body,
            subject: row.subject,
            venueId,
            channel: 'email',
            fromEmail: row.from_email,
            correlationId,
          })

          // Step 2: Force-stamp the fresh verdict on the row (overrides
          // any prior intent_class so the folder writer reads the new
          // value).
          await stampInboundVerdict(row.id, verdict, {
            venueId,
            supabase,
            correlationId,
            forceOverwrite: true,
          })

          reclassified += 1
        } catch (err) {
          aiErrors += 1
          console.warn('[reclass-folders-ai] reclassify failed', {
            id: row.id,
            err: err instanceof Error ? err.message : 'unknown',
          })
        }
      }),
    )

    // Step 3: Recompute folder per thread (deduped). updateThreadLifecycleFolder
    // reads the freshly-stamped intent_class + wedding state, then
    // updates every interaction on the thread to the new folder.
    const threadsInBatch = new Set<string | null>()
    for (const row of batch) {
      const key = row.gmail_thread_id ?? `solo:${row.id}`
      if (refoldedThreads.has(key)) continue
      refoldedThreads.add(key)
      threadsInBatch.add(row.gmail_thread_id)
    }

    for (const threadId of threadsInBatch) {
      try {
        const result = await updateThreadLifecycleFolder({
          supabase,
          venueId,
          threadId: threadId ?? null,
          interactionId: threadId ? null : batch.find((r) => !r.gmail_thread_id)?.id ?? null,
        })
        // Track folder transitions. We only know the BATCH started at
        // sourceFolder X; if the new folder is different, count it.
        const newFolder = result.folder
        if (newFolder) {
          // Compare against any row in this batch to detect change.
          const sampleRow = batch.find(
            (r) => (r.gmail_thread_id ?? null) === (threadId ?? null),
          )
          const oldFolder = sampleRow?.lifecycle_folder ?? null
          if (oldFolder && oldFolder !== newFolder) {
            folderChanged += 1
            const key = `${oldFolder}→${newFolder}`
            folderTransitions[key] = (folderTransitions[key] ?? 0) + 1
          }
        }
      } catch (err) {
        console.warn('[reclass-folders-ai] folder recompute failed', {
          threadId,
          err: err instanceof Error ? err.message : 'unknown',
        })
      }
    }
  }

  return NextResponse.json({
    ok: true,
    scanned,
    reclassified,
    folder_changed: folderChanged,
    folder_transitions: folderTransitions,
    ai_errors: aiErrors,
    duration_ms: Date.now() - startedAt,
    candidate_pool: candidates.length,
  })
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}
