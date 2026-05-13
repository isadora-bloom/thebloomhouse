#!/usr/bin/env node
/**
 * Retro re-import of the Rixey Calendly CSV using the new crm_import_rows
 * ledger (migration 335). This is a one-shot remediation, not a generic
 * importer — the proper general-case wire (which lets commitNormalisedRows
 * skip 'unchanged' rows on weekly re-uploads) is deferred to a follow-up.
 *
 * What this script does, per CSV row:
 *
 *   1. Parse the row (subset of tour-scheduler's logic, kept in-script
 *      so we can run without TS toolchain). Picks out:
 *        event_uuid, invitee email/first/last, start, created.
 *
 *   2. Find the existing interaction at Rixey by event_uuid (substring
 *      match in interactions.full_body). All pre-Pass-H Calendly synth
 *      bodies stamped `event_uuid:<UUID>`, so this is reliable.
 *
 *   3. If found:
 *        a. UPDATE interactions.full_body — patch in `partner1_name:` and
 *           `partner1_email:` lines (Pass H shape).
 *        b. UPDATE interactions.extracted_identity — stamp
 *           partner1_first_name / partner1_last_name / partner1_email.
 *        c. If the wedding's partner1 people row has first_name in
 *           (NULL, '', '(Unknown)') AND we have an invitee name from
 *           the CSV: UPDATE first_name + last_name + email and append
 *           a name_evidence entry sourced from the CSV.
 *        d. UPSERT a crm_import_rows entry — fingerprint = event_uuid
 *           hash, resolution='attached_strong', resolved_wedding_id =
 *           the interaction's wedding_id.
 *
 *   4. If not found: write a `to_import` line to stdout. Do NOT mint a
 *      new wedding — that's not the retro fix's job. The follow-up
 *      session will handle fresh rows via the proper general-case wire.
 *
 * Idempotency: re-running this script is a no-op for rows that have
 * already been patched (the body lines are present, the people row
 * already has a name). The crm_import_rows fingerprint also short-
 * circuits in classifyImportRow's 'unchanged' branch.
 *
 * Usage:
 *   node --import tsx scripts/reimport-calendly-rixey.mjs <csv-path>
 *   node --import tsx scripts/reimport-calendly-rixey.mjs <csv-path> --dry-run
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const env = {}
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (!m) continue
  let v = m[2]
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
  env[m[1]] = v
}
for (const [k, v] of Object.entries(env)) {
  if (process.env[k] === undefined) process.env[k] = v
}

const { createClient } = await import('@supabase/supabase-js')
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

const csvPath = process.argv[2]
const dryRun = process.argv.includes('--dry-run')
if (!csvPath) {
  console.error('usage: node --import tsx scripts/reimport-calendly-rixey.mjs <csv-path> [--dry-run]')
  process.exit(1)
}

// --- CSV parser (RFC 4180-ish, double-quote escaping) ---
function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ }
        else { inQuotes = false }
      } else {
        cell += c
      }
    } else {
      if (c === '"') inQuotes = true
      else if (c === ',') { row.push(cell); cell = '' }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
      else if (c === '\r') { /* skip */ }
      else cell += c
    }
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row) }
  return rows
}

const raw = readFileSync(csvPath, 'utf8')
const csvRows = parseCsv(raw)
if (csvRows.length < 2) { console.error('CSV is empty or header-only'); process.exit(1) }
const headers = csvRows[0]
const colIdx = (name) => headers.findIndex((h) => h.trim().toLowerCase() === name.trim().toLowerCase())

const ix = {
  eventUuid: colIdx('Event UUID'),
  eventTypeName: colIdx('Event Type Name'),
  inviteeFirst: colIdx('Invitee First Name'),
  inviteeLast: colIdx('Invitee Last Name'),
  inviteeEmail: colIdx('Invitee Email'),
  startTime: colIdx('Start Date & Time'),
  createdTime: colIdx('Event Created Date & Time'),
}
console.log('Column index map:')
for (const [k, v] of Object.entries(ix)) console.log(`  ${k}: ${v}`)
if (ix.eventUuid < 0) { console.error('Missing required column Event UUID'); process.exit(1) }

console.log(`\nDryRun: ${dryRun}`)
console.log(`Parsed rows: ${csvRows.length - 1}`)

// --- Process each row ---
const counts = {
  total: 0,
  matched_existing_interaction: 0,
  body_patched: 0,
  body_already_patched: 0,
  people_row_patched: 0,
  people_row_already_named: 0,
  no_invitee_name: 0,
  no_existing_interaction: 0,
  crm_import_rows_inserted: 0,
  crm_import_rows_existed: 0,
  errors: 0,
}
const noMatchSample = []
const errorSample = []

function sha256(s) { return createHash('sha256').update(s).digest('hex') }

