// Recompute attribution_events.bucket and is_first_touch for every
// venue. Necessary after the inquiry-date corrections in
// scripts/backfill-booking-vs-tour-timestamps.ts — the bucket on
// existing attribution rows was decided when inquiry_date was
// (often) wrong, so signals that we now know are post-inquiry are
// still labeled bucket='attribution' and may carry is_first_touch=true.
//
// Bucket rule (matches src/lib/services/candidate-resolver.ts:520):
//   bucket = signal_date >= inquiry_date  ? 'nurture' : 'attribution'
//
// First-touch rule (matches recomputeFirstTouch):
//   exactly ONE event per wedding has is_first_touch=true: the row
//   among bucket='attribution' rows with the EARLIEST signal_date.
//   All other rows get is_first_touch=false.
//
// Idempotent. Already-correct rows skip.
//
// Usage:
//   npx tsx scripts/recompute-attribution-buckets.ts --venue <uuid>
//   npx tsx scripts/recompute-attribution-buckets.ts --venue <uuid> --apply
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    }),
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const venueIdx = args.indexOf('--venue')
const venueId = venueIdx >= 0 ? args[venueIdx + 1] : 'f3d10226-4c5c-47ad-b89b-98ad63842492'

interface Event {
  id: string
  wedding_id: string
  signal_id: string | null
  bucket: string
  is_first_touch: boolean
}

interface Signal {
  id: string
  signal_date: string | null
}

async function main() {
  console.log(`\n=== Recompute attribution buckets — venue ${venueId} ${apply ? '(apply)' : '(dry-run)'} ===\n`)

  // 1. Pull every active attribution event for this venue.
  const { data: eventsRaw } = await sb
    .from('attribution_events')
    .select('id, wedding_id, signal_id, bucket, is_first_touch')
    .eq('venue_id', venueId)
    .is('reverted_at', null)
  const events = (eventsRaw ?? []) as Event[]
  if (events.length === 0) {
    console.log('No attribution events. Nothing to do.')
    return
  }

  // 2. Pull each event's signal_date in one batch query.
  const sigIds = events.map((e) => e.signal_id).filter((v): v is string => Boolean(v))
  const sigDateById = new Map<string, string>()
  if (sigIds.length > 0) {
    const CHUNK = 100
    for (let i = 0; i < sigIds.length; i += CHUNK) {
      const chunk = sigIds.slice(i, i + CHUNK)
      const { data: sigs } = await sb
        .from('tangential_signals')
        .select('id, signal_date')
        .in('id', chunk)
      for (const s of (sigs ?? []) as Signal[]) {
        if (s.signal_date) sigDateById.set(s.id, s.signal_date)
      }
    }
  }

  // 3. Pull each touched wedding's current inquiry_date.
  const weddingIds = Array.from(new Set(events.map((e) => e.wedding_id)))
  const inquiryDateById = new Map<string, string | null>()
  const CHUNK = 100
  for (let i = 0; i < weddingIds.length; i += CHUNK) {
    const chunk = weddingIds.slice(i, i + CHUNK)
    const { data: weds } = await sb
      .from('weddings')
      .select('id, inquiry_date')
      .in('id', chunk)
    for (const w of (weds ?? []) as Array<{ id: string; inquiry_date: string | null }>) {
      inquiryDateById.set(w.id, w.inquiry_date)
    }
  }

  // 4. For each wedding, compute the desired bucket + first-touch.
  let bucketsFlipped = 0
  let firstTouchesChanged = 0
  const updates: Array<{ id: string; patch: Partial<Event> }> = []

  // Group events by wedding so we can pick the earliest 'attribution'
  // row per wedding for is_first_touch.
  const eventsByWedding = new Map<string, Event[]>()
  for (const e of events) {
    const arr = eventsByWedding.get(e.wedding_id) ?? []
    arr.push(e)
    eventsByWedding.set(e.wedding_id, arr)
  }

  for (const [wid, evs] of eventsByWedding.entries()) {
    const inquiryDate = inquiryDateById.get(wid) ?? null
    const inquiryTs = inquiryDate ? new Date(inquiryDate).getTime() : null

    // Pass 1: compute desired bucket per event.
    type Decided = { event: Event; desiredBucket: string; signalTs: number | null }
    const decided: Decided[] = evs.map((e) => {
      const sigDate = e.signal_id ? sigDateById.get(e.signal_id) : undefined
      const signalTs = sigDate ? new Date(sigDate).getTime() : null
      let desiredBucket = e.bucket
      if (signalTs !== null && inquiryTs !== null) {
        desiredBucket = signalTs >= inquiryTs ? 'nurture' : 'attribution'
      }
      return { event: e, desiredBucket, signalTs }
    })

    // Pass 2: pick the earliest 'attribution' signal as first-touch.
    let earliest: { id: string; ts: number } | null = null
    for (const d of decided) {
      if (d.desiredBucket !== 'attribution' || d.signalTs === null) continue
      if (!earliest || d.signalTs < earliest.ts) earliest = { id: d.event.id, ts: d.signalTs }
    }

    // Pass 3: queue updates for any rows whose bucket or is_first_touch
    // would change.
    for (const d of decided) {
      const desiredFirstTouch = earliest?.id === d.event.id
      const patch: Partial<Event> = {}
      if (d.desiredBucket !== d.event.bucket) {
        patch.bucket = d.desiredBucket
        bucketsFlipped++
      }
      if (desiredFirstTouch !== d.event.is_first_touch) {
        patch.is_first_touch = desiredFirstTouch
        firstTouchesChanged++
      }
      if (Object.keys(patch).length > 0) {
        updates.push({ id: d.event.id, patch })
      }
    }
  }

  console.log(`weddings scanned:       ${weddingIds.length}`)
  console.log(`attribution events:     ${events.length}`)
  console.log(`bucket flips queued:    ${bucketsFlipped}`)
  console.log(`first-touch changes:    ${firstTouchesChanged}`)

  if (apply && updates.length > 0) {
    let written = 0
    for (const u of updates) {
      const { error } = await sb.from('attribution_events').update(u.patch).eq('id', u.id)
      if (error) console.error(`  ${u.id}: ${error.message}`)
      else written++
    }
    console.log(`rows written:           ${written}`)
  }

  if (!apply && updates.length > 0) {
    console.log('\nDry-run complete. Re-run with --apply to write.')
    console.log('After --apply, the AI journey narratives should be force-regenerated.')
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
