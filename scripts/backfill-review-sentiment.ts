/**
 * scripts/backfill-review-sentiment.ts
 * =====================================
 * Backfill reviews.sentiment_score + reviews.themes for rows that predate
 * the W46 scoring wire-up (NOVEMBER-PLAN.md). Every review-insert path now
 * schedules scoreReviewRow() automatically going forward (see
 * src/lib/services/reviews/score.ts); this script catches up the reviews
 * that were inserted before that existed.
 *
 * WHAT THIS SCRIPT DOES
 * ----------------------
 * For each review row where sentiment_score IS NULL and body is non-blank:
 *   1. Call scoreReviewRow() — extracts phrases (src/lib/services/intel/
 *      review-language.ts), aggregates them into a mean sentiment_score +
 *      distinct themes list, and writes both onto the row.
 *   2. A 500ms delay between AI calls (matches batchExtractReviews'
 *      existing pacing) to stay under rate limits.
 *
 * RESUMABLE BY CONSTRUCTION
 * --------------------------
 * The selection query is always `sentiment_score IS NULL`, so a row this
 * run already scored is excluded from the next run automatically — no
 * separate checkpoint file needed. Interrupt any time; re-run to continue.
 * A review that genuinely has nothing notable to extract (extractReviewLanguage
 * returns []) is left null and will be retried on the next run too — that
 * is a deliberate no-op, not a failure, so it is not worth a "tried and
 * gave up" marker.
 *
 * SAFETY
 * ------
 * - Dry-run by default. `--apply` writes.
 * - `--allow-prod` REQUIRED if the target URL is the prod ref
 *   (jsxxgwprxuqgcauzlxcb) AND `--apply` is set.
 * - `--venue <id>` restricts to one venue; omit to run across all venues.
 * - Batched: fetches BATCH_SIZE rows at a time and stops after
 *   `--limit` rows have been scored (default unlimited), so a long
 *   backfill can be run in controlled chunks.
 *
 * USAGE
 * -----
 *   # Dry-run report, one venue:
 *   npx tsx scripts/backfill-review-sentiment.ts --venue <uuid>
 *
 *   # Dry-run, every venue:
 *   npx tsx scripts/backfill-review-sentiment.ts
 *
 *   # Apply, capped at 50 reviews this run:
 *   npx tsx scripts/backfill-review-sentiment.ts --venue <uuid> --apply --allow-prod --limit 50
 *
 * This script is written for review, NOT for me to run — W46 instructions
 * say no database writes from this worktree. An operator runs --apply.
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync, existsSync } from 'node:fs'
import { scoreReviewRow } from '../src/lib/services/reviews/score'

// ---------------------------------------------------------------------------
// Env loader
// ---------------------------------------------------------------------------

if (existsSync('.env.local')) {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=')
        return [
          l.slice(0, i).trim(),
          l.slice(i + 1).trim().replace(/^['"]|['"]$/g, ''),
        ]
      }),
  )
  for (const k of Object.keys(env)) {
    if (!process.env[k]) process.env[k] = env[k] as string
  }
}

const SUPABASE_URL = process.env.BRANCH_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.BRANCH_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!
const PROD_REF = 'jsxxgwprxuqgcauzlxcb'

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_KEY')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes('--apply')
const ALLOW_PROD = process.argv.includes('--allow-prod')

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag)
  if (idx < 0 || idx + 1 >= process.argv.length) return null
  return process.argv[idx + 1]
}

const VENUE_ID = argValue('--venue')
const LIMIT = argValue('--limit') ? Math.max(1, Number(argValue('--limit'))) : Infinity
const BATCH_SIZE = 100
const DELAY_MS = 500

if (APPLY && SUPABASE_URL.includes(PROD_REF) && !ALLOW_PROD) {
  console.error(
    `Refusing to --apply against prod (${PROD_REF}). Re-run with --allow-prod to confirm.`,
  )
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
})

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReviewRow {
  id: string
  venue_id: string
  body: string | null
  rating: number | null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Review sentiment backfill (W46) ===')
  console.log(`  URL:    ${SUPABASE_URL}`)
  console.log(`  Venue:  ${VENUE_ID ?? '(all)'}`)
  console.log(`  Limit:  ${LIMIT === Infinity ? '(none)' : LIMIT}`)
  console.log(`  Mode:   ${APPLY ? 'APPLY' : 'dry-run'}`)
  console.log('')

  let scored = 0
  let skippedEmptyExtraction = 0
  let failed = 0
  let fetched = 0
  // Keyset pagination on id, NOT offset. A scored row leaves the
  // `sentiment_score IS NULL` filter as soon as it is written, so an
  // offset-based .range() would shift under us mid-run and silently
  // skip rows (dry-run doesn't mutate anything so this only bites in
  // --apply). `id > lastId` visits every id exactly once regardless of
  // how the filtered set shrinks underneath the scan.
  let lastId = ''

  for (;;) {
    if (scored >= LIMIT) break

    let q = sb
      .from('reviews')
      .select('id, venue_id, body, rating')
      .is('sentiment_score', null)
      .not('body', 'is', null)
      .gt('id', lastId)
      .order('id', { ascending: true })
      .limit(BATCH_SIZE)
    if (VENUE_ID) q = q.eq('venue_id', VENUE_ID)

    const { data, error } = await q
    if (error) {
      console.error(`fetch reviews after id=${lastId || '(start)'}:`, error.message)
      process.exit(1)
    }
    const fetchedIds = (data ?? []) as ReviewRow[]
    if (fetchedIds.length === 0) break
    // Whitespace-only body slips past the SQL `not null` filter; drop it
    // here rather than treating "nothing left to score" as "scan over" —
    // the keyset still needs to advance past this batch either way (see
    // below).
    const rows = fetchedIds.filter((r) => r.body && r.body.trim().length > 0)
    fetched += rows.length

    for (const row of rows) {
      if (scored >= LIMIT) break

      if (!APPLY) {
        console.log(
          `  [dry-run] would score ${row.id.slice(0, 8)} venue=${row.venue_id.slice(0, 8)} ` +
            `body="${(row.body ?? '').slice(0, 60).replace(/\n/g, ' ')}${(row.body ?? '').length > 60 ? '…' : ''}"`,
        )
        scored++
        continue
      }

      try {
        const result = await scoreReviewRow({
          reviewId: row.id,
          venueId: row.venue_id,
          body: row.body ?? '',
          rating: row.rating,
          supabase: sb,
        })
        if (result.scored) {
          console.log(
            `  ${row.id.slice(0, 8)} venue=${row.venue_id.slice(0, 8)} sentiment=${result.sentimentScore} themes=[${result.themes.join(',')}]`,
          )
          scored++
        } else {
          console.log(`  ${row.id.slice(0, 8)} — extraction found nothing notable, left null`)
          skippedEmptyExtraction++
        }
      } catch (err) {
        failed++
        console.warn(`  ${row.id.slice(0, 8)} FAILED:`, (err as Error).message)
      }

      // Pace AI calls — matches batchExtractReviews' existing convention.
      await sleep(DELAY_MS)
    }

    // Advance the keyset past every id this batch fetched (fetchedIds,
    // not the whitespace-filtered `rows`) — this moves the scan forward
    // through skipped-as-empty-body rows too, so one run terminates
    // instead of looping on the same batch forever.
    lastId = fetchedIds[fetchedIds.length - 1].id
    if (fetchedIds.length < BATCH_SIZE) break
  }

  console.log('')
  console.log('Done.')
  console.log(`  reviews checked:            ${fetched}`)
  console.log(`  scored:                     ${scored}${APPLY ? '' : ' (dry run — nothing written)'}`)
  console.log(`  left null (no phrases):     ${skippedEmptyExtraction}`)
  console.log(`  failed:                     ${failed}`)
  if (!APPLY) {
    console.log('')
    console.log('Rerun with --apply (and --allow-prod against prod) to write.')
  }
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
