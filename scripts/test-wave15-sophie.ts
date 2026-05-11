/* Wave 15 verification — Sophie Thomas + Luke Wright (948b79a5).
 *
 * Run via: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-wave15-sophie.ts
 */

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import {
  matchReviewToCouple,
  filterReviewsForCouple,
  type PartnerNamePair,
} from '../src/lib/services/identity/review-match'

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

const WEDDING_ID = '948b79a5-5954-4a07-bed4-4fdd3a7d2b95'

;(async () => {

console.log('=== Wave 15 verification — Sophie Thomas ===\n')

const { data: wedding } = await sb
  .from('weddings')
  .select('id, venue_id, inquiry_date, wedding_date, status')
  .eq('id', WEDDING_ID)
  .maybeSingle()
if (!wedding) {
  console.log('Wedding not found:', WEDDING_ID)
  process.exit(0)
}

console.log('Wedding row:', wedding)

const { data: people } = await sb
  .from('people')
  .select('role, first_name, last_name')
  .eq('wedding_id', WEDDING_ID)
  .is('merged_into_id', null)
const peopleRows = (people ?? []) as Array<{
  role: string | null
  first_name: string | null
  last_name: string | null
}>
console.log('\nPeople:', peopleRows)

const partners: PartnerNamePair[] = peopleRows.map((p) => ({
  role: p.role,
  first_name: p.first_name,
  last_name: p.last_name,
}))

const { data: reviews } = await sb
  .from('reviews')
  .select('id, reviewer_name, source, rating, body, review_date')
  .eq('venue_id', (wedding as { venue_id: string }).venue_id)
  .order('review_date', { ascending: false })
  .limit(50)
console.log(`\nFound ${reviews?.length ?? 0} venue reviews.`)

const targetRows = ((reviews as Array<{
  id: string
  reviewer_name: string | null
  review_date: string | null
}>) ?? []).filter((r) =>
  (r.reviewer_name ?? '').toLowerCase().includes('thomas'),
)
console.log(`\nReviews containing "Thomas":`)
for (const r of targetRows) {
  console.log(`  - "${r.reviewer_name}" on ${r.review_date}`)
}

const wedAnchor = {
  inquiry_date: (wedding as { inquiry_date: string | null }).inquiry_date,
  wedding_date: (wedding as { wedding_date: string | null }).wedding_date,
}

console.log('\n=== Strict matcher verdicts ===')
for (const r of targetRows) {
  const v = matchReviewToCouple(
    { id: r.id, reviewer_name: r.reviewer_name, review_date: r.review_date },
    partners,
    wedAnchor,
  )
  console.log(
    `  "${r.reviewer_name}" (${r.review_date}) -> ${
      v.matched ? `MATCHED (${v.matchReason})` : `REJECTED (${v.reason})`
    }`,
  )
}

// Full filter pass
console.log('\n=== Full filter pass on all venue reviews ===')
const fr = filterReviewsForCouple({
  reviews: ((reviews as Array<{
    id: string
    reviewer_name: string | null
    review_date: string | null
  }>) ?? []).map((r) => ({
    id: r.id,
    reviewer_name: r.reviewer_name,
    review_date: r.review_date,
  })),
  partners,
  wedding: wedAnchor,
})
console.log(`kept: ${fr.kept.length}, dropped: ${fr.dropped.length}`)
console.log('Dropped breakdown:')
const byReason: Record<string, number> = {}
for (const d of fr.dropped) {
  byReason[d.reason] = (byReason[d.reason] ?? 0) + 1
}
for (const [k, v] of Object.entries(byReason)) console.log(`  ${k}: ${v}`)

console.log('\nKept reviews (these would feed the LLM prompt):')
for (const k of fr.kept) {
  console.log(`  - "${k.reviewer_name}" (${k.review_date})`)
}

console.log('\nDONE')

})()
