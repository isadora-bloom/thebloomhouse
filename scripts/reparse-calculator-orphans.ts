// Re-parse calculator-shaped orphan interactions and rewire them
// to the real prospect.
//
// 2026-04-30: Ryan Schubert's calculator estimate (Apr 15, $14,663,
// twisters42@gmail.com in body) was stored with person_id pointing
// at a self-person row "Rixey Manor / hello@rixeymanor.com" because
// the parseVenueCalculator parser didn't fire when this interaction
// was first ingested. The interaction has wedding_id=null because
// the venue-self person has no wedding. Coordinator's lead-detail
// view never sees the calculator submission for the actual prospect.
//
// This script:
//   1. Finds interactions where the body matches the calculator
//      shape AND wedding_id is null (or person points at a venue-
//      own email)
//   2. Extracts the prospect's email from the body
//   3. Finds (or skips) the matching person + wedding
//   4. Rewires interaction.person_id + interaction.wedding_id
//
// Idempotent. Conservative: only rewires when an unambiguous
// person+wedding match exists in the venue.
//
// Usage:
//   npx tsx scripts/reparse-calculator-orphans.ts --venue <uuid>
//   npx tsx scripts/reparse-calculator-orphans.ts --venue <uuid> --apply
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

const EMAIL_RE = /[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g

// Calculator-shape detection (mirrors looksLikeCalculator in
// form-relay-parsers.ts but without the import — keeps the script
// self-contained).
const CALC_SUBJECT_KEYWORDS = ['estimate', 'your quote', 'pricing summary', 'inquiry summary', 'calculator']
const CALC_BODY_KEYWORDS = ['estimated total', "here's a summary of what you put together", 'retainer on booking', 'new calculator submission']

function looksLikeCalculator(subject: string, body: string): boolean {
  const s = (subject || '').toLowerCase()
  const b = (body || '').toLowerCase()
  if (CALC_SUBJECT_KEYWORDS.some((k) => s.includes(k))) return true
  if (CALC_BODY_KEYWORDS.some((k) => b.includes(k))) return true
  if (/your [a-z][a-z0-9' &-]{2,40} estimate/i.test(body)) return true
  const hasSeason = /\bseason\b/i.test(body)
  const hasGuests = /\bguests?\b/i.test(body)
  const hasTotal = /\$\s?\d[\d,]{2,}/.test(body)
  return hasSeason && hasGuests && hasTotal
}

interface Orphan {
  id: string
  person_id: string | null
  wedding_id: string | null
  subject: string | null
  full_body: string | null
  body_preview: string | null
}

async function main() {
  console.log(`\n=== Re-parse calculator orphans — venue ${venueId} ${apply ? '(apply)' : '(dry-run)'} ===\n`)

  // Build the venue-own email set so we can skip those when looking
  // for the prospect's email in the body.
  const ownEmails = new Set<string>()
  const { data: conns } = await sb.from('gmail_connections').select('email_address').eq('venue_id', venueId)
  for (const c of (conns ?? []) as Array<{ email_address: string }>) {
    if (c.email_address) ownEmails.add(c.email_address.toLowerCase().trim())
  }
  // Common venue aliases that may not be in connections.
  const { data: outRows } = await sb
    .from('interactions')
    .select('from_email')
    .eq('venue_id', venueId)
    .eq('direction', 'outbound')
    .not('from_email', 'is', null)
    .limit(1000)
  for (const r of (outRows ?? []) as Array<{ from_email: string | null }>) {
    if (r.from_email) ownEmails.add(r.from_email.toLowerCase().trim())
  }
  console.log(`venue-own email set: ${ownEmails.size}`)

  let scanned = 0
  let calcShape = 0
  let rewired = 0
  let unmatched = 0
  const samples: string[] = []

  const PAGE = 500
  let offset = 0
  for (;;) {
    const { data, error } = await sb
      .from('interactions')
      .select('id, person_id, wedding_id, subject, full_body, body_preview')
      .eq('venue_id', venueId)
      .is('wedding_id', null)
      .range(offset, offset + PAGE - 1)
      .order('timestamp', { ascending: true })
    if (error) { console.error(error.message); break }
    const rows = (data ?? []) as Orphan[]
    if (rows.length === 0) break

    for (const r of rows) {
      scanned++
      const body = r.full_body ?? r.body_preview ?? ''
      if (!looksLikeCalculator(r.subject ?? '', body)) continue
      calcShape++

      // Find the prospect's email in the body — first non-venue-own email.
      const candidates = (body.match(EMAIL_RE) ?? [])
        .map((e) => e.toLowerCase())
        .filter((e) => !ownEmails.has(e))
      if (candidates.length === 0) {
        unmatched++
        continue
      }
      const prospectEmail = candidates[0]

      // Find the wedding-side person matching this email at this venue.
      const { data: matchPerson } = await sb
        .from('people')
        .select('id, wedding_id, venue_id')
        .ilike('email', prospectEmail)
        .eq('venue_id', venueId)
        .not('wedding_id', 'is', null)
        .limit(1)
      const person = (matchPerson?.[0] as { id: string; wedding_id: string } | undefined)
      if (!person) {
        unmatched++
        continue
      }

      rewired++
      if (samples.length < 8) {
        samples.push(`  ${r.id.slice(0, 8)}…  "${(r.subject ?? '').slice(0, 50)}"  → ${prospectEmail} (person ${person.id.slice(0, 8)}…, wedding ${person.wedding_id.slice(0, 8)}…)`)
      }
      if (apply) {
        const { error: updErr } = await sb
          .from('interactions')
          .update({ person_id: person.id, wedding_id: person.wedding_id })
          .eq('id', r.id)
        if (updErr) console.error(`  ${r.id}: ${updErr.message}`)
      }
    }

    if (rows.length < PAGE) break
    offset += PAGE
  }

  console.log(`scanned:           ${scanned}`)
  console.log(`calculator shape:  ${calcShape}`)
  console.log(`rewired:           ${rewired}`)
  console.log(`unmatched:         ${unmatched}  (no person row in venue with that email)`)
  if (samples.length > 0) {
    console.log(`\nfirst ${samples.length} rewires:`)
    for (const s of samples) console.log(s)
  }
  if (!apply && rewired > 0) console.log(`\nDry-run complete. Re-run with --apply to write.`)
}

main().catch((err) => { console.error(err); process.exit(1) })
