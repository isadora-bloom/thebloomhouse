/**
 * Reprocess orphan inbound Knot interactions (no wedding_id) that were
 * ingested by the July 3 backfill but never minted weddings.
 *
 * Root cause: pipeline.ts subZeroIdentifier treated ALL relay addresses as
 * non-mintable. Per-prospect Knot relays (firstname.last.NNNNN@member.theknot.com)
 * are routable — isUnsendableAddress confirmed this, and the pipeline.ts fix
 * now allows them to mint going forward. This script mints weddings for the
 * existing backlog.
 *
 * Usage:
 *   node scripts/reprocess-knot-orphans.mjs          # dry run
 *   node scripts/reprocess-knot-orphans.mjs --apply  # write
 */

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

const DRY_RUN = !process.argv.includes('--apply')
const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => {
      const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    })
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

/** Per-prospect Knot relay (routable): firstname.last.NNNNN@member.theknot.com */
function isPerProspectRelay(email) {
  if (!email) return false
  const e = email.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9._-]*\.[a-z0-9._-]+@member\.theknot\.com$/i.test(e)
}

/** Knot .reminder variant (NOT routable — these are Knot's own reminders to the vendor) */
function isReminderRelay(email) {
  return /\.reminder@member\.theknot\.com$/i.test(email?.toLowerCase() ?? '')
}

/**
 * Strip the .reminder suffix and return the canonical per-prospect relay.
 * charity.moser.772357.reminder@member.theknot.com → charity.moser.772357@member.theknot.com
 */
function canonicalRelay(email) {
  return email.replace(/\.reminder(@member\.theknot\.com)$/i, '$1')
}

/**
 * Derive a best-effort display name from the relay local part.
 * Strips:
 *   - trailing numeric segment (sequence counter, e.g. ".3" from "ryan.mccarthy.14")
 *   - trailing venue ID (772357)
 *   - underscore-prefixed/suffixed chars (pratibha_ → pratibha)
 * Then title-cases each part.
 */
function nameFromRelay(email) {
  const local = email.split('@')[0]
  const parts = local.split('.').map(p => p.replace(/[_]/g, ''))
  // Drop the venue ID (pure digits, typically 6)
  const withoutVenueId = parts.filter(p => !/^\d+$/.test(p) || p.length < 5)
  // Drop trailing pure-number parts (sequence counters like .1, .3, .14)
  while (withoutVenueId.length > 2 && /^\d+$/.test(withoutVenueId[withoutVenueId.length - 1])) {
    withoutVenueId.pop()
  }
  return withoutVenueId
    .filter(p => p.length > 0)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ')
}

// Fetch orphan inbound Knot new_inquiry interactions
const { data: orphans, error: fetchErr } = await sb
  .from('interactions')
  .select('id, from_email, from_name, subject, timestamp, extracted_identity, intent_class')
  .eq('venue_id', RIXEY)
  .ilike('from_email', '%@member.theknot.com')
  .is('wedding_id', null)
  .eq('direction', 'inbound')
  .eq('intent_class', 'new_inquiry')
  .gte('timestamp', '2026-01-01')
  .order('timestamp')

if (fetchErr) { console.error('Fetch failed:', fetchErr); process.exit(1) }

console.log(`Found ${orphans?.length ?? 0} orphan Knot new_inquiry interactions`)
console.log(DRY_RUN ? '=== DRY run — pass --apply to write ===' : '=== WRITING ===')
console.log()

const reminders = orphans?.filter(r => isReminderRelay(r.from_email)) ?? []
const regular = orphans?.filter(r => !isReminderRelay(r.from_email)) ?? []
console.log(`  Regular (routable) relays: ${regular.length}`)
console.log(`  .reminder relays (non-routable, link-only): ${reminders.length}`)
console.log()

let minted = 0, linked = 0, skipped = 0, failed = 0

