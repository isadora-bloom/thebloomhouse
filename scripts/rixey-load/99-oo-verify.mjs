// T5-Rixey-OO verification script — confirms migration 182 + 183 + the
// apostrophe + lead-source backfills ran cleanly.
//
// Idempotent: pure SELECTs + targeted UPDATEs only. Re-runnable.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

console.log('=== T5-Rixey-OO post-migration verification ===\n')

// 1. website_traffic_history backfill row count.
{
  const { count, error } = await sb
    .from('website_traffic_history')
    .select('*', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID)
  if (error) console.error('website_traffic_history count err:', error.message)
  else console.log(`website_traffic_history rows for Rixey: ${count}`)
}

// 2. tangential_signals — confirm GA4 rows are GONE.
{
  const { count, error } = await sb
    .from('tangential_signals')
    .select('*', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID)
    .eq('signal_type', 'analytics_entry')
    .eq('source_platform', 'ga4')
  if (error) console.error('tangential_signals GA4 count err:', error.message)
  else console.log(`tangential_signals GA4 leftover rows (should be 0): ${count}`)
}

// 3. weddings.lead_source_derivation_attempted_at column verification.
//    Sample one row + show it's null pre-cron.
{
  const { count: nullCount, error: e1 } = await sb
    .from('weddings')
    .select('*', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID)
    .is('lead_source', null)
    .is('lead_source_derivation_attempted_at', null)
    .is('merged_into_id', null)
  if (e1) console.error('null-attempted_at count err:', e1.message)
  else console.log(`weddings with NULL lead_source AND NULL attempted_at (cron candidates): ${nullCount}`)

  const { count: stampedCount, error: e2 } = await sb
    .from('weddings')
    .select('*', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID)
    .not('lead_source_derivation_attempted_at', 'is', null)
  if (e2) console.error('stamped count err:', e2.message)
  else console.log(`weddings with attempted_at populated: ${stampedCount}`)
}

// 4. Apostrophe-pollution count: people whose first/last names end in 's.
{
  const { data: rows1, error: e1 } = await sb
    .from('people')
    .select('id, wedding_id, role, first_name, last_name')
    .eq('venue_id', RIXEY_ID)
    .or(`first_name.ilike.%'s,last_name.ilike.%'s`)
    .limit(200)
  if (e1) console.error('apostrophe scan err:', e1.message)
  else console.log(`people with possessive 's bleed in first/last name: ${rows1?.length ?? 0}`)
  if (rows1 && rows1.length > 0) {
    for (const p of rows1.slice(0, 5)) {
      console.log(`  - ${p.role}: first="${p.first_name}" last="${p.last_name}"`)
    }
  }
}

console.log('\nVerification complete.')
