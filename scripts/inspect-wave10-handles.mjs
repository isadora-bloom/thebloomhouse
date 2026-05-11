/**
 * Quick inspect — why are 1399 people with platform_handles producing
 * zero proposals?
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = { ...process.env }
try {
  const raw = readFileSync('.env.local', 'utf8')
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch {}

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const { data: venues } = await sb.from('venues').select('id').ilike('name', '%rixey%').limit(1)
const rixey = venues?.[0]

const { data: sample } = await sb
  .from('people')
  .select('id, first_name, last_name, platform_handles')
  .eq('venue_id', rixey.id)
  .is('merged_into_id', null)
  .not('platform_handles', 'is', null)
  .limit(10)

console.log('Sample platform_handles:')
for (const p of sample ?? []) {
  console.log(' ', p.first_name, p.last_name, '→', JSON.stringify(p.platform_handles))
}

// Distinct handle counts across all 1399
const { data: all } = await sb
  .from('people')
  .select('platform_handles')
  .eq('venue_id', rixey.id)
  .is('merged_into_id', null)
  .not('platform_handles', 'is', null)

const handleMap = new Map()
for (const p of all ?? []) {
  if (!p.platform_handles || typeof p.platform_handles !== 'object') continue
  for (const [platform, handle] of Object.entries(p.platform_handles)) {
    if (!handle) continue
    const key = String(handle).trim().toLowerCase()
    if (!handleMap.has(key)) handleMap.set(key, [])
    handleMap.get(key).push({ platform })
  }
}
console.log('\nDistinct handles total:', handleMap.size)
let multiCount = 0
for (const [h, rows] of handleMap.entries()) {
  if (rows.length >= 2) multiCount += 1
}
console.log('Handles observed on 2+ records:', multiCount)
console.log('Sample multi-record handles:')
let n = 0
for (const [h, rows] of handleMap.entries()) {
  if (rows.length < 2) continue
  console.log(' ', h, '→', rows.length, 'records on', [...new Set(rows.map(r => r.platform))].join(', '))
  if (++n >= 10) break
}
