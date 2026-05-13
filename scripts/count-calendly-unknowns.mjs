#!/usr/bin/env node
/**
 * Count the actual breakdown of Rixey "Unknown" weddings by signal source.
 * Before designing a retro patch, we need to know how many are:
 *   - SMS-only (genuinely no name) — can't fix
 *   - Calendly CSV pre-Pass-H (name was in CSV but lost) — fixable from people row
 *   - Profile-knew-but-people-missing (sync bug) — fixable via resync-people
 *   - Email-only with no name yet (judge still running) — no action
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
const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

async function main() {
  // Pull all non-tombstoned, non-merged weddings + their partner1 people row
  const { data: weddings, error } = await sb
    .from('weddings')
    .select('id, status, inquiry_date, wedding_date, crm_source, source_provenance')
    .eq('venue_id', RIXEY)
    .is('non_couple_at', null)
    .is('merged_into_id', null)
    .limit(2000)
  if (error) { console.error(error); process.exit(1) }

  const buckets = {
    has_partner1_name: 0,            // people.first_name populated and not '(Unknown)'
    unknown_marker: 0,                // people.first_name === '(Unknown)' — judge marked
    sms_only_no_name: 0,              // only sms interactions + no name
    calendly_csv_no_name: 0,          // has Calendly synth interaction + no name on people
    email_only_no_name: 0,            // has email interactions only + no name
    profile_knew_people_missing: 0,   // profile has confident partner1 + people row blank
    other: 0,
  }
  const calendlyFixCandidates = []
  const profileSyncCandidates = []

  for (const w of weddings ?? []) {
    // partner1 people row
    const { data: pps } = await sb
      .from('people')
      .select('first_name, last_name, email, phone')
      .eq('wedding_id', w.id)
      .eq('role', 'partner1')
      .is('merged_into_id', null)
      .limit(1)
    const p1 = pps?.[0]
    const hasName = p1 && p1.first_name && p1.first_name !== '(Unknown)' && p1.first_name !== 'Unknown'

    if (hasName) {
      buckets.has_partner1_name += 1
      continue
    }
    if (p1?.first_name === '(Unknown)') {
      buckets.unknown_marker += 1
      // not an action target
    }

    // What interaction types exist?
    const { data: inter } = await sb
      .from('interactions')
      .select('type, full_body')
      .eq('wedding_id', w.id)
      .limit(50)
    const types = new Set((inter ?? []).map((i) => i.type))
    const hasCalendlySynth = (inter ?? []).some((i) => (i.full_body ?? '').startsWith('provider:calendly'))
    const hasEmail = types.has('email')
    const onlySms = types.size > 0 && [...types].every((t) => t === 'sms')

    // Check profile for confident partner1 name (Pass G sync candidate)
    const { data: profile } = await sb
      .from('couple_identity_profile')
      .select('profile')
      .eq('wedding_id', w.id)
      .maybeSingle()
    const profileP1 = profile?.profile?.names?.partner1
    const profileHasName =
      profileP1 &&
      typeof profileP1 === 'object' &&
      profileP1.first &&
      (profileP1.confidence_0_100 ?? 0) >= 60

    if (profileHasName) {
      buckets.profile_knew_people_missing += 1
      profileSyncCandidates.push({
        id: w.id,
        profile_first: profileP1.first,
        profile_last: profileP1.last,
        confidence: profileP1.confidence_0_100,
        hasCalendly: hasCalendlySynth,
      })
    } else if (hasCalendlySynth) {
      buckets.calendly_csv_no_name += 1
      calendlyFixCandidates.push({ id: w.id, types: [...types] })
    } else if (onlySms) {
      buckets.sms_only_no_name += 1
    } else if (hasEmail) {
      buckets.email_only_no_name += 1
    } else {
      buckets.other += 1
    }
  }

  console.log(`Total scanned: ${weddings.length}`)
  console.log(JSON.stringify(buckets, null, 2))
  console.log(`\nCalendly retro-fix candidates: ${calendlyFixCandidates.length}`)
  console.log(`  sample 5:`, calendlyFixCandidates.slice(0, 5))
  console.log(`\nProfile→people sync candidates: ${profileSyncCandidates.length}`)
  console.log(`  sample 5:`, profileSyncCandidates.slice(0, 5))
}

main().catch((err) => { console.error(err); process.exit(1) })
