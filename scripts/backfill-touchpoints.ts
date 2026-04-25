// Backfill wedding_touchpoints from existing engagement_events.
//
// The live pipeline now writes touchpoints for every attribution-relevant
// engagement event, but the historical pile-up of events from before
// the touchpoint mirror landed is missing from wedding_touchpoints.
// /intel/sources can't compute multi-touch attribution without the
// historical data, so this script walks every engagement_event,
// translates it to a touch_type via engagementToTouchType, and writes
// the corresponding row.
//
// Source assignment for historical rows:
//   - For events with metadata.source set to a canonical value
//     (calendly / acuity / honeybook / dubsado), use that.
//   - Otherwise use the wedding's source field (first-touch).
//   - Never invent a source — if neither is set, leave null.
//
// Idempotent: dedup is the same (wedding_id, touch_type, occurred_at)
// match as the live writer. Safe to re-run.
//
// Usage:
//   npx tsx scripts/backfill-touchpoints.ts                # dry-run Rixey
//   npx tsx scripts/backfill-touchpoints.ts --apply
//   npx tsx scripts/backfill-touchpoints.ts --apply --all  # every real venue
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { engagementToTouchType, type TouchType } from '../src/lib/services/touchpoints'

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

interface EngagementEvent {
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
    .order('occurred_at', { ascending: true })
  const events = (rawEvents ?? []) as EngagementEvent[]
  console.log(`  engagement_events: ${events.length}`)

  // Wedding source lookup — used as fallback when the engagement event
  // doesn't carry a source itself.
  const { data: weddings } = await sb.from('weddings').select('id, source').eq('venue_id', venueId)
  const weddingSource = new Map<string, string | null>()
  for (const w of (weddings ?? []) as Array<{ id: string; source: string | null }>) {
    weddingSource.set(w.id, w.source)
  }

  // Existing touchpoints (for dedup before insert).
  const { data: existingTp } = await sb
    .from('wedding_touchpoints')
    .select('wedding_id, touch_type, occurred_at')
    .eq('venue_id', venueId)
  const existingKeys = new Set<string>()
  for (const t of (existingTp ?? []) as Array<{ wedding_id: string; touch_type: string; occurred_at: string }>) {
    existingKeys.add(`${t.wedding_id}|${t.touch_type}|${t.occurred_at}`)
  }

  type Plan = {
    venue_id: string
    wedding_id: string
    touch_type: TouchType
    source: string | null
    medium: string
    occurred_at: string
    metadata: Record<string, unknown>
  }
  const toInsert: Plan[] = []
  const skipReasons = { no_touch_mapping: 0, dedup: 0, no_occurred_at: 0 }

  for (const e of events) {
    const occurredAt = e.occurred_at ?? e.created_at
    if (!occurredAt) {
      skipReasons.no_occurred_at++
      continue
    }
    const meta = e.metadata ?? {}
    const eventSource = (meta.source as string | undefined) ?? null
    // engagement metadata source might be a tool-internal marker like
    // 'signal_inference_reply'; only treat tool source if it looks like
    // a real channel name.
    const isToolSource = ['calendly', 'acuity', 'honeybook', 'dubsado'].includes(eventSource ?? '')
    const source = isToolSource ? eventSource : (weddingSource.get(e.wedding_id) ?? null)
    const tt = engagementToTouchType(e.event_type, source ?? null)
    if (!tt) {
      skipReasons.no_touch_mapping++
      continue
    }
    const dedupKey = `${e.wedding_id}|${tt}|${occurredAt}`
    if (existingKeys.has(dedupKey)) {
      skipReasons.dedup++
      continue
    }
    existingKeys.add(dedupKey)
    toInsert.push({
      venue_id: venueId,
      wedding_id: e.wedding_id,
      touch_type: tt,
      source,
      medium: 'email',
      occurred_at: occurredAt,
      metadata: { engagement_event_id: e.id, engagement_event_type: e.event_type, ...(meta as Record<string, unknown>) },
    })
  }

  console.log(`  touchpoints to insert:    ${toInsert.length}`)
  console.log(`  skipped — non-funnel:     ${skipReasons.no_touch_mapping}`)
  console.log(`  skipped — already exists: ${skipReasons.dedup}`)
  if (skipReasons.no_occurred_at > 0) console.log(`  skipped — no occurred_at: ${skipReasons.no_occurred_at}`)

  // Distribution
  const byType: Record<string, number> = {}
  const bySource: Record<string, number> = {}
  for (const p of toInsert) {
    byType[p.touch_type] = (byType[p.touch_type] ?? 0) + 1
    bySource[p.source ?? '(null)'] = (bySource[p.source ?? '(null)'] ?? 0) + 1
  }
  console.log(`  by touch_type: ${JSON.stringify(byType)}`)
  console.log(`  by source:     ${JSON.stringify(bySource)}`)

  if (!APPLY || toInsert.length === 0) return

  for (let i = 0; i < toInsert.length; i += 200) {
    const chunk = toInsert.slice(i, i + 200)
    const { error } = await sb.from('wedding_touchpoints').insert(chunk)
    if (error) {
      console.error(`  insert failed at chunk ${i}: ${error.message}`)
      return
    }
  }
  console.log(`  inserted ${toInsert.length} touchpoints.`)
}

async function main() {
  let venueIds: string[] = [CLI_VENUE ?? RIXEY]
  if (ALL) {
    const { data: vs } = await sb.from('venues').select('id, is_demo').eq('is_demo', false)
    venueIds = (vs ?? []).map((v: any) => v.id)
  }
  for (const vid of venueIds) await runVenue(vid)
}

main().catch((err) => { console.error(err); process.exit(1) })
