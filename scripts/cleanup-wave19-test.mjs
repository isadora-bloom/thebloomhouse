// Remove Wave 19 test rows from knowledge_gaps + knowledge_captures.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    }),
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

// Remove test-fixture gaps.
const fixtureQuestions = [
  'What is the minimum guest count on a Saturday in peak season?',
  'Are sparklers allowed at the send-off?',
  'Are dogs allowed at the ceremony?',
  'What time do we need to be off the property?',
  'Is there a corkage fee if we bring our own wine?',
]

let removed = 0
for (const q of fixtureQuestions) {
  const { data, error } = await sb
    .from('knowledge_gaps')
    .delete()
    .ilike('question', q)
    .select('id')
  if (error) {
    console.log('  ✗ delete failed for', q.slice(0, 40), ':', error.message)
  } else {
    removed += (data ?? []).length
    console.log('  ✓ removed', (data ?? []).length, 'row(s) for', q.slice(0, 60))
  }
}

// Also remove any leftover __wave19_test__ captures
const { data: caps } = await sb
  .from('knowledge_captures')
  .delete()
  .ilike('question', '__wave19_test__%')
  .select('id')
console.log('  ✓ removed', (caps ?? []).length, '__wave19_test__ capture row(s)')

console.log(`\nTotal gap rows removed: ${removed}`)
