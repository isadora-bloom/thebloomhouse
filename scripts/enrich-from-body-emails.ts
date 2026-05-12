/**
 * scripts/enrich-from-body-emails.ts
 *
 * Backfill enrichment: scan SMS + voicemail + call-transcript interaction
 * bodies for email addresses, parse joint handles ("justinlovewithsandy"
 * -> Justin + Sandy), and stamp the partner names + email onto the
 * linked wedding's people rows where those fields are currently NULL.
 *
 * Why this exists: the original SMS pipeline only used the phone number
 * as identity signal, so wedding rows minted from a first-text-from-an-
 * unknown-number landed as placeholder "phone X, no names, no email."
 * The body of a later SMS often carries the couple's email address —
 * that's a stronger signal than the phone alone. This script catches
 * up the historical placeholder weddings.
 *
 * Forward-going, the body-email match tier in sms-name-match.ts handles
 * fresh syncs. This is a one-shot for existing data.
 *
 * Idempotent: only fills NULL fields. Re-running on an enriched wedding
 * is a no-op. Operator-set values (non-NULL first_name / last_name /
 * email) are NEVER overwritten.
 *
 * Run:
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/enrich-from-body-emails.ts
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/enrich-from-body-emails.ts --dry-run
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/enrich-from-body-emails.ts --venue=<uuid>
 */

import { createClient } from '@supabase/supabase-js'
import {
  inferNameFromEmail,
  parseJointEmailHandle,
} from '../src/lib/services/identity/name-capture'

const LOOKBACK_DAYS = 180
const BODY_EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi

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
const venueArg = args.find((a) => a.startsWith('--venue='))?.slice(8) ?? null
const dryRun = args.includes('--dry-run')

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

interface InteractionRow {
  id: string
  wedding_id: string
  full_body: string | null
  body_preview: string | null
  timestamp: string
}

interface PersonRow {
  id: string
  role: string
  first_name: string | null
  last_name: string | null
  email: string | null
}

function findEmails(text: string): string[] {
  if (!text) return []
  BODY_EMAIL_RE.lastIndex = 0
  const out = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = BODY_EMAIL_RE.exec(text))) out.add(m[0].toLowerCase())
  return [...out]
}

/** Bloom's own automation emails leak into bodies sometimes (footers,
 *  re-quoted replies). Exclude obvious own-domain / venue-domain emails
 *  + RFC-2606 reserved domains + role addresses (info@ / hello@ etc) +
 *  known service domains that aren't couples.
 *
 *  This is the same blocklist the live persistRow path uses through
 *  isUnsendableAddress + parseJointEmailHandle's ROLE_LOCAL_PARTS, but
 *  duplicated here so the backfill applies the same conservatism. */
function shouldConsiderEmail(email: string): boolean {
  if (!email) return false
  if (/\.(invalid|test|example|localhost)$/i.test(email)) return false
  if (/@(example\.com|example\.net|example\.org)$/i.test(email)) return false
  const local = email.split('@')[0]?.toLowerCase() ?? ''
  if (ROLE_LOCAL_PARTS.has(local)) return false
  // Bloom platform emails — skip.
  if (/@(thebloomhouse|rixeymanor|isadoraandco)\.(com|ai|net)$/i.test(email)) return false
  // Known service domains the couple wouldn't be replying from.
  // Expand as needed; this isn't exhaustive.
  const domain = email.split('@')[1]?.toLowerCase() ?? ''
  if (SERVICE_DOMAINS.has(domain)) return false
  return true
}

const ROLE_LOCAL_PARTS = new Set([
  'hello', 'hi', 'info', 'contact', 'support', 'help', 'admin',
  'team', 'office', 'sales', 'marketing', 'noreply', 'no-reply',
  'donotreply', 'do-not-reply', 'mailer-daemon', 'postmaster',
  'bounce', 'bounces', 'unsubscribe', 'press', 'pr', 'media',
  'billing', 'accounts', 'invoices', 'orders', 'service', 'services',
  'inquiries', 'inquiry', 'reservations', 'bookings', 'events',
])

const SERVICE_DOMAINS = new Set([
  'giggster.com', 'eventup.com', 'peerspace.com', 'venuely.com',
  'wedj.com', 'wedsites.com', 'theknot.com', 'weddingwire.com',
  'zola.com', 'herecomestheguide.com', 'calendly.com', 'acuityscheduling.com',
  'honeybook.com', 'dubsado.com', 'aisleplanner.com',
  'mailchimp.com', 'sendgrid.com', 'resend.com',
])

