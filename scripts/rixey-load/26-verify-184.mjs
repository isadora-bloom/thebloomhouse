// Verify migration 184: CHECK constraints in place + reject test
// inserts that violate them.
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

// Find a real venue id to anchor test rows.
const { data: venue } = await sb.from('venues').select('id').limit(1).single()
const VENUE = venue?.id

console.log('=== migration 184 enforcement test ===')

// Test 1: tangential_signals — insert with both source_platform AND
// extracted_identity NULL; expect rejection.
{
  const { error } = await sb.from('tangential_signals').insert({
    venue_id: VENUE,
    signal_type: 'rr_test',
    action_class: 'inquiry',
    signal_date: new Date().toISOString(),
    source_platform: null,
    extracted_identity: null,
  })
  console.log('TS both-null insert:', error ? `REJECTED ✓ (${error.code})` : 'ACCEPTED — BUG')
}

// Test 2: tangential_signals — extracted_identity present but no
// 'platform' key; expect rejection.
{
  const { error } = await sb.from('tangential_signals').insert({
    venue_id: VENUE,
    signal_type: 'rr_test',
    action_class: 'inquiry',
    signal_date: new Date().toISOString(),
    source_platform: null,
    extracted_identity: { name: 'no-platform-key' },
  })
  console.log('TS extracted-without-platform insert:', error ? `REJECTED ✓ (${error.code})` : 'ACCEPTED — BUG')
}

// Test 3: tangential_signals — extracted_identity HAS platform; expect ACCEPT.
{
  const { error, data } = await sb.from('tangential_signals').insert({
    venue_id: VENUE,
    signal_type: 'rr_test',
    action_class: 'inquiry',
    signal_date: new Date().toISOString(),
    source_platform: null,
    extracted_identity: { platform: 'rr_test' },
  }).select('id').single()
  console.log('TS extracted-with-platform insert:', error ? `REJECTED — BUG (${error.message})` : 'ACCEPTED ✓')
  if (data?.id) await sb.from('tangential_signals').delete().eq('id', data.id)
}

// Test 4: tangential_signals — source_platform present, extracted NULL;
// expect ACCEPT.
{
  const { error, data } = await sb.from('tangential_signals').insert({
    venue_id: VENUE,
    signal_type: 'rr_test',
    action_class: 'inquiry',
    signal_date: new Date().toISOString(),
    source_platform: 'rr_test',
    extracted_identity: null,
  }).select('id').single()
  console.log('TS source_platform-only insert:', error ? `REJECTED — BUG (${error.message})` : 'ACCEPTED ✓')
  if (data?.id) await sb.from('tangential_signals').delete().eq('id', data.id)
}

// Test 5: weddings — booking_value over $1M cents; expect rejection.
{
  const { error, data } = await sb.from('weddings').insert({
    venue_id: VENUE,
    inquiry_date: new Date().toISOString().slice(0, 10),
    status: 'inquiry',
    source: 'website',
    booking_value: 100_000_001,
  }).select('id').single()
  console.log('weddings booking_value > $1M cents insert:', error ? `REJECTED ✓ (${error.code})` : 'ACCEPTED — BUG')
  if (data?.id) await sb.from('weddings').delete().eq('id', data.id)
}

// Test 6: weddings — booking_value at $1M cents (boundary); expect ACCEPT.
{
  const { error, data } = await sb.from('weddings').insert({
    venue_id: VENUE,
    inquiry_date: new Date().toISOString().slice(0, 10),
    status: 'inquiry',
    source: 'website',
    booking_value: 100_000_000,
  }).select('id').single()
  console.log('weddings booking_value = $1M cents insert:', error ? `REJECTED — BUG (${error.message})` : 'ACCEPTED ✓')
  if (data?.id) await sb.from('weddings').delete().eq('id', data.id)
}

// Test 7: weddings — negative booking_value; expect rejection.
{
  const { error, data } = await sb.from('weddings').insert({
    venue_id: VENUE,
    inquiry_date: new Date().toISOString().slice(0, 10),
    status: 'inquiry',
    source: 'website',
    booking_value: -1,
  }).select('id').single()
  console.log('weddings negative booking_value insert:', error ? `REJECTED ✓ (${error.code})` : 'ACCEPTED — BUG')
  if (data?.id) await sb.from('weddings').delete().eq('id', data.id)
}
