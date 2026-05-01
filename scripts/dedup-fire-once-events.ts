/**
 * One-shot maintenance: dedup engagement_events for fire-once-per-wedding
 * event types (heat-map fix 2026-05-01).
 *
 * Pre-fix the signal-inference + email-pipeline F6 paths re-emitted
 * tour_requested / high_commitment_signal / family_mentioned /
 * high_specificity / not_interested_signal / tour_cancelled on every
 * matching reply. The Courtney Heiner case (RM-0033) showed 4×
 * tour_requested events firing across Mar 7 / Mar 14 / Mar 24 / Apr 26
 * replies, each adding +15 to the heat score. This script collapses
 * these to one row per (wedding_id, event_type) — keeping the EARLIEST
 * occurrence, deleting the later duplicates — then recalculates heat
 * scores for every affected wedding.
 *
 * Also unwinds the tour_completed-after-cancellation bug: when both
 * tour_completed and tour_cancelled exist for the same wedding with
 * eventDatetime within 6h of each other, the tour_completed row is
 * the false-positive (auto-promoted past the cancellation) and is
 * deleted.
 *
 * Idempotent — safe to re-run.
 *
 * Usage:
 *   npx tsx scripts/dedup-fire-once-events.ts              # report only
 *   npx tsx scripts/dedup-fire-once-events.ts --apply      # actually delete
 *   npx tsx scripts/dedup-fire-once-events.ts --venue <id> # scope to one venue
 */

import { createClient } from '@supabase/supabase-js'
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
} from 'node:fs'
import { join } from 'node:path'

// Checkpoint file — lets the script resume safely after a mid-run
// crash. Without this, a crash after deleting some rows but before
// recalculating heat leaves scores inconsistent. With this, re-
// running picks up where it left off (skips already-deleted ids,
// skips already-recalced weddings).
const CHECKPOINT_DIR = '.dedup-checkpoint'
const DELETED_FILE = join(CHECKPOINT_DIR, 'deleted-ids.txt')
const RECALCED_FILE = join(CHECKPOINT_DIR, 'recalced-wedding-ids.txt')

function loadCheckpoint(file: string): Set<string> {
  try {
    if (!existsSync(file)) return new Set()
    const content = readFileSync(file, 'utf8')
    return new Set(content.split('\n').map((l) => l.trim()).filter(Boolean))
  } catch {
    return new Set()
  }
}
function appendCheckpoint(file: string, ids: string[]): void {
  if (!existsSync(CHECKPOINT_DIR)) mkdirSync(CHECKPOINT_DIR, { recursive: true })
  appendFileSync(file, ids.map((id) => `${id}\n`).join(''))
}

void writeFileSync // touch to satisfy bundler — kept for future ad-hoc resets

const FIRE_ONCE_TYPES = [
  'tour_requested',
  'high_commitment_signal',
  'family_mentioned',
  'high_specificity',
  'not_interested_signal',
  'tour_cancelled',
] as const

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    }),
)

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const venueIdx = args.indexOf('--venue')
const scopedVenueId = venueIdx >= 0 ? args[venueIdx + 1] : null

interface EngagementRow {
  id: string
  venue_id: string
  wedding_id: string | null
  event_type: string
  occurred_at: string | null
  created_at: string
  metadata: Record<string, unknown> | null
}

async function findFireOnceDuplicates(): Promise<{ keep: string[]; remove: string[] }> {
  const remove: string[] = []
  const keep: string[] = []

  for (const eventType of FIRE_ONCE_TYPES) {
    let query = sb
      .from('engagement_events')
      .select('id, venue_id, wedding_id, event_type, occurred_at, created_at, metadata')
      .eq('event_type', eventType)
      .not('wedding_id', 'is', null)
      .order('occurred_at', { ascending: true })
    if (scopedVenueId) query = query.eq('venue_id', scopedVenueId)
    const { data } = await query
    const rows = ((data ?? []) as EngagementRow[]).filter((r) => r.wedding_id)
    if (rows.length === 0) continue

    // Group by wedding_id; keep the earliest, remove the rest.
    const byWedding = new Map<string, EngagementRow[]>()
    for (const r of rows) {
      const arr = byWedding.get(r.wedding_id!) ?? []
      arr.push(r)
      byWedding.set(r.wedding_id!, arr)
    }
    for (const [, list] of byWedding) {
      if (list.length <= 1) {
        keep.push(list[0].id)
        continue
      }
      list.sort((a, b) => {
        const aT = a.occurred_at ? Date.parse(a.occurred_at) : Date.parse(a.created_at)
        const bT = b.occurred_at ? Date.parse(b.occurred_at) : Date.parse(b.created_at)
        return aT - bT
      })
      keep.push(list[0].id)
      for (let i = 1; i < list.length; i++) remove.push(list[i].id)
      console.log(
        `[dedup] ${eventType} on wedding ${list[0].wedding_id}: ` +
        `${list.length} rows → keeping ${list[0].id} (earliest), removing ${list.length - 1}`,
      )
    }
  }
  return { keep, remove }
}

