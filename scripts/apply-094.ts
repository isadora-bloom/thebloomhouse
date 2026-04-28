// Apply migration 094 to the live Rixey database via Supabase RPC.
// We don't have psql in this environment; the simplest path is to
// execute the SQL through the supabase REST RPC (`exec_sql` if
// available) or by chunking into discrete queries via the REST API.
// In practice the easiest reliable path is to use the supabase JS
// client's `rpc` if a `query_exec` function is defined, or to ask the
// user to run it via their Supabase SQL editor.
//
// This script just validates the new column shape exists after the
// migration is applied; it doesn't run the migration itself. The user
// should paste the migration SQL into the Supabase dashboard SQL editor
// and re-run this script to confirm.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
  })
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

async function main() {
  // Verify by selecting the new columns. If the migration ran, the
  // select succeeds; if not, supabase returns an error.
  const { error: selErr } = await sb
    .from('onboarding_progress')
    .select('id, wedding_id, couple_photo_uploaded, first_message_sent, vendor_added, inspo_uploaded, checklist_item_completed, updated_at')
    .limit(1)

  if (selErr) {
    console.log(`❌ onboarding_progress new columns not present yet: ${selErr.message}`)
    console.log('   Apply migration 094 via Supabase SQL editor.')
  } else {
    console.log('✓ onboarding_progress wide columns present.')
  }

  // Check 2: seating_assignments dropped
  const { error: saErr } = await sb.from('seating_assignments').select('id').limit(1)
  if (saErr) {
    if (saErr.message.includes('does not exist') || saErr.message.includes('schema cache')) {
      console.log('✓ seating_assignments dropped.')
    } else {
      console.log(`? seating_assignments select returned: ${saErr.message}`)
    }
  } else {
    console.log('❌ seating_assignments still exists; migration not applied.')
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