// Process regular per-prospect relays first
for (const row of regular) {
  const fromEmail = row.from_email
  if (!isPerProspectRelay(fromEmail)) {
    console.log(`SKIP  ${fromEmail} — not a per-prospect relay`)
    skipped++
    continue
  }

  // Always use relay-derived name — from_name can be corrupted (Knot's "You" prefix etc.)
  const displayName = nameFromRelay(fromEmail)
  const [firstName, ...lastParts] = displayName.split(' ')
  const lastName = lastParts.join(' ') || null
  const inquiryDate = row.timestamp
  const extracted = row.extracted_identity ?? {}
  const weddingDate = extracted.wedding_date ?? null

  console.log(`${DRY_RUN ? 'WOULD MINT' : 'MINTING'}  "${displayName}"  ${fromEmail}`)

  if (DRY_RUN) { minted++; continue }

  try {
    // Find existing person by this relay email
    const { data: existingPerson } = await sb
      .from('people')
      .select('id, wedding_id')
      .eq('venue_id', RIXEY)
      .ilike('email', fromEmail)
      .maybeSingle()

    let personId = existingPerson?.id
    let weddingId = existingPerson?.wedding_id ?? null

    if (weddingId) {
      // Already has a wedding — just link the interaction
      const { error: le } = await sb.from('interactions').update({ wedding_id: weddingId }).eq('id', row.id)
      if (le) { console.error(`  link error: ${le.message}`); failed++ }
      else { console.log(`  → existing wedding ${weddingId.slice(0,8)}`); linked++ }
      continue
    }

    // Mint a wedding
    const weddingId2 = randomUUID()
    const { error: we } = await sb.from('weddings').insert({
      id: weddingId2,
      venue_id: RIXEY,
      status: 'inquiry',
      inquiry_date: inquiryDate,
      lead_source: 'the_knot',
      source: 'the_knot',
      source_provenance: 'identity_resolver',
      ...(weddingDate ? { wedding_date: weddingDate } : {}),
    })
    if (we) { console.error(`  wedding insert failed: ${we.message}`); failed++; continue }

    // Create or update person row
    if (personId) {
      await sb.from('people').update({ wedding_id: weddingId2 }).eq('id', personId)
    } else {
      const { data: np } = await sb.from('people').insert({
        venue_id: RIXEY,
        wedding_id: weddingId2,
        email: fromEmail,
        first_name: firstName || null,
        last_name: lastName,
        role: 'primary',
      }).select('id').maybeSingle()
      personId = np?.id
    }

    // Link the interaction
    const { error: le } = await sb.from('interactions').update({ wedding_id: weddingId2 }).eq('id', row.id)
    if (le) console.error(`  link interaction error: ${le.message}`)
    console.log(`  → new wedding ${weddingId2.slice(0,8)}`)
    minted++
  } catch (err) {
    console.error(`  FAILED: ${err.message}`)
    failed++
  }
}

// Process .reminder variants — find the canonical relay's wedding and link
console.log()
console.log('--- Processing .reminder interactions ---')
for (const row of reminders) {
  const canonical = canonicalRelay(row.from_email)
  const displayName = nameFromRelay(canonical)
  console.log(`${DRY_RUN ? 'WOULD LINK' : 'LINKING'}  "${displayName}"  ${row.from_email} → ${canonical}`)

  if (DRY_RUN) { linked++; continue }

  // Find wedding via canonical relay email
  const { data: person } = await sb
    .from('people')
    .select('wedding_id')
    .eq('venue_id', RIXEY)
    .ilike('email', canonical)
    .maybeSingle()

  if (!person?.wedding_id) {
    console.log(`  no wedding found for canonical relay — skipping`)
    skipped++
    continue
  }

  const { error: le } = await sb.from('interactions').update({ wedding_id: person.wedding_id }).eq('id', row.id)
  if (le) { console.error(`  link error: ${le.message}`); failed++ }
  else { console.log(`  → linked to wedding ${person.wedding_id.slice(0,8)}`); linked++ }
}

console.log()
console.log('=== RESULTS ===')
console.log(`  Minted:  ${minted}`)
console.log(`  Linked:  ${linked}  (used existing wedding or linked reminder)`)
console.log(`  Skipped: ${skipped}`)
console.log(`  Failed:  ${failed}`)
if (DRY_RUN) console.log('\nRe-run with --apply to write.')
