#!/usr/bin/env node
/**
 * One-shot tombstone sweep for Step 5d — Rixey Unknown cleanup.
 *
 * Pre-requisites:
 *   1. Migration 332 (weddings.non_couple_at + non_couple_reason)
 *      applied via Supabase Studio.
 *   2. Step 5b/c committed and deployed so interactions.intent_class
 *      is fresh on every inbound row.
 *
 * What it does:
 *   - Walks Unknown weddings (no partner1 first_name or '(Unknown)')
 *     at Rixey.
 *   - Rolls up interactions.intent_class for each.
 *   - Soft-tombstones via UPDATE non_couple_at=NOW() +
 *     non_couple_reason='intent:<dominant>' when the thread is
 *     unambiguously non-couple per the rules in
 *     src/lib/services/identity/non-couple-tombstone.ts.
 *
 * Idempotent: rows with non_couple_at already set are skipped.
 *
 * Run with the same .env.local that the diagnostic scripts use:
 *   node scripts/run-non-couple-tombstone.mjs
 */

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = {}
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (!m) continue
  let v = m[2]
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
  env[m[1]] = v
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

// Same constants as src/lib/services/identity/non-couple-tombstone.ts
// — duplicated here so this script runs without compiling the TS
// project. Keep the two in sync.
const HIGH_CONFIDENCE_NON_COUPLE = new Set([
  'vendor_communication',
  'vendor_outreach',
  'spam_outreach',
  'auto_reply',
  'coordinator_internal',
])
const COUPLE_INTENTS = new Set([
  'new_inquiry',
  'inquiry_followup',
  'client_emotional',
  'family_member_proxy',
])
const PROTECTED_STATUSES = new Set(['booked', 'completed'])

// 1. Find Rixey.
const { data: rixVenue } = await sb
  .from('venues')
  .select('id, name')
  .ilike('name', '%rixey%')
  .limit(1)
  .maybeSingle()
if (!rixVenue) {
  console.error('Rixey venue not found')
  process.exit(1)
}
console.log(`Venue: ${rixVenue.name} (${rixVenue.id})`)

// 2. Pull all eligible weddings (not tombstoned, not protected status).
const { data: weddingsRaw } = await sb
  .from('weddings')
  .select('id, status')
  .eq('venue_id', rixVenue.id)
  .is('non_couple_at', null)
  .is('merged_into_id', null)
  .limit(2000)
const weddings = (weddingsRaw ?? []).filter((w) => !PROTECTED_STATUSES.has(w.status))
console.log(`Eligible (not tombstoned, not booked/completed): ${weddings.length}`)

// 3. Filter to Unknown partner1.
const unknownIds = []
for (const w of weddings) {
  const { data: p1Rows } = await sb
    .from('people')
    .select('first_name')
    .eq('wedding_id', w.id)
    .eq('role', 'partner1')
    .is('merged_into_id', null)
    .limit(1)
  const first = p1Rows?.[0]?.first_name
  const isUnknown = !first || first === '(Unknown)' || first === ''
  if (isUnknown) unknownIds.push(w.id)
}
console.log(`Unknown weddings: ${unknownIds.length}`)

if (unknownIds.length === 0) {
  console.log('Nothing to do.')
  process.exit(0)
}

// 4. Pull all inbound intent_class rows in batches.
const intentsByWedding = new Map()
const BATCH = 200
for (let i = 0; i < unknownIds.length; i += BATCH) {
  const batch = unknownIds.slice(i, i + BATCH)
  const { data: rows } = await sb
    .from('interactions')
    .select('wedding_id, intent_class, direction')
    .in('wedding_id', batch)
    .eq('direction', 'inbound')
    .limit(10000)
  for (const r of rows ?? []) {
    if (!r.wedding_id) continue
    const list = intentsByWedding.get(r.wedding_id) ?? []
    if (r.intent_class) list.push(r.intent_class)
    intentsByWedding.set(r.wedding_id, list)
  }
}

// 5. Decide + tombstone.
let tombstoned = 0
let skipCouple = 0
let skipUncertain = 0
let skipNoIntent = 0
const tombstones = []

for (const wid of unknownIds) {
  const intents = intentsByWedding.get(wid) ?? []
  const classified = intents.filter((i) => i && i !== 'unknown')
  if (classified.length === 0) {
    skipNoIntent++
    continue
  }
  if (classified.some((i) => COUPLE_INTENTS.has(i))) {
    skipCouple++
    continue
  }
  const strong = classified.find((i) => HIGH_CONFIDENCE_NON_COUPLE.has(i))
  if (!strong) {
    skipUncertain++
    continue
  }
  const { error } = await sb
    .from('weddings')
    .update({
      non_couple_at: new Date().toISOString(),
      non_couple_reason: `intent:${strong}`,
    })
    .eq('id', wid)
    .is('non_couple_at', null)
  if (error) {
    console.warn(`  ${wid}: tombstone failed: ${error.message}`)
    continue
  }
  tombstoned++
  if (tombstones.length < 20) tombstones.push({ wid, reason: strong })
}

console.log(`\n=== Tombstone sweep results ===`)
console.log(`  tombstoned:                          ${tombstoned}`)
console.log(`  skipped (couple-intent in thread):   ${skipCouple}`)
console.log(`  skipped (no classified intent):      ${skipNoIntent}`)
console.log(`  skipped (uncertain - all logistics): ${skipUncertain}`)

if (tombstones.length > 0) {
  console.log(`\nSample tombstones (first ${tombstones.length}):`)
  for (const t of tombstones) console.log(`  ${t.wid} reason=${t.reason}`)
}
