/**
 * Stream SS — confirm migration 186 actually moved 'other' → 'honeybook'
 * by re-running the same UPDATE.
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
let raw = ''
for (const c of ['.env.local', 'C:\\Users\\Ismar\\bloom-house\\.env.local']) {
  try { raw = readFileSync(c, 'utf8'); break } catch { /* */ }
}
const env = Object.fromEntries(
  raw.split('\n').filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')] })
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

async function main() {
  // 1. Show how many active rows have crm_source='honeybook'
  const { data: hb } = await sb
    .from('weddings').select('id, source, crm_source, booking_value, status, lead_source')
    .eq('venue_id', RIXEY_ID).is('merged_into_id', null).eq('crm_source', 'honeybook')
  console.log(`Active crm_source='honeybook' rows: ${hb?.length ?? 0}`)
  const dist = new Map<string, { count: number; rev: number; booked: number }>()
  for (const w of (hb ?? []) as Array<{ source: string | null; crm_source: string; booking_value: number | null; status: string | null }>) {
    const k = `source=${w.source}`
    const e = dist.get(k) ?? { count: 0, rev: 0, booked: 0 }
    e.count += 1
    if (w.status === 'booked') {
      e.booked += 1
      e.rev += (w.booking_value ?? 0) / 100
    }
    dist.set(k, e)
  }
  for (const [k, v] of dist) console.log(`  ${k}: count=${v.count} booked=${v.booked} rev=$${v.rev.toFixed(2)}`)

  // 2. The migration 186 UPDATE
  console.log('\nApplying migration 186 UPDATE in-place via supabase JS (idempotent)...')
  const { count: updated } = await sb
    .from('weddings')
    .update({ source: 'honeybook' }, { count: 'exact' })
    .eq('venue_id', RIXEY_ID).is('merged_into_id', null)
    .eq('source', 'other').eq('crm_source', 'honeybook')
  console.log(`  rows updated: ${updated ?? 0}`)

  // Calendly too
  const { count: updatedCal } = await sb
    .from('weddings')
    .update({ source: 'calendly' }, { count: 'exact' })
    .eq('venue_id', RIXEY_ID).is('merged_into_id', null)
    .eq('source', 'other').eq('crm_source', 'calendly')
  console.log(`  calendly rows updated: ${updatedCal ?? 0}`)

  // Re-count
  const { count: hbAfter } = await sb
    .from('weddings').select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID).is('merged_into_id', null).eq('source', 'honeybook')
  console.log(`\nAfter: source='honeybook' active rows: ${hbAfter}`)
  const { count: stillOther } = await sb
    .from('weddings').select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID).is('merged_into_id', null).eq('source', 'other')
  console.log(`After: source='other' active rows: ${stillOther}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
