// Test a single HoneyBook row through commitNormalisedRows to see what path is taken
// and whether the status upgrade fires.
// Usage: npx tsx scripts/test-hb-single-row.ts
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const VENUE = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// Pick the second email (nandabusekrus) since first (ablainept001) was already manually touched
const testEmail = 'nandabusekrus@gmail.com'
const testWeddingId = 'dba76597-f72a-4d97-8f97-84c02e5e7be7'

console.log('=== Before ===')
const { data: before } = await supabase.from('weddings').select('id,status,booked_at,wedding_date').eq('id', testWeddingId).single()
console.log(JSON.stringify(before))

const { data: personBefore } = await supabase.from('people').select('id,email,wedding_id').eq('venue_id', VENUE).ilike('email', testEmail).maybeSingle()
console.log('person before:', JSON.stringify(personBefore))

// Test: run the UPDATE directly
const backfill = {
  status: 'booked',
  booked_at: '2025-10-04T18:02:56Z',
  booking_value: 1500000, // placeholder
}
const { error: updErr, data: updData } = await supabase
  .from('weddings')
  .update(backfill)
  .eq('id', testWeddingId)
  .select('id, status, booked_at')

console.log('\n=== After direct UPDATE ===')
console.log('error:', updErr?.message ?? 'none')
console.log('updated row:', JSON.stringify(updData))

const { data: after } = await supabase.from('weddings').select('id,status,booked_at').eq('id', testWeddingId).single()
console.log('re-fetch after update:', JSON.stringify(after))
