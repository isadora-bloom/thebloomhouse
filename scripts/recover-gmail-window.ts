// One-shot recovery for the Gmail-pagination bug that bit Rixey
// 2026-04-30. The history.list path used to fetch only the first
// page then advance the checkpoint to profile.historyId, silently
// dropping pages 2+. Around April 28 → 30, ~48 hours of inbound
// email never reached interactions.
//
// This script ignores the history checkpoint and uses the list path
// (forced by sinceDays > 0) to pull every message from the last N
// days, then runs each through the normal pipeline. processIncomingEmail
// dedupes by gmail_message_id, so messages we already have are no-ops.
//
// Usage:
//   npx tsx scripts/recover-gmail-window.ts --venue <uuid> --days 4
//
// Default --days is 4 (covers the entire bug window with margin).
import { readFileSync } from 'node:fs'

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

const args = process.argv.slice(2)
const venueIdx = args.indexOf('--venue')
const daysIdx = args.indexOf('--days')
const venueId = venueIdx >= 0 ? args[venueIdx + 1] : process.env.RIXEY_VENUE_ID || 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const days = daysIdx >= 0 ? parseInt(args[daysIdx + 1], 10) : 4

async function main() {
  console.log(`\n=== Gmail recovery for venue ${venueId} (last ${days} days) ===\n`)

  const { fetchNewEmails } = await import('../src/lib/services/gmail')
  const { processIncomingEmail } = await import('../src/lib/services/email-pipeline')

  const emails = await fetchNewEmails(venueId, 500, { sinceDays: days })
  console.log(`fetched ${emails.length} messages from Gmail`)

  let processed = 0
  let skipped = 0
  let errors = 0
  for (const email of emails) {
    try {
      const result = await processIncomingEmail(venueId, {
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
      })
      if (result.classification === 'skipped' || result.classification === 'ignore') {
        skipped++
      } else {
        processed++
      }
    } catch (err) {
      errors++
      console.error('  process error:', err instanceof Error ? err.message : err)
    }
  }

  console.log(`\n=== summary ===`)
  console.log(`  processed: ${processed}`)
  console.log(`  skipped/ignored: ${skipped}`)
  console.log(`  errors: ${errors}`)
  console.log(`\nDedup is by gmail_message_id — re-running this is safe.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
