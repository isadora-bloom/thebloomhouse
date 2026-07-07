/**
 * Reprocess orphan inbound Knot interactions (no wedding_id) that were
 * ingested by the July 3 historical backfill but never minted weddings.
 *
 * Root cause: pipeline.ts subZeroIdentifier treated ALL relay addresses
 * as non-mintable. Per-prospect Knot relays (firstname.last.NNNNN@member.theknot.com)
 * ARE routable — the fix in pipeline.ts now allows them to mint. This
 * script replays each orphan through mintWedding to create the wedding rows.
 *
 * Usage:
 *   node --env-file=.env.local -r <path>/tsx/dist/cjs/index.cjs scripts/reprocess-knot-orphans.ts
 *   node --env-file=.env.local -r <path>/tsx/dist/cjs/index.cjs scripts/reprocess-knot-orphans.ts --apply
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const DRY_RUN = !process.argv.includes('--apply')
const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => {
      const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    })
)

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
})

// Import pipeline services after env is set
const { mintWedding } = await import('../src/lib/services/identity/mint-wedding.js')
const { isPerProspectRelay } = await import('../src/lib/services/identity/body-extract.js')

// Get all orphan inbound Knot interactions
const { data: orphans, error } = await supabase
  .from('interactions')
  .select('id, from_email, from_name, subject, timestamp, extracted_identity, intent_class')
  .eq('venue_id', RIXEY)
  .ilike('from_email', '%theknot%')
  .is('wedding_id', null)
  .eq('direction', 'inbound')
  .eq('intent_class', 'new_inquiry')
  .gte('timestamp', '2026-01-01')
  .order('timestamp')

if (error) { console.error('Failed to fetch orphans:', error); process.exit(1) }

console.log(`Found ${orphans?.length ?? 0} orphan Knot new_inquiry interactions`)
console.log(DRY_RUN ? '=== DRY RUN (pass --apply to mint) ===' : '=== APPLYING ===')
console.log()

let minted = 0
let skipped = 0
let failed = 0

for (const row of orphans ?? []) {
  const fromEmail = row.from_email as string
  const fromName = row.from_name as string | null
  const ts = row.timestamp as string

  // Confirm it's actually a per-prospect relay
  if (!isPerProspectRelay(fromEmail)) {
    console.log(`SKIP  ${fromEmail} — not a per-prospect relay`)
    skipped++
    continue
  }

  // Extract name from relay if fromName not present
  let displayName = fromName
  if (!displayName) {
    const localPart = fromEmail.split('@')[0]
    const withoutTrailingNum = localPart.replace(/\.\d+$/, '')
    displayName = withoutTrailingNum.replace(/\./g, ' ')
      .split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  }

  const extracted = row.extracted_identity as Record<string, unknown> | null
  const weddingDate = typeof extracted?.wedding_date === 'string' ? extracted.wedding_date : null

  console.log(`${DRY_RUN ? 'WOULD MINT' : 'MINTING'}  ${displayName} (${fromEmail})`)
  console.log(`  timestamp: ${ts?.slice(0, 10)}  wedding_date: ${weddingDate ?? 'unknown'}`)

  if (DRY_RUN) { minted++; continue }

  try {
    const result = await mintWedding({
      venueId: RIXEY,
      source: 'email_pipeline',
      signals: {
        email: fromEmail,
        phone: null,
        fullName: displayName,
        weddingDate: weddingDate,
        inquiryDate: ts,
      },
      reason: 'fresh_inquiry',
      supabase,
      correlationId: `reprocess-knot-${row.id}`,
    })

    // Link the orphan interaction to the newly minted wedding
    const { error: linkErr } = await supabase
      .from('interactions')
      .update({ wedding_id: result.weddingId })
      .eq('id', row.id)

    if (linkErr) {
      console.error(`  Failed to link interaction: ${linkErr.message}`)
    } else {
      console.log(`  → wedding ${result.weddingId} (${result.isNew ? 'new' : 'existing'})`)
    }
    minted++
  } catch (err) {
    console.error(`  FAILED: ${err instanceof Error ? err.message : err}`)
    failed++
  }
}

console.log()
console.log(`=== RESULTS ===`)
console.log(`  Minted: ${minted}  Skipped: ${skipped}  Failed: ${failed}`)
if (DRY_RUN) {
  console.log()
  console.log('Re-run with --apply to actually mint the weddings.')
}
