// Rixey Manor 90-day history backfill.
//
// Does exactly what the "Import 90 days" button on the onboarding Go-Live
// step does, but scripted so we don't have to re-run onboarding on a live
// venue. Classifies, extracts, and scores every inbox message from the
// last 90 days. Skips draft generation so Sage doesn't try to reply to
// year-old emails. Heat events stamp occurred_at with the real email
// date so decay ages correctly instead of collapsing to "today".
//
// Safe to re-run: `processIncomingEmail` dedupes by Gmail messageId and
// by content fingerprint, so messages already ingested on the live cron
// are skipped on replay.
//
// Usage:
//   npx tsx scripts/backfill-rixey-history.ts                 # dry-run plan
//   npx tsx scripts/backfill-rixey-history.ts --apply         # execute
//   npx tsx scripts/backfill-rixey-history.ts --apply --days 180   # custom window
//   npx tsx scripts/backfill-rixey-history.ts --apply --venue <uuid>  # other venue
import { readFileSync } from 'node:fs'
import { fetchNewEmails } from '../src/lib/services/gmail'
import { processIncomingEmail } from '../src/lib/services/email-pipeline'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    })
)
for (const k of Object.keys(env)) {
  if (!process.env[k]) process.env[k] = env[k]
}

const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

const APPLY = process.argv.includes('--apply')
const daysIdx = process.argv.indexOf('--days')
const DAYS = daysIdx >= 0 ? Math.max(1, Math.min(365, Number(process.argv[daysIdx + 1]))) : 90
const venueIdx = process.argv.indexOf('--venue')
const VENUE_ID = venueIdx >= 0 ? process.argv[venueIdx + 1] : RIXEY_VENUE_ID
// fetchNewEmails paginates internally within one call via Gmail's
// pageToken. Looping with a small chunk re-issues the same query each
// time and gets the same first N messages back, so the pageToken
// never advances across the outer loop. Pass one big maxResults and
// let the built-in pagination walk the full window.
const MAX_MESSAGES = 2000

async function main() {
  console.log(
    `Backfill ${APPLY ? 'APPLY' : 'DRY RUN'} — venue=${VENUE_ID.slice(0, 8)}  days=${DAYS}  maxMessages=${MAX_MESSAGES}  parse_only=true`
  )

  console.log(`\nFetching up to ${MAX_MESSAGES} messages from Gmail (${DAYS}d window)…`)
  const fetchStartedAt = Date.now()
  const emails = await fetchNewEmails(VENUE_ID, MAX_MESSAGES, { sinceDays: DAYS })
  const fetchSeconds = Math.round((Date.now() - fetchStartedAt) / 1000)
  console.log(`Gmail returned ${emails.length} messages in ${fetchSeconds}s.`)

  if (!APPLY) {
    console.log('\nRerun with --apply to process them.\n')
    return
  }

  const totals = { processed: 0, inquiries: 0, new_inquiry: 0, reply: 0, client: 0, skipped: 0, ignored: 0, outbound: 0, errors: 0 }
  const startedAt = Date.now()
  let lastLogAt = Date.now()

  for (let i = 0; i < emails.length; i++) {
    const email = emails[i]
    try {
      const result = await processIncomingEmail(
        VENUE_ID,
        {
          messageId: email.messageId,
          threadId: email.threadId,
          from: email.from,
          to: email.to,
          subject: email.subject,
          body: email.body,
          date: email.date,
          labels: email.labels,
          connectionId: email.connectionId,
          headers: email.headers,
        },
        { skipDraft: true }
      )
      totals.processed++
      const c = result.classification
      if (c === 'new_inquiry') { totals.new_inquiry++; totals.inquiries++ }
      else if (c === 'inquiry_reply') { totals.reply++; totals.inquiries++ }
      else if (c === 'client_message') totals.client++
      else if (c === 'skipped') totals.skipped++
      else if (c === 'ignore') {
        if (result.interactionId === null) totals.outbound++
        else totals.ignored++
      }
    } catch (err) {
      totals.errors++
      console.error(`  error on ${email.messageId?.slice(0, 12) ?? '?'}:`, (err as Error).message)
    }

    // Log every 50 emails or every 30s so progress is visible.
    if ((i + 1) % 50 === 0 || Date.now() - lastLogAt > 30_000) {
      const pct = Math.round(((i + 1) / emails.length) * 100)
      console.log(
        `  ${i + 1}/${emails.length} (${pct}%)  new=${totals.new_inquiry} reply=${totals.reply} client=${totals.client} skipped=${totals.skipped} ignored=${totals.ignored} outbound=${totals.outbound} errors=${totals.errors}`
      )
      lastLogAt = Date.now()
    }
  }

  const totalSeconds = Math.round((Date.now() - startedAt) / 1000)
  console.log('\n=== Backfill complete ===')
  console.log(`  fetched:   ${emails.length}`)
  console.log(`  processed: ${totals.processed}`)
  console.log(`    new inquiries: ${totals.new_inquiry}`)
  console.log(`    replies:       ${totals.reply}`)
  console.log(`    client msgs:   ${totals.client}`)
  console.log(`    skipped (dedup): ${totals.skipped}`)
  console.log(`    ignored (filter/universal): ${totals.ignored}`)
  console.log(`    outbound (venue-own):       ${totals.outbound}`)
  console.log(`  errors:    ${totals.errors}`)
  console.log(`  duration:  ${totalSeconds}s`)
}

main().catch((err) => {
  console.error('\nBackfill failed:', err)
  process.exit(1)
})
