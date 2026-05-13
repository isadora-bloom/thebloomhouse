#!/usr/bin/env node
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

// Find the wedding via the invitee email
const { data: people } = await sb
  .from('people')
  .select('id, wedding_id, first_name, last_name, email, phone, name_evidence')
  .eq('venue_id', RIXEY)
  .ilike('email', '20girl.mama23@gmail.com')
console.log(`people matching email: ${people?.length ?? 0}`)
for (const p of people ?? []) {
  console.log(`  person ${p.id} → wedding ${p.wedding_id} | first=${p.first_name} last=${p.last_name}`)
}
if (!people?.length) process.exit(1)
const wid = people[0].wedding_id

// Pull interactions on this wedding
const { data: inter } = await sb
  .from('interactions')
  .select('id, type, direction, from_email, from_name, subject, full_body, timestamp')
  .eq('wedding_id', wid)
console.log(`\ninteractions on wedding ${wid}: ${inter?.length ?? 0}`)
for (const i of inter ?? []) {
  console.log(`\n--- [${i.type}/${i.direction}] from=${i.from_name ?? '—'} <${i.from_email}> @ ${i.timestamp}`)
  console.log(`subj: ${i.subject}`)
  const body = i.full_body ?? ''
  console.log(`full_body (${body.length} chars):`)
  console.log(body.slice(0, 2000))
  if (body.length > 2000) console.log(`...[truncated, ${body.length - 2000} more chars]`)
}

// Pull profile
const { data: profile } = await sb
  .from('couple_identity_profile')
  .select('profile, evidence_summary, last_reconstructed_at')
  .eq('wedding_id', wid)
  .maybeSingle()
console.log(`\nprofile:`)
console.log(JSON.stringify(profile?.profile?.names, null, 2))
console.log(`evidence_summary: ${profile?.evidence_summary?.slice(0, 500) ?? '—'}`)
