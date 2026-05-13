#!/usr/bin/env node
/**
 * Why is a wedding showing "Unknown" in the leads list when its tour
 * shows a real couple name? Pick one wedding ID and trace every
 * possible name source.
 *
 * Usage:
 *   node scripts/diagnose-unknown-vs-tour.mjs <event_code>
 *
 * If no event_code passed, samples 5 random Unknown weddings that
 * have a tour scheduled and reports each.
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
// Quick sanity check
const { data: vCheck } = await sb.from('venues').select('id, name').eq('id', RIXEY).maybeSingle()
console.log(`Venue check: ${JSON.stringify(vCheck)}`)
const { count: totalWeddings } = await sb.from('weddings').select('id', { head: true, count: 'exact' }).eq('venue_id', RIXEY)
console.log(`Total Rixey weddings (any state): ${totalWeddings}`)
const { count: activeWeddings } = await sb.from('weddings').select('id', { head: true, count: 'exact' }).eq('venue_id', RIXEY).is('non_couple_at', null).is('merged_into_id', null)
console.log(`Active (non-tombstoned, non-merged): ${activeWeddings}`)
const arg = process.argv[2] ?? null

async function trace(weddingId, eventCode) {
  console.log(`\n=== ${eventCode} (${weddingId}) ===`)
  const { data: w, error: wErr } = await sb
    .from('weddings')
    .select('id, event_code, status, wedding_date, inquiry_date, source, non_couple_at, merged_into_id, lifecycle_stage')
    .eq('id', weddingId)
    .maybeSingle()
  if (wErr) { console.log('  wedding query error:', wErr.message); return }
  if (!w) { console.log('  wedding not found'); return }
  eventCode = w.event_code ?? eventCode
  console.log(`  status:        ${w.status}`)
  console.log(`  wedding_date:  ${w.wedding_date ?? '—'}`)
  console.log(`  inquiry_date:  ${w.inquiry_date ?? '—'}`)
  console.log(`  source:        ${w.source ?? '—'}`)
  console.log(`  weddings.couple_name: ${w.couple_name ?? '—'}`)
  console.log(`  non_couple_at: ${w.non_couple_at ?? 'null'}`)
  console.log(`  merged_into_id: ${w.merged_into_id ?? 'null'}`)
  console.log(`  lifecycle_stage: ${w.lifecycle_stage ?? '—'}`)

  // People
  const { data: people } = await sb
    .from('people')
    .select('id, role, first_name, last_name, email, phone, display_handle, merged_into_id, name_evidence')
    .eq('wedding_id', weddingId)
    .is('merged_into_id', null)
  console.log(`  people (${people?.length ?? 0}):`)
  for (const p of people ?? []) {
    const evCount = Array.isArray(p.name_evidence) ? p.name_evidence.length : 0
    console.log(`    [${p.role}] first=${p.first_name ?? '—'} last=${p.last_name ?? '—'} email=${p.email ?? '—'} phone=${p.phone ?? '—'} handle=${p.display_handle ?? '—'} name_evidence=${evCount}`)
  }

  // Couple identity profile
  const { data: profile } = await sb
    .from('couple_identity_profile')
    .select('profile, last_reconstructed_at, reconstruction_count, partner1_locked_by_operator')
    .eq('wedding_id', weddingId)
    .maybeSingle()
  if (!profile) {
    console.log(`  couple_identity_profile: NONE`)
  } else {
    const p1 = profile.profile?.names?.partner1
    const p2 = profile.profile?.names?.partner2
    console.log(`  couple_identity_profile:`)
    console.log(`    partner1: ${typeof p1 === 'string' ? p1 : JSON.stringify(p1) ?? '—'}`)
    console.log(`    partner2: ${typeof p2 === 'string' ? p2 : JSON.stringify(p2) ?? '—'}`)
    console.log(`    last_reconstructed: ${profile.last_reconstructed_at ?? '—'}`)
    console.log(`    count: ${profile.reconstruction_count ?? 0}`)
    console.log(`    locked: ${profile.partner1_locked_by_operator ?? false}`)
  }

  // Tours
  const { data: tours } = await sb
    .from('tours')
    .select('id, scheduled_at, tour_type, outcome, source, notes')
    .eq('wedding_id', weddingId)
    .order('scheduled_at', { ascending: false })
  console.log(`  tours (${tours?.length ?? 0}):`)
  for (const t of tours ?? []) {
    console.log(`    @ ${t.scheduled_at} ${t.tour_type} outcome=${t.outcome ?? '—'} source=${t.source ?? '—'}`)
    if (t.notes) console.log(`      notes: ${String(t.notes).slice(0, 120)}`)
  }

  // Interactions sample (first inbound)
  const { data: inter } = await sb
    .from('interactions')
    .select('id, type, direction, from_email, from_name, subject, timestamp, intent_class')
    .eq('wedding_id', weddingId)
    .eq('direction', 'inbound')
    .order('timestamp', { ascending: true })
    .limit(3)
  console.log(`  inbound interactions (showing first ${inter?.length ?? 0}):`)
  for (const i of inter ?? []) {
    console.log(`    [${i.type}] from=${i.from_name ?? '—'} <${i.from_email ?? '—'}> subj="${(i.subject ?? '').slice(0, 50)}" intent=${i.intent_class ?? '—'}`)
  }
}

async function main() {
  if (arg) {
    const { data: w } = await sb
      .from('weddings')
      .select('id, event_code')
      .eq('event_code', arg)
      .eq('venue_id', RIXEY)
      .maybeSingle()
    if (!w) { console.error(`event_code ${arg} not found at Rixey`); process.exit(1) }
    await trace(w.id, w.event_code)
  } else {
    // Sample 5 Unknown weddings.
    const { data: candidates, error: candErr } = await sb
      .from('weddings')
      .select('id, event_code, status, lifecycle_stage')
      .eq('venue_id', RIXEY)
      .is('non_couple_at', null)
      .is('merged_into_id', null)
      .order('inquiry_date', { ascending: false, nullsFirst: false })
      .limit(100)
    if (candErr) console.log('  candidates query error:', candErr.message)
    console.log(`Pulled ${candidates?.length ?? 0} non-tombstoned weddings (most recent 100)`)
    const statusCounts = {}
    for (const w of candidates ?? []) statusCounts[w.status ?? 'null'] = (statusCounts[w.status ?? 'null'] ?? 0) + 1
    console.log('  status breakdown:', JSON.stringify(statusCounts))
    if (!candidates) { console.error('no candidates'); process.exit(1) }

    // Filter to ones with no name on people
    const sampled = []
    for (const w of candidates) {
      const { data: p } = await sb
        .from('people')
        .select('first_name')
        .eq('wedding_id', w.id)
        .eq('role', 'partner1')
        .limit(1)
      const first = p?.[0]?.first_name
      if (!first || first === '(Unknown)' || first === 'Unknown') {
        sampled.push(w)
        if (sampled.length >= 5) break
      }
    }
    console.log(`Found ${sampled.length} Unknown candidates with tour/inquiry stage. Tracing each:`)
    for (const w of sampled) await trace(w.id, w.event_code)
  }
}
main().catch(err => { console.error(err); process.exit(1) })
