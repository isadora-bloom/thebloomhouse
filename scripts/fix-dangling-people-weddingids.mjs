// After Phase-2 wipe: Gmail cron ran during the wipe window and created people rows
// pointing to weddings that were subsequently deleted. These dangling wedding_id refs
// caused the HoneyBook re-import to silently write nothing (update matched 0 rows).
//
// Fix: for each person with a dangling wedding_id, find the Gmail-built wedding
// via interactions.from_email → set people.wedding_id to that valid wedding id.
// Then re-upload the HoneyBook CSV — the resolver will find the valid wedding
// and upgrade it to booked.
//
// Usage: node scripts/fix-dangling-people-weddingids.mjs [--apply]
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const apply = process.argv.includes('--apply')
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const VENUE = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// 1. Find all people with a non-null wedding_id
const { data: people } = await sb.from('people').select('id, email, wedding_id').eq('venue_id', VENUE).not('wedding_id', 'is', null)
console.log(`People with wedding_id: ${people?.length ?? 0}`)

// 2. Get all valid wedding ids in the DB right now
const { data: weddings } = await sb.from('weddings').select('id').eq('venue_id', VENUE)
const validWeddingIds = new Set((weddings ?? []).map(w => w.id))
console.log(`Valid wedding ids in DB: ${validWeddingIds.size}`)

// 3. Find dangling
const dangling = (people ?? []).filter(p => !validWeddingIds.has(p.wedding_id))
const valid = (people ?? []).filter(p => validWeddingIds.has(p.wedding_id))
console.log(`Dangling (bad wedding_id): ${dangling.length}`)
console.log(`Already valid: ${valid.length}`)

if (dangling.length === 0) { console.log('Nothing to fix.'); process.exit(0) }

// 4. For each dangling person, find the right wedding via interactions.from_email
let fixed = 0, nulled = 0, notFound = 0
for (const person of dangling) {
  if (!person.email) { nulled++; continue }

  // Look for an interaction whose from_email matches this person's email
  const { data: interactions } = await sb
    .from('interactions')
    .select('wedding_id')
    .eq('venue_id', VENUE)
    .ilike('from_email', person.email)
    .not('wedding_id', 'is', null)
    .limit(1)

  const newWeddingId = interactions?.[0]?.wedding_id ?? null

  if (newWeddingId && validWeddingIds.has(newWeddingId)) {
    console.log(`  ${person.email} → fix wedding_id to ${newWeddingId}`)
    if (apply) {
      await sb.from('people').update({ wedding_id: newWeddingId }).eq('id', person.id)
    }
    fixed++
  } else {
    // No interaction found — null out the dangling reference so the next
    // HoneyBook import can resolve fresh via mintWedding.
    console.log(`  ${person.email} → no interaction match, nulling wedding_id`)
    if (apply) {
      await sb.from('people').update({ wedding_id: null }).eq('id', person.id)
    }
    nulled++
  }
}

console.log(`\n${apply ? 'Applied' : 'Dry-run'}:`)
console.log(`  fixed (relinked to valid wedding): ${fixed}`)
console.log(`  nulled (no interaction match): ${nulled}`)
console.log(`  not found: ${notFound}`)
if (!apply) console.log('\nPass --apply to execute.')
else console.log('\nDone. Re-upload the HoneyBook CSV now — resolver will find valid weddings.')
