// Pre-check migration 184: ensure no existing rows violate the new
// CHECK constraints before applying them.
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

const MAX_CENTS = 100_000_000 // $1M
const fields = ['booking_value', 'tax_amount', 'amount_paid', 'gratuity_amount', 'refunded_amount']

console.log('=== weddings monetary CHECK pre-validation ===')
for (const f of fields) {
  const { data: high } = await sb
    .from('weddings')
    .select(`id, ${f}`)
    .gt(f, MAX_CENTS)
    .limit(10)
  const { count: highCount } = await sb
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .gt(f, MAX_CENTS)
  const { count: negCount } = await sb
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .lt(f, 0)
  console.log(`  ${f}: > $1M cents = ${highCount ?? 0}, negative = ${negCount ?? 0}`)
  if ((highCount ?? 0) > 0) {
    for (const r of high ?? []) console.log('    sample:', r)
  }
}

console.log()
console.log('=== tangential_signals platform CHECK pre-validation ===')
const { count: total } = await sb
  .from('tangential_signals')
  .select('id', { count: 'exact', head: true })
console.log(`  total rows: ${total}`)

const { data: bothNullSample, count: bothNullCount } = await sb
  .from('tangential_signals')
  .select('id, source_platform, extracted_identity', { count: 'exact' })
  .is('source_platform', null)
  .is('extracted_identity', null)
  .limit(5)
console.log(`  rows with BOTH source_platform IS NULL AND extracted_identity IS NULL: ${bothNullCount ?? 0}`)
for (const r of bothNullSample ?? []) console.log('    sample:', r)

// Rows with source_platform NULL — extracted_identity must contain 'platform'
const { data: nullPlatform, count: nullPlatformCount } = await sb
  .from('tangential_signals')
  .select('id, source_platform, extracted_identity', { count: 'exact' })
  .is('source_platform', null)
  .limit(20)
console.log(`  rows with source_platform IS NULL (any extracted_identity): ${nullPlatformCount ?? 0}`)
let violators = 0
for (const r of nullPlatform ?? []) {
  const ei = r.extracted_identity
  const hasPlatform = ei && typeof ei === 'object' && 'platform' in ei
  if (!hasPlatform) {
    violators++
    if (violators <= 5) console.log('    VIOLATOR:', r)
  }
}
console.log(`  -> of those sampled, would-violate-CHECK: ${violators}`)
