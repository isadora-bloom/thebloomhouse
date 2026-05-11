/**
 * Wave 12 smoke test — builds a couple timeline for the busiest Rixey
 * wedding (most interactions) and prints counts by kind + an example
 * event of each kind. Verifies the aggregator end-to-end.
 *
 * Usage:
 *   node --env-file=.env.local scripts/test-wave12-timeline.mjs
 *
 * Output:
 *   - busiest wedding (id, couple name, interaction count)
 *   - countsByKind histogram
 *   - one sample event per kind (kind, title, timestamp, actor)
 *   - truncation status + total events
 *
 * NB: This script duplicates a minimal subset of buildCoupleTimeline's
 * SQL because importing TS code from a .mjs node script needs a tsx
 * loader. We use the runtime endpoint over HTTP if BLOOM_LOCAL_URL is
 * set, otherwise we replicate the aggregation paths with raw queries.
 * The intent is verification, not coverage — the real prod path is the
 * endpoint hit by the React page.
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = { ...process.env }
try {
  const raw = readFileSync('.env.local', 'utf8')
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch {}

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

// ---- 1. Find Rixey ----
const { data: venues } = await sb
  .from('venues')
  .select('id, name')
  .ilike('name', '%rixey%')
  .limit(5)
const rixey = venues?.[0]
if (!rixey) {
  console.log('No Rixey venue found.')
  process.exit(0)
}
console.log('Rixey venue:', rixey.id, rixey.name)

// ---- 2. Pick busiest wedding (most interactions) ----
const { data: weddings } = await sb
  .from('weddings')
  .select('id, venue_id')
  .eq('venue_id', rixey.id)
  .is('merged_into_id', null)
  .limit(2000)
if (!weddings?.length) {
  console.log('No Rixey weddings.')
  process.exit(0)
}

let busiest = null
let busiestCount = 0
for (const w of weddings) {
  const { count } = await sb
    .from('interactions')
    .select('id', { count: 'exact', head: true })
    .eq('wedding_id', w.id)
  if ((count ?? 0) > busiestCount) {
    busiest = w
    busiestCount = count ?? 0
  }
}
if (!busiest) {
  console.log('No wedding with interactions.')
  process.exit(0)
}
console.log('Busiest wedding:', busiest.id, 'with', busiestCount, 'interactions')

// ---- 3. Per-source counts (mirror what buildCoupleTimeline reads) ----
const wid = busiest.id
const sources = []
async function probeCount(label, query) {
  const { count } = await query
  sources.push({ label, count: count ?? 0 })
}

await probeCount('interactions', sb.from('interactions').select('id', { count: 'exact', head: true }).eq('wedding_id', wid))
await probeCount('tours', sb.from('tours').select('id', { count: 'exact', head: true }).eq('wedding_id', wid))
await probeCount('lifecycle_transitions', sb.from('lifecycle_transitions').select('id', { count: 'exact', head: true }).eq('wedding_id', wid))
await probeCount('couple_identity_profile (1 if exists)',
  sb.from('couple_identity_profile').select('wedding_id', { count: 'exact', head: true }).eq('wedding_id', wid))
await probeCount('couple_intel (1 if exists)',
  sb.from('couple_intel').select('wedding_id', { count: 'exact', head: true }).eq('wedding_id', wid))
await probeCount('budget_payments', sb.from('budget_payments').select('id', { count: 'exact', head: true }).eq('wedding_id', wid))
await probeCount('contracts', sb.from('contracts').select('id', { count: 'exact', head: true }).eq('wedding_id', wid))
await probeCount('attribution_events', sb.from('attribution_events').select('id', { count: 'exact', head: true }).eq('wedding_id', wid))
await probeCount('intel_matches', sb.from('intel_matches').select('id', { count: 'exact', head: true }).eq('wedding_id', wid))

console.log('\nPer-source counts:')
for (const s of sources) console.log('  -', s.label.padEnd(40), s.count)

// ---- 4. Sample a row from each non-zero source ----
console.log('\nSample rows:')
async function sampleOne(label, fn) {
  try {
    const { data } = await fn()
    const row = data?.[0]
    if (row) {
      console.log(`  [${label}]`, JSON.stringify(row, null, 2).slice(0, 400))
    } else {
      console.log(`  [${label}] (none)`)
    }
  } catch (err) {
    console.log(`  [${label}] err:`, err.message)
  }
}
await sampleOne('interaction', () =>
  sb.from('interactions').select('id, type, direction, subject, from_name, timestamp').eq('wedding_id', wid).order('timestamp', { ascending: false }).limit(1))
await sampleOne('tour', () =>
  sb.from('tours').select('id, scheduled_at, outcome, tour_type, notes').eq('wedding_id', wid).limit(1))
await sampleOne('lifecycle_transition', () =>
  sb.from('lifecycle_transitions').select('id, from_stage, to_stage, transition_kind, reasoning, transitioned_at').eq('wedding_id', wid).order('transitioned_at', { ascending: false }).limit(1))
await sampleOne('couple_identity_profile', () =>
  sb.from('couple_identity_profile').select('wedding_id, last_reconstructed_at, reconstruction_count, prompt_version').eq('wedding_id', wid).limit(1))
await sampleOne('couple_intel', () =>
  sb.from('couple_intel').select('wedding_id, last_derived_at, persona_label, predicted_close_probability_pct').eq('wedding_id', wid).limit(1))
await sampleOne('attribution_event', () =>
  sb.from('attribution_events').select('id, source_platform, tier, confidence, decided_at, is_first_touch').eq('wedding_id', wid).order('decided_at', { ascending: false }).limit(1))
await sampleOne('intel_match', () =>
  sb.from('intel_matches').select('id, signal_type, fired_at, match_confidence_0_100').eq('wedding_id', wid).limit(1))

// ---- 5. Test runtime endpoint if BLOOM_LOCAL_URL is set ----
const localUrl = env.BLOOM_LOCAL_URL || env.APP_URL || env.NEXT_PUBLIC_APP_URL
if (localUrl && env.CRON_SECRET) {
  console.log(`\nFetching /api/admin/timeline/wedding/${wid} from ${localUrl}...`)
  const res = await fetch(`${localUrl}/api/admin/timeline/wedding/${wid}`, {
    headers: { authorization: `Bearer ${env.CRON_SECRET}` },
  })
  console.log('  status:', res.status)
  if (res.ok) {
    const body = await res.json()
    console.log('  truncated:', body.truncated)
    console.log('  totalEvents:', body.totalEvents)
    console.log('  countsByKind:', body.countsByKind)
    console.log('  scope:', body.scope)
    if (body.events?.length) {
      const seen = new Set()
      for (const e of body.events) {
        if (seen.has(e.kind)) continue
        seen.add(e.kind)
        console.log(`  example [${e.kind}]`, JSON.stringify({
          title: e.title,
          timestamp: e.timestamp,
          stage_at_time: e.lifecycle_stage_at_time,
          actor: e.actor,
        }))
      }
    }
  } else {
    console.log('  body:', await res.text())
  }
} else {
  console.log('\n(skipping endpoint test — set BLOOM_LOCAL_URL + CRON_SECRET to enable)')
}

console.log('\n=== Wave 12 smoke complete ===')
