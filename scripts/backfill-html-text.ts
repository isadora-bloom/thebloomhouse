// T5-Rixey-EEE Bug 2 — backfill historical HTML in interactions.
//
// Stream RR fixed gmail.ts:parseEmailBody to strip HTML at WRITE time,
// and brain-dump-imports / crm-import already route their `notes` /
// `body` writes through htmlToText. But:
//
//   - rows from MM bulk import that pre-date Stream RR
//   - rows from WW re-import that pre-date Stream RR
//   - any row inserted before the writer-side fix landed
//
// ...still hold raw HTML in interactions.full_body / body_preview.
// The Lead Journey renderer (src/lib/services/wedding-journey.ts)
// shows whatever's in body_preview. Maddie & Brian's lead surfaced
// "<!DOCTYPE html PUBLIC ..." in the timeline because the Calendly
// notification email was imported before the strip-at-writer fix.
//
// This script is layer 1 of the three-layer fix:
//   Layer 1 — backfill data at rest (this script).
//   Layer 2 — display-time htmlToText() on every body_preview render
//             (wedding-journey.ts + intel/clients lead-detail page +
//             agent/drafts page).
//   Layer 3 — CI guard scripts/check-html-stripped-at-writer.mjs
//             prevents future writers from skipping htmlToText().
//
// Idempotent: htmlToText() is a no-op for already-plain text. We
// detect HTML via looksLikeHtml (cheap pre-filter from the same
// utility) and only write rows that actually change. The script
// reports counts: scanned / skipped (already plain) / updated.
//
// Multi-venue safe: filter by --venue <uuid> for a per-venue run, or
// omit for a full sweep. Default is dry-run; pass --apply to write.
//
// Usage:
//   npx tsx scripts/backfill-html-text.ts                         # dry-run, all venues
//   npx tsx scripts/backfill-html-text.ts --apply                 # write, all venues
//   npx tsx scripts/backfill-html-text.ts --venue <uuid>          # dry-run, one venue
//   npx tsx scripts/backfill-html-text.ts --venue <uuid> --apply  # write, one venue
//
// Per the EEE plan (Caveats): "run on STAGING via tsx script;
// report counts; don't auto-apply to production data (let parent
// decide)." Default-dry-run + explicit --apply is the gate.

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { htmlToText, looksLikeHtml } from '../src/lib/utils/html-text'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    }),
)

const SUPA_URL = env.NEXT_PUBLIC_SUPABASE_URL
const SUPA_KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPA_URL || !SUPA_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const sb = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } })

const APPLY = process.argv.includes('--apply')
const VENUE = argValue('--venue')
const PAGE_SIZE = 500
const BODY_PREVIEW_MAX = 200

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : null
}

interface InteractionRow {
  id: string
  venue_id: string
  full_body: string | null
  body_preview: string | null
}

interface Counters {
  scanned: number
  skipped_plain: number
  skipped_empty: number
  updated: number
  errors: number
}

async function main() {
  console.log(`HTML backfill — mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`)
  if (VENUE) console.log(`venue: ${VENUE}`)
  console.log()

  const counters: Counters = {
    scanned: 0,
    skipped_plain: 0,
    skipped_empty: 0,
    updated: 0,
    errors: 0,
  }

  // Page through interactions. Filter on full_body NOT NULL so we skip
  // empty-body rows entirely (note rows / call rows often have empty
  // full_body; nothing to clean).
  let lastId: string | null = null
  while (true) {
    let q = sb
      .from('interactions')
      .select('id, venue_id, full_body, body_preview')
      .not('full_body', 'is', null)
      .order('id', { ascending: true })
      .limit(PAGE_SIZE)
    if (VENUE) q = q.eq('venue_id', VENUE)
    if (lastId) q = q.gt('id', lastId)

    const { data, error } = await q
    if (error) {
      console.error(`page load failed at lastId=${lastId}: ${error.message}`)
      counters.errors += 1
      break
    }
    if (!data || data.length === 0) break

    for (const row of data as InteractionRow[]) {
      counters.scanned += 1
      lastId = row.id

      const fb = row.full_body
      if (!fb || fb.length === 0) {
        counters.skipped_empty += 1
        continue
      }
      // Cheap pre-filter — skip rows that don't look like HTML at all.
      // htmlToText is also a no-op on plain text but the looksLikeHtml
      // check saves a regex pipeline run on the common case.
      if (!looksLikeHtml(fb)) {
        counters.skipped_plain += 1
        continue
      }

      const cleanFb = htmlToText(fb)
      const cleanPv = cleanFb.slice(0, BODY_PREVIEW_MAX)

      // Defensive: if htmlToText returned the same thing (which can
      // happen if looksLikeHtml false-positives on a literal "<3" or
      // similar), skip the write.
      if (cleanFb === fb && cleanPv === row.body_preview) {
        counters.skipped_plain += 1
        continue
      }

      if (!APPLY) {
        counters.updated += 1
        if (counters.updated <= 5) {
          console.log(
            `  would update id=${row.id} venue=${row.venue_id} ` +
            `before(${fb.length}b)="${fb.slice(0, 60).replace(/\n/g, ' ')}…" ` +
            `after(${cleanFb.length}b)="${cleanFb.slice(0, 60).replace(/\n/g, ' ')}…"`,
          )
        }
        continue
      }

      const { error: updErr } = await sb
        .from('interactions')
        .update({
          full_body: cleanFb,
          body_preview: cleanPv,
        })
        .eq('id', row.id)
      if (updErr) {
        console.error(`update failed id=${row.id}: ${updErr.message}`)
        counters.errors += 1
        continue
      }
      counters.updated += 1
      if (counters.updated % 50 === 0) {
        console.log(`  …updated ${counters.updated} so far`)
      }
    }

    if (data.length < PAGE_SIZE) break
  }

  console.log()
  console.log('Counts:')
  console.log(`  scanned       : ${counters.scanned}`)
  console.log(`  skipped_empty : ${counters.skipped_empty}`)
  console.log(`  skipped_plain : ${counters.skipped_plain}`)
  console.log(`  updated       : ${counters.updated}${APPLY ? '' : ' (dry-run — no writes)'}`)
  console.log(`  errors        : ${counters.errors}`)

  if (!APPLY && counters.updated > 0) {
    console.log()
    console.log('Re-run with --apply to write the changes.')
  }
}

main().catch((err) => {
  console.error('FATAL', err)
  process.exit(1)
})
