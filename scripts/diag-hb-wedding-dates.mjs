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

// Parse CSV: get email → { projectDate, bookedDate } map
const csv = readFileSync('C:/Users/Ismar/Downloads/June-2023-Booked Client-report-(HoneyBook).csv', 'utf8')
const lines = csv.split('\n').filter(l => l.trim())
const header = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''))
const emailIdx = header.findIndex(h => /^email$/i.test(h))
const projectDateIdx = header.findIndex(h => /^project\s*date$|^event\s*date$|^date$/i.test(h))
const bookedIdx = header.findIndex(h => /^booked?\s*date$/i.test(h))

const csvMap = {}
for (const line of lines.slice(1)) {
  const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''))
  const email = cols[emailIdx]?.toLowerCase()
  if (!email) continue
  if (!csvMap[email]) {
    csvMap[email] = { projectDate: cols[projectDateIdx], bookedDate: cols[bookedIdx] }
  }
}
console.log('project_date header:', header[projectDateIdx])
console.log('CSV rows mapped:', Object.keys(csvMap).length)

// Check first 5 weddings: compare DB wedding_date to CSV project_date
const { data: people } = await sb.from('people').select('email, wedding_id').eq('venue_id', VENUE).limit(100)
let matchCount = 0, mismatchCount = 0, noCSV = 0

for (const p of (people ?? []).slice(0, 20)) {
  if (!p.email || !p.wedding_id) continue
  const csvRow = csvMap[p.email.toLowerCase()]
  if (!csvRow) { noCSV++; continue }

  const { data: w } = await sb.from('weddings').select('id, wedding_date, status, booked_at').eq('id', p.wedding_id).maybeSingle()
  if (!w) continue

  // CSV project date may be like "2025-08-29 00:00:00 UTC"
  const csvDateStr = csvRow.projectDate?.split(' ')[0]
  const dbDateStr = w.wedding_date?.split('T')[0]

  if (csvDateStr === dbDateStr) {
    matchCount++
  } else {
    mismatchCount++
    if (mismatchCount <= 3) {
      console.log(`MISMATCH ${p.email}: CSV=${csvDateStr} DB=${dbDateStr} status=${w.status}`)
    }
  }
}
console.log(`\nDate matches: ${matchCount}, mismatches: ${mismatchCount}, not in CSV: ${noCSV}`)
