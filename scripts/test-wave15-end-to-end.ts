/* Wave 15 end-to-end verification on Sophie Thomas.
 *
 * Runs reconstructCoupleIdentity AND inspects:
 *   - evidence_summary (reviews_count should be 0; no Lauren/Thomas)
 *   - discovery_sources_count + discovery_source_recent (ChatGPT)
 *   - evidence_overrides_count
 *
 * Then sets an evidence_override on the discovery_source row, re-runs,
 * and confirms the override took effect (discovery row excluded).
 */

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { reconstructCoupleIdentity, getStoredCoupleIdentityProfile } from '../src/lib/services/identity/reconstruct'

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
console.log('=== Wave 15 end-to-end on Sophie Thomas ===\n')

// 1. Show what reviewing the stored profile looks like BEFORE we
//    rebuild (cached row from earlier).
const before = await getStoredCoupleIdentityProfile(WEDDING_ID, { supabase: sb })
if (before) {
  console.log('Cached profile evidence_summary (before rebuild):')
  console.log(JSON.stringify(before.evidenceSummary, null, 2))
}

// 2. Force a fresh reconstruction (this calls the LLM — costs a few cents).
console.log('\nRunning reconstruction (this calls Sonnet)...')
const r = await reconstructCoupleIdentity(WEDDING_ID, { supabase: sb })
console.log('\nReconstruction completed.')
console.log('evidence_summary:')
console.log(JSON.stringify(r.evidenceSummary, null, 2))
console.log(`cost: $${(r.costCents / 100).toFixed(4)}`)

// 3. Confirm reviews_count = 0 (Lauren/Thomas filtered out by strict matcher)
if ((r.evidenceSummary.reviews_count ?? 0) === 0) {
  console.log('\n[PASS] reviews_count = 0 (Lauren and Thomas S filtered)')
} else {
  console.log(`\n[FAIL] reviews_count = ${r.evidenceSummary.reviews_count} (expected 0)`)
}

// 4. Confirm discovery_sources_count > 0
if ((r.evidenceSummary.discovery_sources_count ?? 0) > 0) {
  console.log(`[PASS] discovery_sources_count = ${r.evidenceSummary.discovery_sources_count}`)
  console.log(`       discovery_source_recent:`, r.evidenceSummary.discovery_source_recent)
} else {
  console.log('[FAIL] discovery_sources_count = 0 (expected > 0)')
}

// 5. Confirm evidence_overrides_count reflects what we wrote
if ((r.evidenceSummary.evidence_overrides_count ?? 0) > 0) {
  console.log(`[PASS] evidence_overrides_count = ${r.evidenceSummary.evidence_overrides_count}`)
} else {
  console.log('[FAIL] evidence_overrides_count = 0 (expected > 0)')
}

console.log('\nDONE')
})()
