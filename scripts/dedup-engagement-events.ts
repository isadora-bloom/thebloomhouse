// One-shot cleanup of duplicate engagement_events. After this runs,
// the live recordEngagementEvent[sBatch] dedup logic prevents new
// duplicates from being created — this script handles the historical
// pile-up from before that landed.
//
// Two duplicate classes:
//   1. ONE_PER_WEDDING_EVENTS (initial_inquiry, sustained_engagement,
//      high_commitment_signal, high_specificity, family_mentioned)
//      — multiple rows on the same wedding. Keep the EARLIEST
//      occurred_at (truest "first" signal) + delete the rest.
//   2. Per-interaction events at identical (event_type, occurred_at)
//      — backfill ran twice, or fix-script created instead of updated.
//      Keep the oldest created_at, delete the rest.
//
// Heat is recalculated for every touched wedding so scores reflect
// the trimmed event list.
//
// Usage:
//   npx tsx scripts/dedup-engagement-events.ts                # dry-run Rixey
//   npx tsx scripts/dedup-engagement-events.ts --apply
//   npx tsx scripts/dedup-engagement-events.ts --apply --all
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { recalculateHeatScore } from '../src/lib/services/heat-mapping'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
  })
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const APPLY = process.argv.includes('--apply')
const ALL = process.argv.includes('--all')
const venueIdx = process.argv.indexOf('--venue')
const CLI_VENUE = venueIdx >= 0 ? process.argv[venueIdx + 1] : null

const ONE_PER_WEDDING_EVENTS = new Set([
  'initial_inquiry',
  'sustained_engagement',
  'high_commitment_signal',
  'high_specificity',
  'family_mentioned',
])

interface Event {
  id: string
  wedding_id: string
  event_type: string
  occurred_at: string | null
  created_at: string
  metadata: Record<string, unknown> | null
}

async function runVenue(venueId: string) {
  console.log(`\n=== Venue ${venueId.slice(0, 8)} — ${APPLY ? 'APPLY' : 'DRY RUN'} ===`)
  const { data: rawEvents } = await sb
    .from('engagement_events')
    .select('id, wedding_id, event_type, occurred_at, created_at, metadata')
    .eq('venue_id', venueId)
  const events = (rawEvents ?? []) as Event[]
  console.log(`  total events: ${events.length}`)

  // Bucket by wedding_id, then by event_type
  const byWedding: Record<string, Record<string, Event[]>> = {}
  for (const e of events) {
    if (!byWedding[e.wedding_id]) byWedding[e.wedding_id] = {}
    if (!byWedding[e.wedding_id][e.event_type]) byWedding[e.wedding_id][e.event_type] = []
    byWedding[e.wedding_id][e.event_type].push(e)
  }

  const toDelete: string[] = []
  const weddingsTouched = new Set<string>()

  for (const [wid, byType] of Object.entries(byWedding)) {
    for (const [eventType, list] of Object.entries(byType)) {
      if (list.length <= 1) continue

      if (ONE_PER_WEDDING_EVENTS.has(eventType)) {
        // Keep the EARLIEST occurred_at. That's the truest "first" signal —
        // an Apr 19 inquiry trumps a backfill-stamped Apr 23 one.
        const sorted = [...list].sort((a, b) => {
          const aTime = a.occurred_at ?? a.created_at
          const bTime = b.occurred_at ?? b.created_at
          return aTime.localeCompare(bTime)
        })
        for (const dup of sorted.slice(1)) {
          toDelete.push(dup.id)
          weddingsTouched.add(wid)
        }
      } else {
        // Per-interaction dedup: bucket by occurred_at (or created_at if
        // null) to the second precision. Keep oldest created_at per bucket.
        const buckets: Record<string, Event[]> = {}
        for (const e of list) {
          const key = (e.occurred_at ?? e.created_at).slice(0, 19) // YYYY-MM-DDTHH:MM:SS
          if (!buckets[key]) buckets[key] = []
          buckets[key].push(e)
        }
        for (const bucket of Object.values(buckets)) {
          if (bucket.length <= 1) continue
          const sorted = [...bucket].sort((a, b) => a.created_at.localeCompare(b.created_at))
          for (const dup of sorted.slice(1)) {
            toDelete.push(dup.id)
            weddingsTouched.add(wid)
          }
        }
      }
    }
  }

  console.log(`  duplicate events to delete: ${toDelete.length}`)
  console.log(`  weddings affected:          ${weddingsTouched.size}`)
  if (toDelete.length === 0) return

  if (!APPLY) {
    // Show first 10 examples
    const sample = events.filter((e) => toDelete.includes(e.id)).slice(0, 10)
    for (const s of sample) {
      console.log(`    DEL ${s.id.slice(0, 8)}  ${s.event_type.padEnd(22)} occurred=${s.occurred_at ?? '(null)'}  src=${(s.metadata as any)?.source ?? '-'}`)
    }
    return
  }

  // Delete in chunks
  for (let i = 0; i < toDelete.length; i += 200) {
    const chunk = toDelete.slice(i, i + 200)
    const { error } = await sb.from('engagement_events').delete().in('id', chunk)
    if (error) {
      console.error(`  delete failed: ${error.message}`)
      return
    }
  }
  console.log(`  deleted ${toDelete.length} duplicates`)

  // Recalc heat for affected weddings
  let recalcd = 0
  for (const wid of weddingsTouched) {
    try { await recalculateHeatScore(venueId, wid); recalcd++ } catch (err) {
      console.error(`  recalc ${wid.slice(0, 8)}:`, (err as Error).message)
    }
  }
  console.log(`  recalculated ${recalcd} weddings`)
}

async function main() {
  let venueIds: string[] = [CLI_VENUE ?? RIXEY]
  if (ALL) {
    const { data: vs } = await sb.from('venues').select('id, is_demo').eq('is_demo', false)
    venueIds = (vs ?? []).map((v: any) => v.id)
  }
  for (const vid of venueIds) {
    await runVenue(vid)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
