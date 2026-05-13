#!/usr/bin/env node
/**
 * Pattern B diagnosis: weddings where couple_identity_profile has
 * partner1 names at high/medium quality, but the legacy people row
 * still shows '(Unknown)' or empty / something that doesn't match the
 * profile. If profile-to-people-sync runs after every reconstruct,
 * this set should be empty — non-empty means the sync is skipping
 * or short-circuiting on some guard.
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

// 1. All weddings with a profile
const { data: profiles, error: pErr } = await sb
  .from('couple_identity_profile')
  .select('wedding_id, venue_id, profile, last_reconstructed_at')
  .limit(2000)
if (pErr) {
  console.error('profiles read err:', pErr.message)
  process.exit(1)
}
console.log(`Total couple_identity_profile rows: ${profiles?.length ?? 0}`)

const candidates = (profiles ?? []).filter((p) => {
  const q = p.profile?.names?.name_quality
  const p1First = p.profile?.names?.partner1?.first
  return (q === 'high' || q === 'medium') && p1First
})
console.log(`Profiles with partner1 first_name at high/medium quality: ${candidates.length}`)

// 2. For each candidate, look up partner1 in people
let matches = 0
let mismatches = 0
let noPartnerRow = 0
let isUnknownMarker = 0
const sampleMismatches = []

for (const c of candidates) {
  const { data: partner1Rows } = await sb
    .from('people')
    .select('id, first_name, last_name, name_confidence, name_evidence, merged_into_id')
    .eq('wedding_id', c.wedding_id)
    .eq('role', 'partner1')
    .is('merged_into_id', null)
    .limit(1)
  const partner1 = partner1Rows?.[0]
  if (!partner1) {
    noPartnerRow++
    continue
  }
  const profileFirst = c.profile.names.partner1.first
  const profileLast = c.profile.names.partner1.last
  const eq = (a, b) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase()
  if (partner1.first_name === '(Unknown)') {
    isUnknownMarker++
    if (sampleMismatches.length < 10) {
      sampleMismatches.push({
        wedding: c.wedding_id,
        people_first: partner1.first_name,
        people_last: partner1.last_name,
        profile_first: profileFirst,
        profile_last: profileLast,
        confidence: c.profile.names.partner1.confidence_0_100,
        last_reconstructed: c.last_reconstructed_at,
      })
    }
    continue
  }
  if (eq(partner1.first_name, profileFirst) && eq(partner1.last_name, profileLast)) {
    matches++
  } else {
    mismatches++
    if (sampleMismatches.length < 10) {
      sampleMismatches.push({
        wedding: c.wedding_id,
        people_first: partner1.first_name,
        people_last: partner1.last_name,
        profile_first: profileFirst,
        profile_last: profileLast,
        confidence: c.profile.names.partner1.confidence_0_100,
        last_reconstructed: c.last_reconstructed_at,
      })
    }
  }
}

console.log(`\n=== Pattern B diagnosis ===`)
console.log(`profiles checked: ${candidates.length}`)
console.log(`  partner1 row matches profile names: ${matches}`)
console.log(`  partner1 row says '(Unknown)' but profile has names: ${isUnknownMarker}`)
console.log(`  partner1 row is something else (mismatch): ${mismatches}`)
console.log(`  no partner1 row exists for the wedding: ${noPartnerRow}`)

if (sampleMismatches.length > 0) {
  console.log(`\nSample of leaks (first ${sampleMismatches.length}):`)
  for (const m of sampleMismatches) {
    console.log(`  W=${m.wedding}`)
    console.log(`    people  : "${m.people_first} ${m.people_last ?? ''}"`)
    console.log(`    profile : "${m.profile_first} ${m.profile_last ?? ''}" (conf=${m.confidence})`)
    console.log(`    last reconstructed: ${m.last_reconstructed}`)
  }
}
