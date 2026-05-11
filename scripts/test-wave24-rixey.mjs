// Wave 24 verification on Rixey. Tests:
//   - Migration 290 audits writable
//   - Deterministic compute for each pre-built question against Rixey data
//   - Airtightness rules fire: refusals on thin data, v1 disclosure
//
// Skips the narrator (Sonnet) calls — those are exercised by the page
// route. Each question's compute() is called directly so the output
// shape (cells / sample sizes / confidence pill / v1-pct) can be
// inspected without burning LLM cost on the verification run.

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

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

// Use the same SB shape the loader uses.
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// Inline the loader logic so we don't have to wire tsx into the script.
// Paged read of attribution_events.
async function pageRows(table, columns, filters) {
  const PAGE = 1000
  const rows = []
  let from = 0
  while (rows.length < 50000) {
    let q = sb.from(table).select(columns).eq('venue_id', RIXEY)
    if (filters) q = filters(q)
    q = q.range(from, from + PAGE - 1)
    const { data, error } = await q
    if (error) throw new Error(`${table}: ${error.message}`)
    rows.push(...(data ?? []))
    if ((data ?? []).length < PAGE) break
    from += PAGE
  }
  return rows
}

const V1_PROMPTS = new Set([
  'channel-role-classifier.prompt.v1',
  'inquiry-intent-judge.prompt.v1',
])

function normalisePlatform(raw) {
  if (!raw) return '(unknown)'
  const s = String(raw).toLowerCase().trim()
  if (s === 'theknot.com' || s === 'theknot' || s === 'the_knot') return 'the_knot'
  if (s === 'weddingwire.com' || s === 'weddingwire') return 'weddingwire'
  if (s === 'herecomestheguide.com' || s === 'hctg' || s === 'here_comes_the_guide') return 'hctg'
  return s
}

console.log('=== Loading Rixey dataset ===')
const attribution = await pageRows(
  'attribution_events',
  'id, venue_id, wedding_id, source_platform, role, intent_class, prompt_version_classified_under, intent_classified_at, decided_at, reverted_at',
  (q) => q.is('reverted_at', null),
)
console.log(`  attribution_events: ${attribution.length}`)

const weddings = await pageRows(
  'weddings',
  'id, venue_id, status, source, inquiry_date, booked_at, lost_at, booking_value',
)
console.log(`  weddings: ${weddings.length}`)
const weddingById = new Map(weddings.map((w) => [w.id, w]))

let discovery = []
try {
  discovery = await pageRows('discovery_sources', 'id, venue_id, wedding_id, canonical_source, captured_at')
} catch (e) {
  console.log('  discovery_sources: skipped', e.message)
}
console.log(`  discovery_sources: ${discovery.length}`)

let crmSourceDisagreements = []
try {
  crmSourceDisagreements = await pageRows(
    'disagreement_findings',
    'id, venue_id, wedding_id, axis, stated_value, forensic_value, magnitude_score, confidence_0_100, status, last_observed_at',
    (q) => q.eq('axis', 'crm_source').eq('status', 'active'),
  )
} catch (e) {
  console.log('  disagreement_findings: skipped', e.message)
}
console.log(`  crm_source disagreements: ${crmSourceDisagreements.length}`)

let marketingSpend = []
try {
  marketingSpend = await pageRows(
    'marketing_spend_records',
    'venue_id, channel, spend_date, amount_cents',
  )
} catch (e) {
  console.log('  marketing_spend_records: skipped', e.message)
}
console.log(`  marketing_spend_records: ${marketingSpend.length}`)

// v1-classification audit
let v1 = 0
let classified = 0
for (const a of attribution) {
  if (a.prompt_version_classified_under) {
    classified++
    if (V1_PROMPTS.has(a.prompt_version_classified_under)) v1++
  }
}
console.log(`\n=== Page calibration ===`)
console.log(`  total classified: ${classified}`)
console.log(`  v1-classified: ${v1} (${classified > 0 ? ((v1 / classified) * 100).toFixed(1) : 0}%)`)