/**
 * tour_completed rows that auto-promoted past a cancellation.
 * Match strategies (any one suffices):
 *   1. gmail_thread_id linkage — strongest. Resolved via interactions.
 *   2. metadata.event_datetime equality / within 14 days — same
 *      tolerance as the live cancellation guard. Pre-fix this was
 *      6h which missed real cancel-arrival → tour-datetime gaps.
 *   3. occurred_at within 14 days.
 */
async function findFalseTourCompletedRows(): Promise<string[]> {
  const remove: string[] = []
  const TOLERANCE_MS = 14 * 24 * 60 * 60 * 1000
  let cancelQuery = sb
    .from('engagement_events')
    .select('id, venue_id, wedding_id, event_type, occurred_at, metadata')
    .eq('event_type', 'tour_cancelled')
    .not('wedding_id', 'is', null)
  if (scopedVenueId) cancelQuery = cancelQuery.eq('venue_id', scopedVenueId)
  const { data: cancelRows } = await cancelQuery

  for (const cancel of ((cancelRows ?? []) as EngagementRow[])) {
    const cancelDt = (cancel.metadata?.event_datetime as string | undefined) ?? cancel.occurred_at
    const cancelMs = cancelDt ? Date.parse(cancelDt) : NaN
    const cancelInteractionId = (cancel.metadata?.interaction_id as string | undefined) ?? null

    let cancelThreadId: string | null = null
    if (cancelInteractionId) {
      const { data: cancelIx } = await sb
        .from('interactions')
        .select('gmail_thread_id')
        .eq('id', cancelInteractionId)
        .maybeSingle()
      cancelThreadId = (cancelIx?.gmail_thread_id as string | null) ?? null
    }

    const { data: completedRows } = await sb
      .from('engagement_events')
      .select('id, occurred_at, metadata')
      .eq('venue_id', cancel.venue_id)
      .eq('wedding_id', cancel.wedding_id!)
      .eq('event_type', 'tour_completed')

    for (const c of ((completedRows ?? []) as Array<{ id: string; occurred_at: string | null; metadata: Record<string, unknown> | null }>)) {
      const compInteractionId = (c.metadata?.interaction_id as string | undefined) ?? null
      const compDt = (c.metadata?.event_datetime as string | undefined) ?? c.occurred_at
      const compMs = compDt ? Date.parse(compDt) : NaN

      let matched = false
      let matchReason = ''

      if (cancelThreadId && compInteractionId) {
        const { data: compIx } = await sb
          .from('interactions')
          .select('gmail_thread_id')
          .eq('id', compInteractionId)
          .maybeSingle()
        const compThread = (compIx?.gmail_thread_id as string | null) ?? null
        if (compThread && compThread === cancelThreadId) {
          matched = true
          matchReason = `thread=${compThread.slice(0, 12)}…`
        }
      }

      if (!matched && Number.isFinite(cancelMs) && Number.isFinite(compMs)) {
        if (Math.abs(compMs - cancelMs) < TOLERANCE_MS) {
          matched = true
          const days = Math.round(Math.abs(compMs - cancelMs) / 86400000)
          matchReason = `${days}d apart`
        }
      }

      if (matched) {
        remove.push(c.id)
        console.log(
          `[dedup] tour_completed on wedding ${cancel.wedding_id} ` +
          `matches tour_cancelled (${matchReason}) — removing as false-positive`,
        )
      }
    }
  }
  return remove
}

