// Test what resolveIdentity returns for HoneyBook CSV emails
// and whether the status upgrade UPDATE is actually working.
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const VENUE = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// Read first 5 emails from CSV
const csv = readFileSync('C:/Users/Ismar/Downloads/June-2023-Booked Client-report-(HoneyBook).csv', 'utf8')
const lines = csv.split('\n').filter(l => l.trim())
const header = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''))
const emailIdx = header.findIndex(h => /^email$/i.test(h))
const bookingIdx = header.findIndex(h => /booked?\s*date/i.test(h))
const firstNameIdx = header.findIndex(h => /^first\s*name$/i.test(h))
const lastNameIdx = header.findIndex(h => /^last\s*name$/i.test(h))

const sampleEmails = []
for (const line of lines.slice(1, 12)) {
  const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''))
  if (cols[emailIdx]) sampleEmails.push({ email: cols[emailIdx], booking: cols[bookingIdx], first: cols[firstNameIdx], last: cols[lastNameIdx] })
}

console.log('Sample emails from CSV:')
for (const s of sampleEmails) {
  console.log(' ', s.email, 'booking:', s.booking)
}

// Check each email in the DB: does a person exist? What wedding?
console.log('\n--- DB lookup by email ---')
for (const s of sampleEmails.slice(0, 5)) {
  const { data: people } = await sb.from('people')
    .select('id, email, wedding_id')
    .eq('venue_id', VENUE)
    .ilike('email', s.email)
    .limit(2)

  if (!people || people.length === 0) {
    console.log(`${s.email}: NO person found`)
    continue
  }

  const person = people[0]
  console.log(`${s.email}: person=${person.id.slice(0, 8)} wedding_id=${person.wedding_id?.slice(0, 8) ?? 'null'}`)

  if (person.wedding_id) {
    const { data: w } = await sb.from('weddings').select('id, status, booked_at, wedding_date').eq('id', person.wedding_id).maybeSingle()
    if (w) {
      console.log(`  wedding status=${w.status} booked_at=${w.booked_at} wedding_date=${w.wedding_date}`)
    } else {
      console.log(`  WARNING: wedding ${person.wedding_id} not found in DB (dangling ref)`)
    }
  }
}