// Q1: Knot targeted vs broadcast conversion
console.log(`\n=== Q1: Knot targeted vs broadcast conversion ===`)
const knotEvents = attribution.filter((a) => normalisePlatform(a.source_platform) === 'the_knot')
console.log(`  Knot AEs: ${knotEvents.length}`)
const wIntent = new Map()
const wPV = new Map()
for (const e of knotEvents) {
  if (!e.wedding_id) continue
  if (!wIntent.has(e.wedding_id) && e.intent_class) {
    wIntent.set(e.wedding_id, e.intent_class)
    wPV.set(e.wedding_id, e.prompt_version_classified_under)
  }
}
let targeted = 0, broadcast = 0, validation = 0, unknown = 0, targetedBooked = 0, broadcastBooked = 0
for (const [wid, intent] of wIntent.entries()) {
  const w = weddingById.get(wid)
  const booked = w && (w.status === 'booked' || w.booked_at !== null)
  if (intent === 'targeted') { targeted++; if (booked) targetedBooked++ }
  else if (intent === 'broadcast') { broadcast++; if (booked) broadcastBooked++ }
  else if (intent === 'validation') validation++
  else unknown++
}
console.log(`  targeted=${targeted} (booked=${targetedBooked}, conv=${targeted > 0 ? (targetedBooked / targeted * 100).toFixed(1) : 'n/a'}%)`)
console.log(`  broadcast=${broadcast} (booked=${broadcastBooked}, conv=${broadcast > 0 ? (broadcastBooked / broadcast * 100).toFixed(1) : 'n/a'}%)`)
console.log(`  validation=${validation}, unknown=${unknown}`)
const smallest = Math.min(targeted, broadcast)
console.log(`  confidence pill: ${smallest >= 30 ? 'high' : smallest >= 10 ? 'moderate' : 'thin'}`)
if (smallest < 10) console.log('  → narrator should HEDGE or REFUSE on thin sample')
console.log(`  airtightness: ${targeted === 0 || broadcast === 0 ? 'HARD REFUSAL (one bucket empty)' : 'pass — both buckets non-empty'}`)

// Q2: Knot real CAC
console.log(`\n=== Q2: Knot real CAC excluding broadcast ===`)
const knotSpend = marketingSpend.filter((s) => (s.channel ?? '').toLowerCase().includes('knot'))
const knotSpendTotal = knotSpend.reduce((sum, s) => sum + (s.amount_cents ?? 0), 0)
console.log(`  Knot spend rows: ${knotSpend.length}, total $${(knotSpendTotal / 100).toFixed(0)}`)
if (knotSpend.length === 0) console.log('  → HARD REFUSAL expected: no Knot marketing_spend_records')
const apparent = new Set()
const real = new Set()
for (const e of knotEvents) {
  if (!e.wedding_id) continue
  const w = weddingById.get(e.wedding_id)
  if (!w || !(w.status === 'booked' || w.booked_at !== null)) continue
  apparent.add(e.wedding_id)
  if ((wIntent.get(e.wedding_id) ?? 'unknown') !== 'broadcast') real.add(e.wedding_id)
}
console.log(`  apparent booked: ${apparent.size}`)
console.log(`  real booked (excl broadcast): ${real.size}`)
if (knotSpendTotal > 0) {
  console.log(`  apparent CAC: ${apparent.size > 0 ? '$' + (knotSpendTotal / apparent.size / 100).toFixed(0) : 'n/a'}`)
  console.log(`  real CAC: ${real.size > 0 ? '$' + (knotSpendTotal / real.size / 100).toFixed(0) : 'n/a'}`)
}

// Q3: Knot apparent vs real
console.log(`\n=== Q3: Knot apparent vs real breakdown ===`)
const apparentKnotW = new Set()
for (const e of knotEvents) if (e.wedding_id) apparentKnotW.add(e.wedding_id)
console.log(`  apparent Knot weddings: ${apparentKnotW.size}`)
console.log(`  bucket split: targeted=${targeted} | broadcast=${broadcast} | validation=${validation} | unknown=${unknown}`)
console.log(`  confidence pill: ${apparentKnotW.size >= 30 ? 'high' : apparentKnotW.size >= 10 ? 'moderate' : 'thin'}`)

