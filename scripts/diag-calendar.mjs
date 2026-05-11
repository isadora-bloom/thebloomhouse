import { createClient } from '@supabase/supabase-js'
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const { data: rows, error: rowErr } = await sb.from('external_calendar_events').select('*').limit(1)
if (rowErr) console.log('SELECT error:', JSON.stringify(rowErr, null, 2))
else console.log('Sample row keys:', Object.keys(rows?.[0] || {}))
console.log('Sample row:', rows?.[0])

const testRow = {
  geo_scope: 'us',
  title: '__diag_test__',
  start_date: '2026-01-01',
  end_date: '2026-01-01',
  category: 'federal_holiday',
  influence_weight: 0.5,
}
const { error: upErr } = await sb.from('external_calendar_events').upsert(testRow, {
  onConflict: 'geo_scope,title,start_date',
  ignoreDuplicates: false,
})
if (upErr) {
  console.log('UPSERT error:', JSON.stringify(upErr, null, 2))
} else {
  console.log('UPSERT succeeded')
  await sb.from('external_calendar_events').delete().eq('title', '__diag_test__')
}
