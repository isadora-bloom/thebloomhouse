/**
 * scripts/rematch-sms.ts
 *
 * One-shot local runner for the SMS LLM name + event-context matcher.
 * Iterates every unlinked inbound SMS in the last 90 days and links it
 * to an existing wedding when the body identifies the couple
 * ("Hi, this is Sarah") or references a tour the venue has scheduled
 * around the SMS timestamp.
 *
 * Run:
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/rematch-sms.ts
 *
 * Optional:
 *   --venue=<uuid>   Limit to one venue. Default: every venue with an
 *                    active OpenPhone connection.
 *   --dry-run        Report what WOULD link without writing.
 *
 * Idempotent: only touches rows where person_id IS NULL or wedding_id
 * IS NULL. Re-runs on a clean DB are no-ops.
 */

import { createClient } from '@supabase/supabase-js'
import { tryMatchSmsByName } from '../src/lib/services/ingestion/sms-name-match'

const LOOKBACK_DAYS = 90

const env = {
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
}

function need(name: keyof typeof env): void {
  if (!env[name]) {
    console.error(`Missing env var: ${name}. Run with --env-file=.env.local.`)
    process.exit(1)
  }
}
need('NEXT_PUBLIC_SUPABASE_URL')
need('SUPABASE_SERVICE_ROLE_KEY')
need('ANTHROPIC_API_KEY')

const args = process.argv.slice(2)
const venueArg = args.find((a) => a.startsWith('--venue='))?.slice(8) ?? null
const dryRun = args.includes('--dry-run')

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

async function rematchForVenue(venueId: string): Promise<void> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString()

  const { data: rows, error } = await sb
    .from('interactions')
    .select('id, full_body, body_preview, from_email, timestamp')
    .eq('venue_id', venueId)
    .eq('type', 'sms')
    .eq('direction', 'inbound')
    .or('person_id.is.null,wedding_id.is.null')
    .gte('timestamp', since)
    .order('timestamp', { ascending: false })
    .limit(500)

  if (error) {
    console.error(`[${venueId}] query failed:`, error.message)
    return
  }

  const list = (rows ?? []) as Array<{
    id: string
    full_body: string | null
    body_preview: string | null
    from_email: string | null
    timestamp: string
  }>

  console.log(`[${venueId}] scanning ${list.length} unlinked SMS rows`)

  let matched = 0
  let updated = 0
  const samples: string[] = []

  for (const row of list) {
    const text = (row.full_body ?? row.body_preview ?? '').trim()
    if (!text) continue

    const match = await tryMatchSmsByName({
      supabase: sb,
      venueId,
      body: text,
      fromPhone: row.from_email,
    })
    if (!match) continue
    matched++

    samples.push(
      `  ✓ ${row.timestamp.slice(0, 10)} · ${row.from_email ?? 'no-phone'} → ${match.matchedName} (conf ${match.confidence})`,
    )

    if (dryRun) continue

    const { error: updErr } = await sb
      .from('interactions')
      .update({ person_id: match.personId, wedding_id: match.weddingId })
      .eq('id', row.id)
    if (!updErr) updated++
    else console.warn(`  ✗ update failed for ${row.id}: ${updErr.message}`)
  }

  console.log(`[${venueId}] scanned=${list.length} matched=${matched} updated=${updated}${dryRun ? ' (dry-run)' : ''}`)
  for (const s of samples) console.log(s)
}

async function main(): Promise<void> {
  let venueIds: string[] = []
  if (venueArg) {
    venueIds = [venueArg]
  } else {
    const { data: conns } = await sb
      .from('openphone_connections')
      .select('venue_id')
      .eq('is_active', true)
    venueIds = Array.from(
      new Set(((conns ?? []) as Array<{ venue_id: string }>).map((c) => c.venue_id)),
    )
  }

  if (venueIds.length === 0) {
    console.log('No active OpenPhone connections found.')
    return
  }

  console.log(`Rematching SMS for ${venueIds.length} venue(s)${dryRun ? ' (DRY RUN)' : ''}`)
  for (const venueId of venueIds) {
    await rematchForVenue(venueId)
  }
  console.log('Done.')
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
