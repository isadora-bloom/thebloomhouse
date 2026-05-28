import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = {}
for (const line of readFileSync('.env.production', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (!m) continue
  let v = m[2].trim(); if (v.startsWith('"')) v = v.slice(1); if (v.endsWith('"')) v = v.slice(0, -1)
  env[m[1]] = v.split('\\')[0].trim()
}
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const VENUE = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// Pull all booked/completed weddings, not merged, not tombstoned
const { data: weddings, error } = await supabase
  .from('weddings')
  .select('id, status, wedding_date, inquiry_date, booking_value, created_at, merged_into_id, non_couple_at, source_provenance, crm_source')
  .eq('venue_id', VENUE)
  .in('status', ['booked', 'completed'])
  .is('merged_into_id', null)
  .is('non_couple_at', null)
  .order('created_at', { ascending: true })
if (error) { console.error(error); process.exit(1) }

console.log(`\n=== ${weddings.length} booked/completed weddings (live) ===\n`)

// pull people for each
const ids = weddings.map(w => w.id)
const { data: people } = await supabase
  .from('people')
  .select('id, wedding_id, role, first_name, last_name, email, phone, created_at')
  .in('wedding_id', ids)
  .is('merged_into_id', null)
  .order('created_at', { ascending: true })

const byWedding = new Map()
for (const p of people) {
  const arr = byWedding.get(p.wedding_id) ?? []
  arr.push(p)
  byWedding.set(p.wedding_id, arr)
}

const rows = []
for (const w of weddings) {
  const ppl = byWedding.get(w.id) ?? []
  rows.push({ w, ppl })
}

// Print
for (const { w, ppl } of rows) {
  const names = ppl.map(p => `${p.first_name ?? '?'}|${p.last_name ?? ''}|${p.role}|${p.email ?? ''}`).join('  ;  ')
  console.log(`${w.id}  date=${w.wedding_date ?? 'NULL'}  val=${w.booking_value ?? 'NULL'}  prov=${w.source_provenance ?? ''}  crm=${w.crm_source ?? ''}`)
  console.log(`   people(${ppl.length}): ${names}`)
}

// === Problem 1: cross-source duplicate detection ===
console.log('\n\n=== PROBLEM 1: duplicate clusters ===\n')
const norm = s => (s ?? '').trim().toLowerCase()
const ALIAS = { nick: 'nicholas', mike: 'michael', mike2: 'michael', chris: 'christopher', matt: 'matthew', dave: 'david', dan: 'daniel', joe: 'joseph', tom: 'thomas', will: 'william', jim: 'james', rob: 'robert', bob: 'robert', greg: 'gregory', ben: 'benjamin', sam: 'samuel', alex: 'alexander', kate: 'katherine', katie: 'katherine', liz: 'elizabeth', beth: 'elizabeth', abby: 'abigail', gabby: 'gabriella', gabi: 'gabriella', jen: 'jennifer', jenny: 'jennifer', becca: 'rebecca', becky: 'rebecca', cathy: 'catherine', kathy: 'katherine' }
const canonFirst = s => { const n = norm(s); return ALIAS[n] ?? n }

// build per-wedding firstname-set + emails
function weddingKey(ppl) {
  const firsts = ppl.map(p => canonFirst(p.first_name)).filter(x => x && x !== 'unknown')
  return new Set(firsts)
}
const emailToWeddings = new Map()
const wInfo = []
for (const { w, ppl } of rows) {
  const fset = weddingKey(ppl)
  const emails = ppl.map(p => norm(p.email)).filter(Boolean)
  wInfo.push({ w, ppl, fset, emails })
  for (const e of emails) {
    const arr = emailToWeddings.get(e) ?? []
    arr.push(w.id)
    emailToWeddings.set(e, arr)
  }
}

// union-find by shared email OR identical firstname-set (>=1 name, set equality)
const parent = {}
const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
const union = (a, b) => { parent[find(a)] = find(b) }
for (const { w } of rows) parent[w.id] = w.id

// shared email
for (const [e, wids] of emailToWeddings) {
  if (wids.length > 1) for (let i = 1; i < wids.length; i++) union(wids[0], wids[i])
}
// firstname-set equality (both non-empty, same set)
const setEq = (a, b) => a.size > 0 && a.size === b.size && [...a].every(x => b.has(x))
for (let i = 0; i < wInfo.length; i++) {
  for (let j = i + 1; j < wInfo.length; j++) {
    if (setEq(wInfo[i].fset, wInfo[j].fset)) union(wInfo[i].w.id, wInfo[j].w.id)
  }
}

const clusters = new Map()
for (const { w } of rows) {
  const r = find(w.id)
  const arr = clusters.get(r) ?? []
  arr.push(w.id)
  clusters.set(r, arr)
}
let dupCount = 0
for (const [, members] of clusters) {
  if (members.length < 2) continue
  dupCount++
  console.log(`CLUSTER (${members.length}):`)
  for (const wid of members) {
    const info = wInfo.find(x => x.w.id === wid)
    const names = info.ppl.map(p => `${p.first_name ?? '?'} ${p.last_name ?? ''}`.trim()).join(' & ')
    console.log(`  ${wid}  ${names}  date=${info.w.wedding_date ?? 'NULL'}  val=${info.w.booking_value ?? 'NULL'}  created=${info.w.created_at}  fset={${[...info.fset]}}  emails=[${info.emails}]`)
  }
}
console.log(`\n${dupCount} duplicate clusters found.`)

// === Problem 2: possessive 's names ===
console.log('\n\n=== PROBLEM 2: possessive names ===\n')
const { data: possPeople } = await supabase
  .from('people')
  .select('id, wedding_id, first_name, last_name, role')
  .eq('venue_id', VENUE)
  .is('merged_into_id', null)
let possCount = 0
for (const p of possPeople ?? []) {
  const fnBad = p.first_name && /['’][sS]?$/.test(p.first_name)
  const lnBad = p.last_name && /['’][sS]?$/.test(p.last_name)
  if (fnBad || lnBad) { possCount++; console.log(`  ${p.id}  first="${p.first_name}" last="${p.last_name}" wedding=${p.wedding_id}`) }
}
console.log(`\n${possCount} people with possessive names (all statuses).`)

// === Problem 3: venue-address couples ===
console.log('\n\n=== PROBLEM 3: venue-address couples ===\n')
const VENUE_DOMAINS = ['rixeymanor.com']
const { data: venuePeople } = await supabase
  .from('people')
  .select('id, wedding_id, first_name, last_name, email, role')
  .eq('venue_id', VENUE)
  .is('merged_into_id', null)
  .not('email', 'is', null)
for (const p of venuePeople ?? []) {
  const dom = norm(p.email).split('@')[1] ?? ''
  if (VENUE_DOMAINS.includes(dom)) {
    console.log(`  person ${p.id}  email=${p.email}  name="${p.first_name} ${p.last_name}" role=${p.role} wedding=${p.wedding_id}`)
  }
}
// also people named Rixey/Manor
console.log('\n  -- people named Rixey/Manor --')
for (const p of venuePeople ?? []) {
  if (/rixey|manor/i.test(p.first_name ?? '') || /rixey|manor/i.test(p.last_name ?? '')) {
    console.log(`  person ${p.id}  name="${p.first_name} ${p.last_name}" email=${p.email} wedding=${p.wedding_id}`)
  }
}

process.exit(0)
