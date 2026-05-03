// T5-Rixey-OO #5 cleanup — strip trailing possessive 's / 'S /
// smart-quote 's from people.first_name and people.last_name.
//
// Re-runnable: only updates rows that actually need it. Idempotent.
// Scope: every venue (the parser bug pre-dates the fix; any HoneyBook-
// style import across any venue is potentially affected).
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

console.log("=== T5-Rixey-OO #5 cleanup: strip possessive 's from people names ===\n")

function stripPossessive(s) {
  if (!s || typeof s !== 'string') return s
  // Match straight apostrophe + s/S OR smart curly apostrophe + s/S.
  return s.replace(/['’][sS]$/u, '')
}

async function fetchPolluted() {
  // PostgREST .or() with ilike — match either straight or curly apostrophe
  // followed by s. Using .or for the four combos.
  const { data, error } = await sb
    .from('people')
    .select('id, venue_id, first_name, last_name')
    .or(
      [
        `first_name.ilike.%'s`,
        `first_name.ilike.%’s`,
        `last_name.ilike.%'s`,
        `last_name.ilike.%’s`,
      ].join(','),
    )
    .limit(5000)
  if (error) throw new Error(`scan err: ${error.message}`)
  return data ?? []
}

const polluted = await fetchPolluted()
console.log(`scanned: ${polluted.length} polluted people rows`)

let updated = 0, unchanged = 0, errors = 0
for (const row of polluted) {
  const newFirst = stripPossessive(row.first_name)
  const newLast  = stripPossessive(row.last_name)
  if (newFirst === row.first_name && newLast === row.last_name) {
    unchanged++
    continue
  }
  const { error } = await sb
    .from('people')
    .update({ first_name: newFirst, last_name: newLast })
    .eq('id', row.id)
  if (error) { errors++; console.error(`update ${row.id}: ${error.message}`) }
  else updated++
}

console.log(`people rows updated: ${updated}, unchanged: ${unchanged}, errors: ${errors}`)

const after = await fetchPolluted()
const stillPolluted = after.filter((r) => stripPossessive(r.first_name) !== r.first_name || stripPossessive(r.last_name) !== r.last_name)
console.log(`post-clean still-polluted rows (should be 0): ${stillPolluted.length}\n`)

console.log('Apostrophe cleanup complete. Now run scripts/rixey-load/09-lead-source.ts via tsx for the lead-source backfill.')
