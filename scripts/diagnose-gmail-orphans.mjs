#!/usr/bin/env node
/**
 * Read-only diagnosis probe for the Gmail-orphan touchpoint tail.
 *
 *   node scripts/diagnose-gmail-orphans.mjs
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

let env = {}
try {
  env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
      }),
  )
} catch {}
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]

const url =
  process.env.SUPABASE_URL ||
  process.env.BRANCH_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL
const key =
  process.env.SUPABASE_KEY ||
  process.env.BRANCH_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) {
  console.error('Need SUPABASE_URL + SUPABASE_KEY (or BRANCH_URL/BRANCH_KEY) in env.')
  process.exit(1)
}

const sb = createClient(url, key, { auth: { persistSession: false } })

console.log(`Target: ${url}`)
console.log('')

// Pull all orphan touchpoints, join via raw_payload->interaction_id, partition.
const PAGE = 1000
const orphans = []
for (let from = 0; ; from += PAGE) {
  const { data, error } = await sb
    .from('touchpoints')
    .select('id, venue_id, signal_tier, action_type, occurred_at, raw_payload')
    .eq('channel', 'gmail')
    .is('couple_id', null)
    .order('id', { ascending: true })
    .range(from, from + PAGE - 1)
  if (error) {
    console.error(`touchpoints page error: ${error.message}`)
    break
  }
  orphans.push(...(data ?? []))
  if (!data || data.length < PAGE) break
}
console.log(`spine touchpoints channel=gmail + couple_id IS NULL — total : ${orphans.length}`)

const iids = Array.from(
  new Set(
    orphans
      .map((t) => (t.raw_payload?.interaction_id ?? null))
      .filter((v) => Boolean(v)),
  ),
)
console.log(`  referenced interaction ids                              : ${iids.length}`)
console.log(`  orphans with NO interaction_id in raw_payload           : ${orphans.length - iids.length}`)

// Fetch the joined interactions in chunks.
const ix = new Map()
for (let i = 0; i < iids.length; i += 200) {
  const chunk = iids.slice(i, i + 200)
  const { data, error } = await sb
    .from('interactions')
    .select('id, venue_id, wedding_id, author_class, direction, from_email, from_name, timestamp')
    .in('id', chunk)
  if (error) { console.error(error.message); continue }
  for (const r of data ?? []) ix.set(r.id, r)
}
console.log(`  interactions matched in DB                              : ${ix.size}`)
console.log('')

// Partition by author_class for the joined rows.
const buckets = { couple: 0, operator: 0, sage: 0, platform_system: 0, vendor: 0, unknown: 0, '(no_ix)': 0, '(ix_gone)': 0 }
const ageBucket = (t) => {
  const d = new Date(t)
  if (Number.isNaN(+d)) return '(no_time)'
  if (d < new Date('2026-05-01')) return 'pre-2026-05'
  if (d < new Date('2026-05-19')) return '2026-05-01..18'
  return '2026-05-19+'
}
const ageBuckets = {}
const authorByAge = {}

const operatorSampleHosts = new Map()

for (const tp of orphans) {
  const iid = tp.raw_payload?.interaction_id
  let cls
  if (!iid) cls = '(no_ix)'
  else if (!ix.has(iid)) cls = '(ix_gone)'
  else cls = ix.get(iid).author_class ?? 'unknown'
  buckets[cls] = (buckets[cls] ?? 0) + 1

  const ab = ageBucket(tp.occurred_at)
  ageBuckets[ab] = (ageBuckets[ab] ?? 0) + 1
  const key2 = `${ab} | ${cls}`
  authorByAge[key2] = (authorByAge[key2] ?? 0) + 1

  if (cls === 'operator' || cls === 'platform_system' || cls === 'vendor') {
    const row = ix.get(iid)
    const dom = row?.from_email && row.from_email.includes('@') ? row.from_email.split('@')[1].toLowerCase() : '-'
    operatorSampleHosts.set(dom, (operatorSampleHosts.get(dom) ?? 0) + 1)
  }
}

console.log('Disposition partition (by joined interactions.author_class):')
for (const [k, v] of Object.entries(buckets)) {
  if (v > 0) console.log(`  ${k.padEnd(18)} : ${v}`)
}
console.log('')
console.log('By age bucket:')
for (const [k, v] of Object.entries(ageBuckets)) {
  console.log(`  ${k.padEnd(18)} : ${v}`)
}
console.log('')
console.log('By age × author:')
for (const [k, v] of Object.entries(authorByAge).sort()) {
  console.log(`  ${k.padEnd(38)} : ${v}`)
}
console.log('')
console.log('Top sender domains (operator + platform_system + vendor subset):')
const top = [...operatorSampleHosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
for (const [d, n] of top) console.log(`  ${d.padEnd(38)} : ${n}`)