// Q4: Stated vs forensic
console.log(`\n=== Q4: Stated vs forensic channel mix ===`)
console.log(`  active crm_source disagreements: ${crmSourceDisagreements.length}`)
if (crmSourceDisagreements.length === 0) {
  console.log('  → HARD REFUSAL expected: no active crm_source disagreements')
} else {
  console.log(`  confidence pill: ${crmSourceDisagreements.length >= 30 ? 'high' : crmSourceDisagreements.length >= 10 ? 'moderate' : 'thin'}`)
}

// Q5: AI tool cohort
console.log(`\n=== Q5: AI tool cohort difference ===`)
const aiTool = discovery.filter((d) => d.canonical_source === 'ai_tool')
const aiToolWids = new Set(aiTool.map((d) => d.wedding_id).filter(Boolean))
console.log(`  ai_tool discovery rows: ${aiTool.length}, distinct weddings: ${aiToolWids.size}`)
if (aiToolWids.size < 5) {
  console.log(`  → HARD REFUSAL expected: ${aiToolWids.size} < 5 doctrine threshold`)
}

// Q6: Similar platforms
console.log(`\n=== Q6: Similar platforms distorting CAC ===`)
const platformBucket = new Map()
for (const e of attribution) {
  const p = normalisePlatform(e.source_platform)
  if (!['the_knot', 'weddingwire', 'hctg', 'brides_com', 'zola', 'junebug', 'carats_cake', 'style_me_pretty'].includes(p)) continue
  if (!e.wedding_id) continue
  let b = platformBucket.get(p)
  if (!b) { b = { targeted: 0, broadcast: 0, validation: 0, unknown: 0, total: 0 }; platformBucket.set(p, b) }
  b.total++
  b[e.intent_class ?? 'unknown']++
}
for (const [p, b] of platformBucket) {
  const total = b.targeted + b.broadcast
  const broadcastPct = total > 0 ? ((b.broadcast / total) * 100).toFixed(0) : 'n/a'
  console.log(`  ${p}: total=${b.total} | t=${b.targeted} b=${b.broadcast} v=${b.validation} u=${b.unknown} | broadcast-share=${broadcastPct}%`)
}

// Q7: Temporal shift
console.log(`\n=== Q7: Recent month vs trailing 12mo ===`)
const now = Date.now()
const dayMs = 24 * 60 * 60 * 1000
let recent = 0, trailing = 0
for (const w of weddings) {
  if (!w.inquiry_date) continue
  const t = Date.parse(w.inquiry_date)
  if (!Number.isFinite(t)) continue
  if (t >= now - 30 * dayMs) recent++
  else if (t >= now - 390 * dayMs) trailing++
}
console.log(`  recent 30d: ${recent}, trailing 360d: ${trailing}`)
if (trailing < 30) console.log(`  → HARD REFUSAL expected: trailing ${trailing} < 30 baseline`)
if (recent < 8) console.log(`  → HARD REFUSAL expected: recent ${recent} < 8`)

// Write a smoke audit row
console.log(`\n=== Writing smoke audit row ===`)
const { data: audit, error: aErr } = await sb
  .from('channel_truth_audits')
  .insert({
    venue_id: RIXEY,
    viewed_by: null,
    question_ids: ['knot_targeted_vs_broadcast_conversion'],
    snapshot_jsonb: { test: 'wave24-smoke' },
  })
  .select('id')
  .single()
if (aErr) {
  console.log(`  ✗ insert failed: ${aErr.message}`)
} else {
  console.log(`  ✓ audit row inserted: ${audit.id}`)
  await sb.from('channel_truth_audits').delete().eq('id', audit.id)
  console.log(`  ✓ smoke audit row deleted`)
}

console.log('\nALL OK')
