// Fetch historical scheduling-tool emails directly from Gmail and
// process them through the live email-pipeline.
//
// Why this is a separate script from the general 90-day backfill:
//   Calendly / Acuity / HoneyBook / Dubsado confirmations carry Gmail
//   headers (List-Unsubscribe, Auto-Submitted) that the default
//   fetchMessageIdsByList strips via INBOX-only labelIds + inbox-shaped
//   categorisation. On many venue Gmail accounts these land in Updates
//   or are auto-archived by user filters, putting them outside INBOX.
//   The generic backfill never sees them.
//
// This script uses the same fetchNewEmails + processIncomingEmail path
// but with two option overrides:
//   - extraQuery: `from:(calendly.com OR ...)` to target just the tools.
//   - includeAllLabels: true — lift the INBOX-only restriction so
//     archived / Updates-tab emails are returned.
//
// The live email-pipeline already handles scheduling-tool detection
// (scheduling-tool-parsers.ts + the wiring in email-pipeline.ts), so
// each fetched email fires the correct engagement_event + advances
// wedding status on the way through. White-label — works for any venue.
//
// Safe to re-run: Gmail messageId dedup via isEmailProcessed.
//
// Usage:
//   npx tsx scripts/fetch-scheduling-tool-history.ts                 # dry-run
//   npx tsx scripts/fetch-scheduling-tool-history.ts --apply         # execute
//   npx tsx scripts/fetch-scheduling-tool-history.ts --apply --all   # every real venue
//   npx tsx scripts/fetch-scheduling-tool-history.ts --apply --venue <uuid> --days 180
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
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

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const APPLY = process.argv.includes('--apply')
const ALL = process.argv.includes('--all')
const venueIdx = process.argv.indexOf('--venue')
const CLI_VENUE = venueIdx >= 0 ? process.argv[venueIdx + 1] : null
const daysIdx = process.argv.indexOf('--days')
const DAYS = daysIdx >= 0 ? Math.max(1, Math.min(730, Number(process.argv[daysIdx + 1]))) : 90

// Gmail search query targeting scheduling tools. `from:` accepts a
// parenthesised OR list. Newer tools can be added here without touching
// the parser module.
const SCHEDULING_QUERY =
  'from:(calendly.com OR calendlymail.com OR acuityscheduling.com OR honeybook.com OR dubsado.com OR squarespacescheduling.com)'

const MAX_MESSAGES = 2000

async function runVenue(venueId: string) {
  console.log(`\n=== Venue ${venueId.slice(0, 8)} — ${APPLY ? 'APPLY' : 'DRY RUN'} ===`)
  console.log(`  window: last ${DAYS} days   query: ${SCHEDULING_QUERY}`)

  const emails = await fetchNewEmails(venueId, MAX_MESSAGES, {
    sinceDays: DAYS,
    extraQuery: SCHEDULING_QUERY,
    includeAllLabels: true,
  })
  console.log(`  Gmail returned ${emails.length} scheduling-tool messages.`)

  if (!APPLY) {
    // Show a sample so we can eyeball sender domains / subjects
    console.log(`  sample (first 10):`)
    for (const e of emails.slice(0, 10)) {
      console.log(`    ${(e.from ?? '').slice(0, 50).padEnd(50)} "${(e.subject ?? '').slice(0, 70)}"`)
    }
    console.log('  (rerun with --apply to process.)')
    return
  }

  const totals = {
    processed: 0,
    classified: { new_inquiry: 0, inquiry_reply: 0, client_message: 0, ignore: 0, skipped: 0, other: 0 },
    drafts: 0,
    errors: 0,
  }

  for (let idx = 0; idx < emails.length; idx++) {
    const email = emails[idx]
    try {
      const result = await processIncomingEmail(
        venueId,
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
        { skipDraft: true }, // scheduling confirmations never get drafts
      )
      totals.processed++
      const c = result.classification
      const bucket = (c in totals.classified ? c : 'other') as keyof typeof totals.classified
      totals.classified[bucket]++
      if (result.draftId) totals.drafts++
    } catch (err) {
      totals.errors++
      console.error(`  error on ${email.messageId?.slice(0, 12) ?? '?'}:`, (err as Error).message)
    }

    if ((idx + 1) % 25 === 0 || idx + 1 === emails.length) {
      console.log(
        `  progress ${idx + 1}/${emails.length}  classified=${JSON.stringify(totals.classified)}  errors=${totals.errors}`
      )
    }
  }

  console.log(`\n  === Done ===`)
  console.log(`  processed: ${totals.processed}`)
  console.log(`  classified:`, totals.classified)
  console.log(`  errors: ${totals.errors}`)
}

async function main() {
  let venueIds: string[] = [CLI_VENUE ?? RIXEY]
  if (ALL) {
    const { data: vs } = await sb.from('venues').select('id, is_demo').eq('is_demo', false)
    venueIds = (vs ?? []).map((v: any) => v.id)
    console.log(`--all: fetching scheduling-tool history for ${venueIds.length} non-demo venue(s)`)
  }
  for (const vid of venueIds) {
    await runVenue(vid)
  }
}

main().catch((err) => {
  console.error('Failed:', err)
  process.exit(1)
})