for (let r = 1; r < csvRows.length; r++) {
  const cells = csvRows[r]
  if (!cells || cells.length < 5) continue
  counts.total += 1
  const eventUuid = (cells[ix.eventUuid] ?? '').trim()
  if (!eventUuid) continue
  const first = (cells[ix.inviteeFirst] ?? '').trim() || null
  const last = (cells[ix.inviteeLast] ?? '').trim() || null
  const email = (cells[ix.inviteeEmail] ?? '').trim().toLowerCase() || null
  const eventType = (cells[ix.eventTypeName] ?? '').trim() || null

  try {
    // 1. Find existing interaction by event_uuid in body
    const { data: matches } = await sb
      .from('interactions')
      .select('id, wedding_id, full_body, extracted_identity')
      .eq('venue_id', RIXEY)
      .ilike('full_body', `%event_uuid:${eventUuid}%`)
      .limit(2)
    const inter = matches?.[0]

    if (!inter) {
      counts.no_existing_interaction += 1
      if (noMatchSample.length < 10) {
        noMatchSample.push({ eventUuid, first, last, email, eventType })
      }
      continue
    }
    counts.matched_existing_interaction += 1

    const body = inter.full_body ?? ''
    const hasPartner1Name = body.includes('partner1_name:')
    const inviteeFull = [first, last].filter(Boolean).join(' ').trim() || null

    if (!inviteeFull && !email) {
      counts.no_invitee_name += 1
      // Still write a crm_import_rows entry so future re-imports skip it
    } else if (hasPartner1Name) {
      counts.body_already_patched += 1
    } else {
      // 2. Build patched body — insert Pass-H lines BEFORE the partner2_name
      //    block (or at end if not present). Pattern matches Pass H.
      const newLines = []
      if (inviteeFull) newLines.push(`partner1_name:${inviteeFull}`)
      if (email) newLines.push(`partner1_email:${email}`)
      let patchedBody
      const partner2Idx = body.indexOf('partner2_name:')
      if (partner2Idx >= 0) {
        patchedBody = body.slice(0, partner2Idx) + newLines.join('\n') + '\n' + body.slice(partner2Idx)
      } else {
        patchedBody = body + (body.endsWith('\n') ? '' : '\n') + newLines.join('\n')
      }

      // 3. Patch extracted_identity
      const existingIdentity = (inter.extracted_identity && typeof inter.extracted_identity === 'object')
        ? { ...inter.extracted_identity }
        : {}
      if (first) existingIdentity.partner1_first_name = first
      if (last) existingIdentity.partner1_last_name = last
      if (email) existingIdentity.partner1_email = email

      if (!dryRun) {
        const { error: upErr } = await sb
          .from('interactions')
          .update({
            full_body: patchedBody,
            body_preview: patchedBody.slice(0, 200),
            extracted_identity: existingIdentity,
          })
          .eq('id', inter.id)
        if (upErr) throw new Error(`interaction update: ${upErr.message}`)
      }
      counts.body_patched += 1
    }

    // 4. Patch the wedding's partner1 people row if blank
    if (inviteeFull) {
      const { data: pps } = await sb
        .from('people')
        .select('id, first_name, last_name, email, name_evidence')
        .eq('wedding_id', inter.wedding_id)
        .eq('role', 'partner1')
        .is('merged_into_id', null)
        .limit(1)
      const p1 = pps?.[0]
      if (p1) {
        const isBlank = !p1.first_name || p1.first_name === '(Unknown)' || p1.first_name === 'Unknown'
        if (isBlank) {
          const evArr = Array.isArray(p1.name_evidence) ? p1.name_evidence : []
          const newEv = {
            source: 'form_relay',
            value: { first, last },
            confidence: 60,
            captured_at: new Date().toISOString(),
            quote: `Calendly retro CSV reimport (event_uuid:${eventUuid})`,
          }
          if (!dryRun) {
            const { error: pErr } = await sb
              .from('people')
              .update({
                first_name: first,
                last_name: last,
                email: p1.email ?? email,
                name_evidence: [...evArr, newEv],
              })
              .eq('id', p1.id)
            if (pErr) throw new Error(`people update: ${pErr.message}`)
          }
          counts.people_row_patched += 1
        } else {
          counts.people_row_already_named += 1
        }
      }
    }

    // 5. Write crm_import_rows entry (idempotent via unique index)
    const fingerprint = sha256(`ext|tour_scheduler|${eventUuid.toLowerCase()}`)
    const contentHash = sha256(
      `status=${eventType ?? ''}|canceled=${body.includes('cancelled:true') ? '1' : '0'}`,
    )
    if (!dryRun) {
      const { error: cErr, data: cData } = await sb
        .from('crm_import_rows')
        .upsert(
          {
            venue_id: RIXEY,
            source: 'tour_scheduler',
            row_fingerprint: fingerprint,
            content_hash: contentHash,
            row_data: {
              event_uuid: eventUuid,
              event_type: eventType,
              invitee_first: first,
              invitee_last: last,
              invitee_email: email,
            },
            state_history: [],
            resolved_wedding_id: inter.wedding_id,
            resolution: 'attached_strong',
            resolution_reason: 'retro re-import: matched existing interaction by event_uuid',
            last_seen_at: new Date().toISOString(),
          },
          { onConflict: 'venue_id,source,row_fingerprint' },
        )
        .select('id')
      if (cErr) throw new Error(`crm_import_rows upsert: ${cErr.message}`)
      counts.crm_import_rows_inserted += 1
    } else {
      counts.crm_import_rows_inserted += 1
    }
  } catch (err) {
    counts.errors += 1
    if (errorSample.length < 10) {
      errorSample.push({ eventUuid, error: err instanceof Error ? err.message : String(err) })
    }
  }

  if (counts.total % 50 === 0) {
    process.stdout.write(`processed ${counts.total} rows...\r`)
  }
}

console.log('\n\nDone. Summary:')
console.log(JSON.stringify(counts, null, 2))
if (noMatchSample.length > 0) {
  console.log('\nFirst rows with no existing interaction (would need fresh mint):')
  for (const s of noMatchSample) console.log('  ', s)
}
if (errorSample.length > 0) {
  console.log('\nFirst error sample:')
  for (const s of errorSample) console.log('  ', s)
}
