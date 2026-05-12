/**
 * scripts/cascade-for-wedding.ts
 *
 * One-off CLI to fire the identity-discovery cascade for a single
 * wedding. Useful when a backfill / manual data fix just stamped an
 * email or name onto a wedding's people row outside the live
 * pipeline and the cascade therefore never fired — this catches that
 * wedding up without waiting for the next daily backtrack cron.
 *
 * Run:
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs \
 *     scripts/cascade-for-wedding.ts --wedding=<uuid>
 *
 * Idempotent. Re-running on a wedding whose cascade already completed
 * is a no-op (backtrack candidates already stamped, resolver skips
 * resolved candidates).
 */

import { createClient } from '@supabase/supabase-js'
import { triggerIdentityCascade } from '../src/lib/services/identity/cascade-on-enrichment'

const env = {
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
}

function need(name: keyof typeof env): void {
  if (!env[name]) {
    console.error(`Missing env var: ${name}. Run with --env-file=.env.local.`)
    process.exit(1)
  }
}
need('NEXT_PUBLIC_SUPABASE_URL')
need('SUPABASE_SERVICE_ROLE_KEY')

const args = process.argv.slice(2)
const weddingArg =
  args.find((a) => a.startsWith('--wedding='))?.slice('--wedding='.length) ?? null
const reasonArg =
  args.find((a) => a.startsWith('--reason='))?.slice('--reason='.length) ?? 'manual_cli'

if (!weddingArg) {
  console.error('Missing --wedding=<uuid>')
  process.exit(1)
}

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

async function main(): Promise<void> {
  // Resolve venue from the wedding row so the caller doesn't need to
  // pass it. Keeps the CLI surface as small as possible.
  const { data: wed, error } = await sb
    .from('weddings')
    .select('id, venue_id, source, inquiry_date')
    .eq('id', weddingArg)
    .maybeSingle()
  if (error) {
    console.error('Lookup failed:', error.message)
    process.exit(1)
  }
  if (!wed) {
    console.error(`Wedding not found: ${weddingArg}`)
    process.exit(1)
  }
  const venueId = (wed as { venue_id: string }).venue_id
  if (!venueId) {
    console.error('Wedding has no venue_id (?). Aborting.')
    process.exit(1)
  }

  console.log(`\n=== Identity cascade for wedding ${weddingArg} ===`)
  console.log(`  venue:        ${venueId}`)
  console.log(`  source:       ${(wed as { source: string | null }).source ?? '(null)'}`)
  console.log(`  inquiry_date: ${(wed as { inquiry_date: string | null }).inquiry_date ?? '(null)'}`)
  console.log(`  reason:       ${reasonArg}`)
  console.log('')

  const result = await triggerIdentityCascade({
    venueId,
    weddingId: weddingArg as string,
    supabase: sb,
    reason: reasonArg,
  })

  console.log('--- Result ---')
  console.log(`  backtrack auto-linked:    ${result.backtrackAutoLinked}`)
  console.log(`  backtrack queued:         ${result.backtrackQueued}`)
  console.log(`  backtrack hits total:     ${result.backtrackHits}`)
  console.log(`  candidates resolved:      ${result.candidatesResolved}`)
  console.log(`  candidates deferred (AI): ${result.candidatesDeferred}`)
  console.log(`  first_touch updated:      ${result.firstTouchUpdated}`)
  console.log(`  latency:                  ${result.latencyMs}ms`)
  console.log(`  errors:                   ${result.errors.length}`)
  if (result.errors.length > 0) {
    for (const e of result.errors.slice(0, 10)) console.log(`    - ${e}`)
  }

  // Sample the wedding's attribution_events to give the operator a
  // sanity-check picture of what landed (or what was already there).
  const { data: events } = await sb
    .from('attribution_events')
    .select('id, source_platform, tier, decided_by, confidence, is_first_touch, bucket, signal_id, decided_at')
    .eq('wedding_id', weddingArg)
    .is('reverted_at', null)
    .order('decided_at', { ascending: false })
    .limit(20)
  console.log(`\n--- attribution_events (live, max 20) ---`)
  for (const e of (events ?? []) as Array<Record<string, unknown>>) {
    console.log(
      `  ${e.decided_at} | ${e.source_platform} | ${e.tier} | by=${e.decided_by} | conf=${e.confidence} | bucket=${e.bucket} | first_touch=${e.is_first_touch}`,
    )
  }

  // Also surface any candidate_identities that just got resolved (for
  // visibility into which anonymous handles bound to this wedding).
  const { data: linked } = await sb
    .from('candidate_identities')
    .select('id, source_platform, first_name, last_initial, username, resolved_at, resolved_by, resolved_confidence')
    .eq('resolved_wedding_id', weddingArg)
    .order('resolved_at', { ascending: false })
    .limit(20)
  console.log(`\n--- candidate_identities linked to this wedding (max 20) ---`)
  for (const c of (linked ?? []) as Array<Record<string, unknown>>) {
    console.log(
      `  ${c.resolved_at} | ${c.source_platform} | first=${c.first_name ?? '-'} last_init=${c.last_initial ?? '-'} user=${c.username ?? '-'} | by=${c.resolved_by} conf=${c.resolved_confidence}`,
    )
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal:', err)
    process.exit(1)
  })
