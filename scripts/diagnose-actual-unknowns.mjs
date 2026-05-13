#!/usr/bin/env node
/**
 * Audit Rixey "Unknown" leads: count weddings whose leads-list display
 * resolves to '(Unknown)' / null / empty, split by:
 *   - Has couple_identity_profile? Y/N
 *   - Has partner1 people row? Y/N
 *   - Sourced from what?
 *   - Has any inbound interactions?
 *
 * Goal: distinguish Pattern A (SMS-only / no profile) from Pattern B
 * (profile populated but cache stale) from a third Pattern C (no
 * people row at all / partner1 missing) we may have missed.
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

// Pull all Rixey weddings (the only live venue right now). Group by
// "Unknown" status of the partner1 people row.
// Find rixey venue id by looking up gmail_connections / venues.
const { data: rixVenue } = await sb
  .from('venues')
  .select('id, name')
  .ilike('name', '%rixey%')
  .limit(1)
  .maybeSingle()
const venueId = rixVenue?.id
console.log(`Venue: ${rixVenue?.name} (${venueId})`)

const { data: weddings } = await sb
  .from('weddings')
  .select('id, status, source, merged_into_id, created_at')
  .eq('venue_id', venueId)
  .is('merged_into_id', null)
  .limit(2000)

const total = weddings?.length ?? 0
console.log(`Total active weddings at Rixey: ${total}`)

const buckets = {
  named: 0,
  unknownMarker: 0,            // first_name = '(Unknown)'
  emptyOrNull: 0,              // first_name null or ''
  noPartner1Row: 0,            // wedding has no partner1 people row at all
}
const samplePerBucket = { unknownMarker: [], emptyOrNull: [], noPartner1Row: [] }

for (const w of weddings ?? []) {
  const { data: rows } = await sb
    .from('people')
    .select('id, first_name, last_name')
    .eq('wedding_id', w.id)
    .eq('role', 'partner1')
    .is('merged_into_id', null)
    .limit(1)
  const p1 = rows?.[0]
  if (!p1) {
    buckets.noPartner1Row++
    if (samplePerBucket.noPartner1Row.length < 5) samplePerBucket.noPartner1Row.push(w)
    continue
  }
  if (p1.first_name === '(Unknown)') {
    buckets.unknownMarker++
    if (samplePerBucket.unknownMarker.length < 5) samplePerBucket.unknownMarker.push({ w, p1 })
    continue
  }
  if (!p1.first_name || p1.first_name === '') {
    buckets.emptyOrNull++
    if (samplePerBucket.emptyOrNull.length < 5) samplePerBucket.emptyOrNull.push({ w, p1 })
    continue
  }
  buckets.named++
}

console.log(`\n=== Buckets ===`)
console.log(`  named (first_name present, not '(Unknown)'): ${buckets.named}`)
console.log(`  unknownMarker (first_name = '(Unknown)'): ${buckets.unknownMarker}`)
console.log(`  emptyOrNull (first_name null/empty): ${buckets.emptyOrNull}`)
console.log(`  noPartner1Row (no partner1 people row): ${buckets.noPartner1Row}`)

const totalUnknown = buckets.unknownMarker + buckets.emptyOrNull + buckets.noPartner1Row
console.log(`\nTotal that would render as "Unknown" in UI: ${totalUnknown}`)

console.log(`\n=== Samples ===`)
for (const k of ['unknownMarker', 'emptyOrNull', 'noPartner1Row']) {
  if (samplePerBucket[k].length === 0) continue
  console.log(`\n${k}:`)
  for (const s of samplePerBucket[k]) {
    const w = s.w ?? s
    const p1 = s.p1
    console.log(`  W=${w.id} src=${w.source} status=${w.status} created=${w.created_at?.slice(0, 10)}`)
    if (p1) console.log(`    p1: first="${p1.first_name}" last="${p1.last_name}"`)
  }
}

// Now check: of the 'Unknown' weddings, how many have a profile and would benefit from sync?
console.log(`\n=== Cross-reference with couple_identity_profile ===`)
const unknownWeddingIds = []
for (const w of weddings ?? []) {
  const { data: rows } = await sb
    .from('people')
    .select('first_name')
    .eq('wedding_id', w.id)
    .eq('role', 'partner1')
    .is('merged_into_id', null)
    .limit(1)
  const p1 = rows?.[0]
  if (!p1 || !p1.first_name || p1.first_name === '(Unknown)' || p1.first_name === '') {
    unknownWeddingIds.push(w.id)
  }
}
const { data: profsForUnknowns } = await sb
  .from('couple_identity_profile')
  .select('wedding_id, profile')
  .in('wedding_id', unknownWeddingIds)
const profileMap = new Map()
for (const p of profsForUnknowns ?? []) profileMap.set(p.wedding_id, p.profile)

let unknownsWithUsefulProfile = 0
let unknownsWithProfileButEmpty = 0
let unknownsWithoutProfile = 0
for (const wid of unknownWeddingIds) {
  const prof = profileMap.get(wid)
  if (!prof) {
    unknownsWithoutProfile++
    continue
  }
  const p1First = prof.names?.partner1?.first
  const quality = prof.names?.name_quality
  if (p1First && (quality === 'high' || quality === 'medium')) {
    unknownsWithUsefulProfile++
  } else {
    unknownsWithProfileButEmpty++
  }
}
console.log(`Total Unknown leads: ${unknownWeddingIds.length}`)
console.log(`  with NO profile (Pattern A — needs C2):                ${unknownsWithoutProfile}`)
console.log(`  with profile but empty names / low quality:            ${unknownsWithProfileButEmpty}`)
console.log(`  with profile + high/medium names (Pattern B — STALE):  ${unknownsWithUsefulProfile}`)