async function enrichVenue(venueId: string): Promise<void> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString()

  // Paginate so a venue with 2k+ historical SMS gets every row scanned,
  // not just the first 1000 (Supabase's default page size). Newest
  // first because recent threads are most likely to be active leads
  // worth enriching first.
  const list: InteractionRow[] = []
  const PAGE = 1000
  let page = 0
  while (true) {
    const { data: chunk } = await sb
      .from('interactions')
      .select('id, wedding_id, full_body, body_preview, timestamp')
      .eq('venue_id', venueId)
      .eq('type', 'sms')
      .not('wedding_id', 'is', null)
      .gte('timestamp', since)
      .order('timestamp', { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE - 1)
    const got = (chunk ?? []) as InteractionRow[]
    list.push(...got)
    if (got.length < PAGE) break
    page++
    if (page > 20) break // safety stop at 20k rows
  }

  // Group by wedding_id, collect every email seen in any body for that wedding.
  const byWedding = new Map<string, Set<string>>()
  for (const r of list) {
    const text = (r.full_body ?? r.body_preview ?? '').trim()
    if (!text) continue
    const emails = findEmails(text).filter(shouldConsiderEmail)
    if (emails.length === 0) continue
    const bucket = byWedding.get(r.wedding_id) ?? new Set<string>()
    for (const e of emails) bucket.add(e)
    byWedding.set(r.wedding_id, bucket)
  }

  console.log(`[${venueId}] scanning ${list.length} SMS rows across ${byWedding.size} wedding(s) with body emails`)

  let weddings = 0
  let updatedPeople = 0
  let createdPartners = 0

  for (const [weddingId, emailSet] of byWedding.entries()) {
    const emails = [...emailSet]
    // For each wedding pick the single best email — prefer the one with
    // a joint handle (lets us seed both partners), then any single-name
    // first.last, then the first email we found.
    let chosen: { email: string; partner1: string | null; partner2: string | null; last: string | null } | null = null
    for (const e of emails) {
      const joint = parseJointEmailHandle(e)
      if (joint) {
        chosen = {
          email: e,
          partner1: joint.partner1_first,
          partner2: joint.partner2_first,
          last: null,
        }
        break
      }
    }
    if (!chosen) {
      for (const e of emails) {
        const single = inferNameFromEmail(e)
        if (single?.first) {
          chosen = {
            email: e,
            partner1: single.first,
            partner2: null,
            last: single.last,
          }
          break
        }
      }
    }
    if (!chosen) {
      // No parsable handle — still stamp the email as partner1.email if
      // empty; coordinator gets a reachable address even without names.
      chosen = { email: emails[0], partner1: null, partner2: null, last: null }
    }

    // Pull existing people for this wedding.
    const { data: people } = await sb
      .from('people')
      .select('id, role, first_name, last_name, email')
      .eq('venue_id', venueId)
      .eq('wedding_id', weddingId)

    const personList = (people ?? []) as PersonRow[]
    const partner1 = personList.find((p) => p.role === 'partner1')
    const partner2 = personList.find((p) => p.role === 'partner2')

    weddings++

    // Build the partner1 update — only fill NULL fields.
    if (partner1) {
      const updates: Record<string, string> = {}
      if (!partner1.email && chosen.email) updates.email = chosen.email
      if (!partner1.first_name && chosen.partner1) updates.first_name = chosen.partner1
      if (!partner1.last_name && chosen.last) updates.last_name = chosen.last
      if (Object.keys(updates).length > 0) {
        console.log(
          `  ✓ wedding ${weddingId} partner1 ← ${JSON.stringify(updates)}`,
        )
        if (!dryRun) {
          const { error } = await sb.from('people').update(updates).eq('id', partner1.id)
          if (!error) updatedPeople++
          else console.warn(`    update failed: ${error.message}`)
        } else {
          updatedPeople++
        }
      }
    } else if (!dryRun && (chosen.email || chosen.partner1)) {
      const { error } = await sb.from('people').insert({
        venue_id: venueId,
        wedding_id: weddingId,
        role: 'partner1',
        first_name: chosen.partner1,
        last_name: chosen.last,
        email: chosen.email,
      })
      if (!error) updatedPeople++
    }

    // Partner2 — only create when joint handle yielded a second name AND
    // no partner2 already exists. Never overwrite.
    if (chosen.partner2 && !partner2) {
      console.log(
        `  ✓ wedding ${weddingId} create partner2 ← ${chosen.partner2}`,
      )
      if (!dryRun) {
        const { error } = await sb.from('people').insert({
          venue_id: venueId,
          wedding_id: weddingId,
          role: 'partner2',
          first_name: chosen.partner2,
        })
        if (!error) createdPartners++
      } else {
        createdPartners++
      }
    }
  }

  console.log(
    `[${venueId}] weddings=${weddings} people_updated=${updatedPeople} partner2_created=${createdPartners}${dryRun ? ' (dry-run)' : ''}`,
  )
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

  console.log(`Enriching ${venueIds.length} venue(s)${dryRun ? ' (DRY RUN)' : ''}`)
  for (const venueId of venueIds) {
    await enrichVenue(venueId)
  }
  console.log('Done.')
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