async function recalcAffectedWeddings(weddingIds: Set<string>): Promise<void> {
  if (weddingIds.size === 0) return
  const { recalculateHeatScore } = await import('../src/lib/services/heat-mapping')
  console.log(`[dedup] recalculating heat for ${weddingIds.size} affected weddings…`)
  let done = 0
  // Need venue_id per wedding for the recalc call. Fetch in one batch.
  const ids = Array.from(weddingIds)
  const { data: weddings } = await sb
    .from('weddings')
    .select('id, venue_id')
    .in('id', ids)
  const venueByWedding = new Map<string, string>()
  for (const w of ((weddings ?? []) as Array<{ id: string; venue_id: string }>)) {
    venueByWedding.set(w.id, w.venue_id)
  }
  for (const wid of weddingIds) {
    const vid = venueByWedding.get(wid)
    if (!vid) {
      console.warn(`  no venue_id for wedding ${wid} — skipping recalc`)
      continue
    }
    try {
      await recalculateHeatScore(vid, wid)
      // Record per-wedding so a crash mid-batch can resume.
      try { appendCheckpoint(RECALCED_FILE, [wid]) } catch { /* checkpoint optional */ }
      done++
    } catch (err) {
      console.warn(`  recalc failed for ${wid}:`, err instanceof Error ? err.message : err)
    }
  }
  console.log(`[dedup] recalc done: ${done}/${weddingIds.size}`)
}

;(async () => {
  console.log(`Mode: ${apply ? 'APPLY (deleting duplicates)' : 'REPORT-ONLY (dry run)'}`)
  if (scopedVenueId) console.log(`Scope: venue=${scopedVenueId}`)

  console.log('\n=== Pass 1: fire-once-per-wedding type duplicates ===')
  const { remove: dupIds } = await findFireOnceDuplicates()

  console.log('\n=== Pass 2: tour_completed-after-cancellation false positives ===')
  const falseCompleted = await findFalseTourCompletedRows()

  const allRemove = [...new Set([...dupIds, ...falseCompleted])]
  console.log(`\nTotal rows to remove: ${allRemove.length}`)

  if (allRemove.length === 0) {
    console.log('Nothing to do.')
    process.exit(0)
  }

  if (!apply) {
    console.log('Re-run with --apply to actually delete.')
    process.exit(0)
  }

  const alreadyDeleted = loadCheckpoint(DELETED_FILE)
  const alreadyRecalced = loadCheckpoint(RECALCED_FILE)
  const toDelete = allRemove.filter((id) => !alreadyDeleted.has(id))
  if (alreadyDeleted.size > 0) {
    console.log(`[checkpoint] resuming — ${alreadyDeleted.size} rows already deleted in prior run; ${toDelete.length} remain`)
  }

  // Capture affected weddings BEFORE delete so we can recalc.
  const affectedWeddings = new Set<string>()
  const CHUNK = 500
  for (let i = 0; i < toDelete.length; i += CHUNK) {
    const chunk = toDelete.slice(i, i + CHUNK)
    const { data } = await sb
      .from('engagement_events')
      .select('wedding_id')
      .in('id', chunk)
    for (const r of ((data ?? []) as Array<{ wedding_id: string | null }>)) {
      if (r.wedding_id) affectedWeddings.add(r.wedding_id)
    }
  }

  console.log(`\nDeleting ${toDelete.length} rows (chunks of ${CHUNK})…`)
  let deleted = 0
  for (let i = 0; i < toDelete.length; i += CHUNK) {
    const chunk = toDelete.slice(i, i + CHUNK)
    const { error } = await sb.from('engagement_events').delete().in('id', chunk)
    if (error) {
      console.error(`Delete chunk ${i} failed:`, error.message)
      console.error('Stopping. Re-run to resume from checkpoint.')
      process.exit(1)
    }
    appendCheckpoint(DELETED_FILE, chunk)
    deleted += chunk.length
    if (i % 5000 === 0 && i > 0) console.log(`  deleted ${deleted}/${toDelete.length}`)
  }
  console.log(`Deleted ${deleted} rows.`)

  // Recalc affected weddings, skipping any already done in a prior run.
  const weddingsToRecalc = new Set([...affectedWeddings].filter((w) => !alreadyRecalced.has(w)))
  if (alreadyRecalced.size > 0) {
    console.log(`[checkpoint] ${alreadyRecalced.size} weddings already recalced; ${weddingsToRecalc.size} remain`)
  }
  await recalcAffectedWeddings(weddingsToRecalc)

  console.log('\nDone.')
  console.log(`Checkpoint files retained at ${CHECKPOINT_DIR}/ for audit. Delete to start fresh.`)
})().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
