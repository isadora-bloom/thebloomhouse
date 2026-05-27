/**
 * Fire all Rixey drafts that are status='approved' but sent_at IS NULL
 * — the "I clicked Approve but nothing happened" backlog. Calls
 * sendApprovedDraft (same path the /api/agent/drafts/[id]/send endpoint
 * uses, just with service-role + batched).
 *
 * Usage (RUNS LIVE — no dry-run, since the drafts are already operator-
 * approved):
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/send-stuck-approved-drafts.ts
 */

import { createClient } from '@supabase/supabase-js'
import { sendApprovedDraft } from '../src/lib/services/email/pipeline'

const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
  const { data: stuck, error } = await sb
    .from('drafts')
    .select('id, to_email, subject, approved_at')
    .eq('venue_id', RIXEY_VENUE_ID)
    .eq('status', 'approved')
    .is('sent_at', null)
    .order('approved_at', { ascending: true })
  if (error) { console.error(error); process.exit(1) }

  console.log(`Found ${stuck?.length ?? 0} stuck approved drafts.\n`)
  let ok = 0
  let fail = 0
  for (const d of stuck ?? []) {
    process.stdout.write(`  → ${d.id} (${d.to_email}) ${d.subject?.slice(0,50)}... `)
    try {
      await sendApprovedDraft(d.id as string)
      console.log('✓ sent')
      ok++
    } catch (err) {
      console.log(`✗ FAILED: ${err instanceof Error ? err.message : err}`)
      fail++
    }
  }
  console.log(`\nDone. Sent ${ok} / Failed ${fail} / Total ${stuck?.length ?? 0}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
