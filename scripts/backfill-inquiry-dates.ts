// Backfill weddings.inquiry_date from the earliest inbound interaction's
// timestamp. Pre-2026-04-30 the email-pipeline stamped inquiry_date to
// wall-clock NOW() instead of the email's actual date — see the fix in
// src/lib/services/email-pipeline.ts. On Rixey's 2026-04-24 Gmail
// backfill that collapsed 77 weddings of varying real ages onto a single
// day, breaking cross-platform matching.
//
// Strategy: for each wedding at the venue, compute the earliest
// `interactions.timestamp` where direction='inbound'. If that timestamp
// is meaningfully earlier than the current `inquiry_date` (>2 days
// older), update inquiry_date to it. This is conservative — we don't
// touch weddings whose current date already lines up.
//
// Skips weddings with no inbound interaction (RSVPs, manual creates,
// imported leads). Also skips weddings whose current inquiry_date is
// already <= the earliest inbound (the existing date is fine or already
// older).
//
// Usage:
//   npx tsx scripts/backfill-inquiry-dates.ts --dry-run
//   npx tsx scripts/backfill-inquiry-dates.ts --apply
//   npx tsx scripts/backfill-inquiry-dates.ts --apply --venue <uuid>
import { createClient } from '@supabase/supabase-js'
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

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const venueIdx = args.indexOf('--venue')
const venueId = venueIdx >= 0 ? args[venueIdx + 1] : 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// Drift threshold: only update if the earliest inbound is >2 days
// older than the current inquiry_date. Below this, treat as noise
// (clock skew, slow imports). Above it, almost certainly stale.
const MIN_DRIFT_HOURS = 48

interface Wedding {
  id: string
  inquiry_date: string | null
}

async function main() {
  console.log(`\n=== Backfill inquiry_date — venue ${venueId} ${apply ? '(apply)' : '(dry-run)'} ===\n`)

  const PAGE = 500
  let offset = 0
  let scanned = 0
  let needsUpdate = 0
  let updated = 0
  let noInbound = 0
  let alreadyAccurate = 0
  const samples: Array<{ id: string; was: string; will: string; driftDays: number }> = []

  for (;;) {
    const { data: weddings, error } = await sb
      .from('weddings')
      .select('id, inquiry_date')
      .eq('venue_id', venueId)
      .range(offset, offset + PAGE - 1)
      .order('created_at', { ascending: true })
    if (error) {
      console.error(`fetch weddings @${offset}: ${error.message}`)
      break
    }
    const page = (weddings ?? []) as Wedding[]
    if (page.length === 0) break

    for (const w of page) {
      scanned++

      const { data: firstInbound } = await sb
        .from('interactions')
        .select('timestamp')
        .eq('wedding_id', w.id)
        .eq('direction', 'inbound')
        .not('timestamp', 'is', null)
        .order('timestamp', { ascending: true })
        .limit(1)

      const earliestInboundStr = (firstInbound?.[0] as { timestamp: string } | undefined)?.timestamp
      if (!earliestInboundStr) {
        noInbound++
        continue
      }

      const currentTs = w.inquiry_date ? new Date(w.inquiry_date).getTime() : null
      const earliestTs = new Date(earliestInboundStr).getTime()
      if (isNaN(earliestTs)) {
        noInbound++
        continue
      }

      // Only fix if the earliest inbound is materially earlier than
      // the stored inquiry_date.
      if (currentTs !== null && earliestTs >= currentTs - MIN_DRIFT_HOURS * 3_600_000) {
        alreadyAccurate++
        continue
      }

      const driftHours = currentTs !== null ? (currentTs - earliestTs) / 3_600_000 : Infinity
      needsUpdate++
      if (samples.length < 5) {
        samples.push({
          id: w.id,
          was: w.inquiry_date ?? 'null',
          will: earliestInboundStr,
          driftDays: Math.round((driftHours / 24) * 10) / 10,
        })
      }

      if (apply) {
        const { error: updErr } = await sb
          .from('weddings')
          .update({ inquiry_date: earliestInboundStr })
          .eq('id', w.id)
        if (updErr) {
          console.error(`  update ${w.id}: ${updErr.message}`)
        } else {
          updated++
        }
      }
    }

    if (page.length < PAGE) break
    offset += PAGE
  }

  console.log(`scanned:           ${scanned}`)
  console.log(`no inbound email:  ${noInbound}`)
  console.log(`already accurate:  ${alreadyAccurate}`)
  console.log(`needs update:      ${needsUpdate}`)
  if (apply) console.log(`updated:           ${updated}`)
  if (samples.length > 0) {
    console.log(`\nfirst ${samples.length} drift sample${samples.length === 1 ? '' : 's'}:`)
    for (const s of samples) {
      console.log(`  ${s.id}`)
      console.log(`    was:  ${s.was}`)
      console.log(`    will: ${s.will}  (drift ${s.driftDays}d)`)
    }
  }
  if (!apply && needsUpdate > 0) {
    console.log(`\nDry-run complete. Re-run with --apply to write updates.`)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
