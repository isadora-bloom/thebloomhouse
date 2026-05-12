/**
 * scripts/openphone-historical-sync.ts
 *
 * One-shot historical sync for a venue's OpenPhone (Quo) account. Use
 * when a venue has been on the platform for a while but only the last
 * 24h was pulled (legacy behaviour) — or any time you want to force a
 * deep re-pull (e.g. after fixing the extraction logic).
 *
 * Going-forward, fresh connections automatically pull
 * FIRST_SYNC_DAYS=180 because syncMessages now resolves the window
 * from last_synced_at (null = first sync → 180d). This script is for
 * the existing-venue catch-up case.
 *
 * Run:
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/openphone-historical-sync.ts
 *
 * Optional:
 *   --venue=<uuid>   Limit to one venue. Default: every active connection.
 *   --days=180       Backfill window in days (max 365). Default 180.
 */

import { createClient } from '@supabase/supabase-js'
import { syncMessages } from '../src/lib/services/ingestion/openphone'

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
const daysArg = parseInt(
  args.find((a) => a.startsWith('--days='))?.slice(7) ?? '180',
  10,
)
const days = Number.isFinite(daysArg) && daysArg > 0 ? Math.min(daysArg, 365) : 180

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

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

  console.log(`Historical sync for ${venueIds.length} venue(s) — ${days}d backfill`)

  for (const venueId of venueIds) {
    console.log(`\n[${venueId}] starting...`)
    const t0 = Date.now()
    try {
      const result = await syncMessages(venueId, { sinceHours: days * 24 })
      const elapsedSec = Math.round((Date.now() - t0) / 1000)
      console.log(
        `[${venueId}] done in ${elapsedSec}s — inserted=${result.inserted} skipped=${result.skipped} ` +
          `sms=${result.byChannel.sms} voicemail=${result.byChannel.voicemail} ` +
          `calls=${result.byChannel.call_summary}`,
      )
      if (result.errors.length > 0) {
        console.log(`[${venueId}] errors:`)
        for (const e of result.errors.slice(0, 10)) console.log(`  · ${e}`)
        if (result.errors.length > 10) {
          console.log(`  · …and ${result.errors.length - 10} more`)
        }
      }
    } catch (err) {
      console.error(`[${venueId}] failed:`, err instanceof Error ? err.message : err)
    }
  }
  console.log('\nDone.')
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
