// Verify the intent summary endpoint via direct service call.

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

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

const { getIntentSummary } = await import(
  '../src/lib/services/attribution-roles/intent-summary.ts'
)
const venueId = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const summary = await getIntentSummary(venueId)
console.log('byIntent:', summary.byIntent)
console.log('classified events:', summary.totalEvents - summary.unclassifiedCount)
console.log('total events:', summary.totalEvents)
console.log('latestClassifiedAt:', summary.latestClassifiedAt)

console.log('\nTop 5 channels:')
for (const c of summary.byChannel.slice(0, 5)) {
  console.log(`  ${c.channel}: total=${c.total} targeted=${c.targeted} broadcast=${c.broadcast} validation=${c.validation} unknown=${c.unknown}`)
  console.log(`    broadcast_share: ${c.broadcast_share_0_1 !== null ? (c.broadcast_share_0_1 * 100).toFixed(1) + '%' : 'n/a'}`)
  console.log(`    conv_by_intent:`, c.conversion_by_intent)
}
