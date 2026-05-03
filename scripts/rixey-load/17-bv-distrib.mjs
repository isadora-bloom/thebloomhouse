// T5-Rixey-NN: distribution probe for booking_value before applying
// migration 181. We need to confirm the row counts in each magnitude
// band so the cents-vs-dollars heuristic doesn't surprise us.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    })
)

const sb = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

const { data, error } = await sb
  .from('weddings')
  .select('id, venue_id, booking_value, crm_source')
if (error) {
  console.error(error)
  process.exit(1)
}

let nullCount = 0
let smallDollars = 0      // 1 - 100000
let centsBand = 0         // 100001 - 99999999
let anomalous = 0         // >= 100000000
let zero = 0
let negative = 0
let min = Infinity
let max = -Infinity
const sampleAnomalous = []
const sampleSmall = []

for (const w of data) {
  const v = w.booking_value
  if (v == null) { nullCount++; continue }
  if (v === 0) { zero++; continue }
  if (v < 0) { negative++; continue }
  if (v < min) min = v
  if (v > max) max = v
  if (v <= 100000) {
    smallDollars++
    if (sampleSmall.length < 10) sampleSmall.push({ id: w.id, v, src: w.crm_source })
  } else if (v < 100000000) {
    centsBand++
  } else {
    anomalous++
    if (sampleAnomalous.length < 10) sampleAnomalous.push({ id: w.id, v, src: w.crm_source })
  }
}

console.log('booking_value distribution across', data.length, 'weddings:')
console.log('  null              :', nullCount)
console.log('  zero              :', zero)
console.log('  negative          :', negative)
console.log('  1..100000 (dollars→cents target) :', smallDollars)
console.log('  100001..99999999 (cents band)    :', centsBand)
console.log('  >= 100000000 (anomalous)         :', anomalous)
console.log('  min/max non-zero positive       :', min, '/', max)
console.log('')
console.log('sample small (dollars):', sampleSmall)
console.log('sample anomalous     :', sampleAnomalous)
