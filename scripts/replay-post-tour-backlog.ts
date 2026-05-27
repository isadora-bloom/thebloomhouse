/**
 * scripts/replay-post-tour-backlog.ts
 *
 * Backfills the post-tour nurture sequence (migration 376) for couples
 * who toured BEFORE the sequence runner was deployed.
 *
 * Why this exists
 * ---------------
 * Operator gap 2026-05-27: 12 couples toured at Rixey in the prior
 * two weeks with NO automated follow-up email. The new
 * post-tour-sequence runner is forward-looking — its 14-day scanning
 * window picks up FRESH completed tours, but does not retroactively
 * draft email_1 for past completed tours where the sequence row
 * pre-existed at "all 3 sent" state.
 *
 * This script lets the operator seed sequence rows for a hand-picked
 * list of wedding IDs. For each:
 *   - Resolves the most-recent completed tour for the wedding
 *   - Upserts a post_tour_sequence row with tour_completed_at = NOW
 *     (so email_1 fires on the very next hourly cron tick, NOT 24h
 *     after the actual tour, which would skip steps for tours >7d old)
 *   - Leaves the runner to do the rest (auto-pause if couple already
 *     replied, auto-complete if status is terminal)
 *
 * Usage
 * -----
 *   tsx scripts/replay-post-tour-backlog.ts <venueId> <wedId1> <wedId2> ...
 *
 *   # Or via stdin with one wedding id per line:
 *   cat backlog-weddings.txt | tsx scripts/replay-post-tour-backlog.ts <venueId>
 *
 * The script is idempotent — re-running on a wedding that already has
 * a sequence row updates only if the row is terminal (clears
 * sequence_completed_at so the runner picks it up again). Never
 * over-writes a non-terminal row.
 *
 * Service-role key is read from .env.local (SUPABASE_SERVICE_ROLE_KEY
 * + NEXT_PUBLIC_SUPABASE_URL). Never commits keys.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

interface Args {
  venueId: string
  weddingIds: string[]
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  if (argv.length === 0) {
    console.error(
      'Usage: tsx scripts/replay-post-tour-backlog.ts <venueId> <wedId1> [<wedId2> ...]',
    )
    console.error('Or:    cat ids.txt | tsx scripts/replay-post-tour-backlog.ts <venueId>')
    process.exit(1)
  }
  const venueId = argv[0]
  let weddingIds = argv.slice(1)

  if (weddingIds.length === 0 && !process.stdin.isTTY) {
    const stdinContent = readFileSync(0, 'utf-8')
    weddingIds = stdinContent
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
  }

  if (weddingIds.length === 0) {
    console.error('No wedding IDs provided (args or stdin)')
    process.exit(1)
  }
  return { venueId, weddingIds }
}

async function main(): Promise<void> {
  const { venueId, weddingIds } = parseArgs()

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. ' +
        'Run with `node --env-file=.env.local node_modules/tsx/dist/cli.mjs ...` or ' +
        '`tsx --env-file=.env.local ...` so the keys are loaded.',
    )
    process.exit(1)
  }
  const supabase = createClient(url, key)

  console.log(
    `[replay-post-tour-backlog] venue=${venueId} weddings=${weddingIds.length}`,
  )

  const now = new Date().toISOString()
  let upserted = 0
  let reopened = 0
  let skipped = 0
  let errored = 0

  for (const weddingId of weddingIds) {
    try {
      // Sanity: verify the wedding exists + belongs to the venue.
      const { data: wedding } = await supabase
        .from('weddings')
        .select('id, venue_id, status')
        .eq('id', weddingId)
        .maybeSingle()
      if (!wedding) {
        console.warn(`  - ${weddingId}: wedding not found, skipping`)
        skipped++
        continue
      }
      if (wedding.venue_id !== venueId) {
        console.warn(
          `  - ${weddingId}: belongs to venue ${wedding.venue_id}, not ${venueId}, skipping`,
        )
        skipped++
        continue
      }
      const status = wedding.status as string | null
      if (
        status === 'booked' ||
        status === 'lost' ||
        status === 'cancelled' ||
        status === 'completed'
      ) {
        console.warn(
          `  - ${weddingId}: wedding status is ${status} (terminal), skipping`,
        )
        skipped++
        continue
      }

      // Find the most-recent completed tour for sequence anchoring.
      const { data: tours } = await supabase
        .from('tours')
        .select('id, scheduled_at')
        .eq('wedding_id', weddingId)
        .eq('outcome', 'completed')
        .order('scheduled_at', { ascending: false })
        .limit(1)
      const tour = ((tours ?? []) as Array<{ id: string; scheduled_at: string }>)[0]
      if (!tour) {
        console.warn(
          `  - ${weddingId}: no completed tour found, skipping (tour_outcome_classifier may not have run)`,
        )
        skipped++
        continue
      }

      // Check for an existing sequence row.
      const { data: existing } = await supabase
        .from('post_tour_sequence')
        .select(
          'id, sequence_completed_at, paused_at, email_1_sent_at',
        )
        .eq('wedding_id', weddingId)
        .maybeSingle()

      if (existing) {
        if (
          (existing as { sequence_completed_at: string | null })
            .sequence_completed_at
        ) {
          // Terminal — reopen by clearing completion AND anchoring fresh.
          const { error: updErr } = await supabase
            .from('post_tour_sequence')
            .update({
              tour_completed_at: now,
              tour_id: tour.id,
              email_1_sent_at: null,
              email_2_sent_at: null,
              email_3_sent_at: null,
              email_1_draft_id: null,
              email_2_draft_id: null,
              email_3_draft_id: null,
              paused_at: null,
              paused_reason: null,
              sequence_completed_at: null,
              completed_reason: null,
            })
            .eq('id', (existing as { id: string }).id)
          if (updErr) throw new Error(updErr.message)
          console.log(`  - ${weddingId}: reopened terminal sequence`)
          reopened++
        } else {
          console.log(`  - ${weddingId}: sequence already active, skipping`)
          skipped++
        }
        continue
      }

      // Insert a fresh row with tour_completed_at = NOW so email_1
      // fires on the next hourly cron tick. Using NOW (vs the actual
      // tour scheduled_at) is the right call for backfill — for tours
      // >7d old, anchoring on the real scheduled_at would skip ALL
      // three steps in one tick. The backlog operator wants the
      // sequence to actually run end-to-end on these couples.
      const { error: insErr } = await supabase
        .from('post_tour_sequence')
        .insert({
          wedding_id: weddingId,
          venue_id: venueId,
          tour_id: tour.id,
          tour_completed_at: now,
        })
      if (insErr) throw new Error(insErr.message)
      console.log(`  - ${weddingId}: seeded sequence row (anchored at NOW)`)
      upserted++
    } catch (err) {
      console.error(
        `  - ${weddingId}: ERROR ${err instanceof Error ? err.message : String(err)}`,
      )
      errored++
    }
  }

  console.log('')
  console.log(
    `Done. upserted=${upserted} reopened=${reopened} skipped=${skipped} errored=${errored}`,
  )
  console.log(
    'The next hourly follow_up_sequences cron tick will draft email_1 for each seeded row.',
  )
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
