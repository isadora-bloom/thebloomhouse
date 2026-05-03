// Clean up the throwaway test users created by 17b. Note these specific
// emails were created during phase-2 probing and need removal.
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

// IDs from the 17b run that we need to delete in case the script
// failed before the inline cleanup. These are throwaway dev test users
// that exist only because of the probe.
const TARGETS = [
  // grace+test@rixeymanor.com — already cleaned but try again in case
  // (deleteUser is idempotent on non-existent ids).
  'c17e7ef0-91ec-4075-9f60-da0ab419f090',
  'bd3af98a-7e2a-49ea-b933-98e3eeb3ae4c',
  '88ac1ad2-6fcb-4b3d-92b3-cfd49d1f7e85',
  '8dfb8e7b-340c-45fa-86fd-59a3a2031499',
]

for (const id of TARGETS) {
  const { error } = await sb.auth.admin.deleteUser(id)
  if (error) {
    if (error.message.toLowerCase().includes('not found')) {
      console.log(`  ${id}: already gone`)
    } else {
      console.log(`  ${id}: err — ${error.message}`)
    }
  } else {
    console.log(`  ${id}: deleted`)
  }
}

console.log('done')
