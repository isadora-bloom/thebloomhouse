// Remove Wave 19 test rows from knowledge_gaps + knowledge_captures.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { parseSafetyFlags, assertNotProd, requireApply } from './_safety.mjs'

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

const { apply, allowProd } = parseSafetyFlags(process.argv)
assertNotProd(env.NEXT_PUBLIC_SUPABASE_URL, { allowProd })

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

const willWrite = requireApply(apply, 'cleanup-wave19-test')

let removed = 0
for (const q of fixtureQuestions) {
  if (!willWrite) {
    const { count } = await sb
      .from('knowledge_gaps')
      .select('id', { count: 'exact', head: true })
      .ilike('question', q)
    console.log('  WOULD remove', count ?? 0, 'row(s) for', q.slice(0, 60))
    continue
  }
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

if (!willWrite) {
  const { count } = await sb
    .from('knowledge_captures')
    .select('id', { count: 'exact', head: true })
    .ilike('question', '__wave19_test__%')
  console.log('  WOULD remove', count ?? 0, '__wave19_test__ capture row(s)')
} else {
  // Also remove any leftover __wave19_test__ captures
  const { data: caps } = await sb
    .from('knowledge_captures')
    .delete()
    .ilike('question', '__wave19_test__%')
    .select('id')
  console.log('  ✓ removed', (caps ?? []).length, '__wave19_test__ capture row(s)')

  console.log(`\nTotal gap rows removed: ${removed}`)
}
