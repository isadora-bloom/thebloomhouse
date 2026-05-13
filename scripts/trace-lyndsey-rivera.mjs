#!/usr/bin/env node
/**
 * Sage isn't drafting replies to everything. User flagged:
 *   "New estimate: Lyndsey Rivera & Nicholas Santamaria — $14,840
 *    Your Rixey | Wed, May 13, 2026, 1:22 PM"
 *
 * Trace the wedding + every interaction + draft + drafting decision.
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

// 1. Find Lyndsey / Rivera / Santamaria
const { data: ppl } = await sb
  .from('people')
  .select('id, wedding_id, role, first_name, last_name, email, phone, merged_into_id')
  .eq('venue_id', RIXEY)
  .or('first_name.ilike.%Lyndsey%,first_name.ilike.%Nicholas%,last_name.ilike.%Rivera%,last_name.ilike.%Santamaria%')

console.log(`People matching: ${ppl?.length ?? 0}`)
for (const p of ppl ?? []) {
  console.log(`  [${p.role}] ${p.first_name ?? '—'} ${p.last_name ?? '—'} <${p.email ?? '—'}> ${p.phone ?? '—'} → wedding ${p.wedding_id} ${p.merged_into_id ? `(merged→${p.merged_into_id})` : ''}`)
}

const weddingIds = [...new Set((ppl ?? []).map((p) => p.wedding_id).filter(Boolean))]
console.log(`\nDistinct wedding ids: ${weddingIds.length}`)
for (const wid of weddingIds) {
  console.log(`\n=== wedding ${wid} ===`)
  const { data: w } = await sb
    .from('weddings')
    .select('id, status, source, source_detail, inquiry_date, wedding_date, booking_value, lifecycle_stage, lost_at, booked_at, non_couple_at, merged_into_id, crm_source')
    .eq('id', wid)
    .maybeSingle()
  if (!w) { console.log(`  not found`); continue }
  console.log(`  status=${w.status} stage=${w.lifecycle_stage} source=${w.source ?? '—'} (${w.source_detail ?? '—'}) crm=${w.crm_source ?? '—'}`)
  console.log(`  inquiry=${w.inquiry_date} wedding_date=${w.wedding_date ?? '—'} booking_value=${w.booking_value ?? '—'}`)
  console.log(`  booked=${w.booked_at ?? '—'} lost=${w.lost_at ?? '—'} merged=${w.merged_into_id ?? '—'} non_couple=${w.non_couple_at ?? '—'}`)

  // Interactions
  const { data: inter } = await sb
    .from('interactions')
    .select('id, type, direction, from_email, from_name, subject, timestamp, intent_class, lifecycle_folder, surface, signal_class, body_preview, full_body')
    .eq('wedding_id', wid)
    .order('timestamp', { ascending: true })
  console.log(`\n  interactions: ${inter?.length ?? 0}`)
  for (const i of inter ?? []) {
    const subj = (i.subject ?? '').slice(0, 80)
    console.log(`    [${i.timestamp.slice(0, 16)}] ${i.type}/${i.direction} surface=${i.surface ?? '—'} class=${i.signal_class ?? '—'} intent=${i.intent_class ?? '—'} folder=${i.lifecycle_folder ?? '—'}`)
    console.log(`      from=${i.from_name ?? '—'} <${i.from_email ?? '—'}> subj="${subj}"`)
  }

  // Drafts
  const { data: drafts } = await sb
    .from('drafts')
    .select('id, status, created_at, sent_at, recipient_email, subject, body_preview, interaction_id, classification, auto_send_blocked_reason')
    .eq('wedding_id', wid)
    .order('created_at', { ascending: true })
  console.log(`\n  drafts: ${drafts?.length ?? 0}`)
  for (const d of drafts ?? []) {
    console.log(`    [${d.created_at.slice(0, 16)}] status=${d.status} sent=${d.sent_at ? d.sent_at.slice(0, 16) : '—'} to=${d.recipient_email ?? '—'}`)
    console.log(`      subj="${(d.subject ?? '').slice(0, 60)}"`)
    console.log(`      reply-to interaction=${d.interaction_id ?? '—'}`)
    console.log(`      class=${d.classification ?? '—'} auto_send_blocked=${d.auto_send_blocked_reason ?? '—'}`)
  }

  // Find inbound interactions WITHOUT a corresponding draft
  const inboundIds = (inter ?? []).filter((i) => i.direction === 'inbound').map((i) => i.id)
  const draftedAgainst = new Set((drafts ?? []).map((d) => d.interaction_id).filter(Boolean))
  const noDraft = inboundIds.filter((id) => !draftedAgainst.has(id))
  console.log(`\n  inbound interactions: ${inboundIds.length}; drafted-against: ${draftedAgainst.size}; missing drafts: ${noDraft.length}`)
  for (const id of noDraft) {
    const i = inter.find((x) => x.id === id)
    if (!i) continue
    console.log(`    NO DRAFT for [${i.timestamp.slice(0, 16)}] ${i.type} intent=${i.intent_class ?? '—'} folder=${i.lifecycle_folder ?? '—'} subj="${(i.subject ?? '').slice(0, 60)}"`)
  }
}
