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
import { readFileSync } from 'node:fs'

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
 * If a wedding has BOTH tour_completed and tour_cancelled with
 * occurred_at / metadata.event_datetime within 6h of each other,
 * the tour_completed is the false-positive — delete it.
 */
async function findFalseTourCompletedRows(): Promise<string[]> {
  const remove: string[] = []
  let cancelQuery = sb
    .from('engagement_events')
    .select('id, venue_id, wedding_id, event_type, occurred_at, metadata')
    .eq('event_type', 'tour_cancelled')
    .not('wedding_id', 'is', null)
  if (scopedVenueId) cancelQuery = cancelQuery.eq('venue_id', scopedVenueId)
  const { data: cancelRows } = await cancelQuery

  for (const cancel of ((cancelRows ?? []) as EngagementRow[])) {
    const cancelDt = (cancel.metadata?.event_datetime as string | undefined) ?? cancel.occurred_at
    if (!cancelDt) continue
    const cancelMs = Date.parse(cancelDt)
    if (!Number.isFinite(cancelMs)) continue

    const { data: completedRows } = await sb
      .from('engagement_events')
      .select('id, occurred_at, metadata')
      .eq('venue_id', cancel.venue_id)
      .eq('wedding_id', cancel.wedding_id!)
      .eq('event_type', 'tour_completed')

    for (const c of ((completedRows ?? []) as Array<{ id: string; occurred_at: string | null; metadata: Record<string, unknown> | null }>)) {
      const compDt = (c.metadata?.event_datetime as string | undefined) ?? c.occurred_at
      if (!compDt) continue
      const compMs = Date.parse(compDt)
      if (!Number.isFinite(compMs)) continue
      if (Math.abs(compMs - cancelMs) < 6 * 60 * 60 * 1000) {
        remove.push(c.id)
        console.log(
          `[dedup] tour_completed on wedding ${cancel.wedding_id} at ${compDt} ` +
          `matches tour_cancelled at ${cancelDt} (within 6h) — removing as false-positive`,
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

  // Capture affected weddings BEFORE delete so we can recalc.
  const affectedWeddings = new Set<string>()
  const CHUNK = 500
  for (let i = 0; i < allRemove.length; i += CHUNK) {
    const chunk = allRemove.slice(i, i + CHUNK)
    const { data } = await sb
      .from('engagement_events')
      .select('wedding_id')
      .in('id', chunk)
    for (const r of ((data ?? []) as Array<{ wedding_id: string | null }>)) {
      if (r.wedding_id) affectedWeddings.add(r.wedding_id)
    }
  }

  console.log(`\nDeleting ${allRemove.length} rows…`)
  let deleted = 0
  for (let i = 0; i < allRemove.length; i += CHUNK) {
    const chunk = allRemove.slice(i, i + CHUNK)
    const { error } = await sb.from('engagement_events').delete().in('id', chunk)
    if (error) {
      console.error(`Delete chunk ${i} failed:`, error.message)
    } else {
      deleted += chunk.length
    }
  }
  console.log(`Deleted ${deleted} rows.`)

  await recalcAffectedWeddings(affectedWeddings)
  console.log('\nDone.')
})().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
