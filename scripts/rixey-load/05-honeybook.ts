// Phase 4: HoneyBook load.
// The Rixey HoneyBook export uses a different shape than the GG adapter
// expects:
//   - "Client Info" is free-text "Name email, Name email" comma-pair list
//   - "Booked (yes/no)" replaces "Project Status"
//   - No "Source" / "Inquiry Date" columns — Lead Source is "Lead Source",
//     creation date is "Project Creation Date"
// We pre-process into a CSV the adapter understands, then call adapter.parse().
//
// Expected output: ~94 weddings (most with status='inquiry' since the export
// uses Booked yes/no instead of granular status). We map Booked=Yes →
// 'booked', Booked=No → 'inquiry' (with past-date Booked=No → 'lost' deal).
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { findAdapter } from '../../src/lib/services/crm-import'
import { parseCsvRows } from '../../src/lib/services/brain-dump-csv-shape'

async function main() {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
  )

  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
  const PATH = 'C:/Users/Ismar/Downloads/May-2024-Project-report-(HoneyBook).csv'

  // Idempotency check
  const { count: priorCount } = await sb
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID)
    .eq('crm_source', 'honeybook')
  console.log(`Existing honeybook-tagged weddings: ${priorCount}`)
  if ((priorCount ?? 0) > 0) {
    console.log('Skipping HoneyBook load — already imported.')
    return
  }

  // ---- Read raw CSV + pre-process into adapter-friendly shape ----
  const rawText = readFileSync(PATH, 'utf8')
  const rawRows = parseCsvRows(rawText)
  const rawHeader = rawRows[0]
  const idx = (name: string) => rawHeader.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase())

  const iName = idx('Project Name')
  const iBookedYN = idx('Booked (yes/no)')
  const iClientInfo = idx('Client Info')
  const iLeadSource = idx('Lead Source')
  const iCreate = idx('Project Creation Date')
  const iBookedDate = idx('Booked Date')
  const iEventDate = idx('Project Date')
  const iValue = idx('Total Project Value')

  console.log(`Source CSV: ${rawRows.length - 1} data rows`)

  // Build the new adapter-friendly CSV. Headers we want:
  //   Project Name, Project Status, Client Name, Client Email,
  //   Inquiry Date, Booking Date, Project Date, Source, Total
  const newHeader = [
    'Project Name',
    'Project Status',
    'Client Name',
    'Client Email',
    'Inquiry Date',
    'Booking Date',
    'Project Date',
    'Source',
    'Total',
    'Notes',
  ]

  const today = new Date()
  const newRows: string[][] = [newHeader]
  let pastUnbooked = 0, futureUnbooked = 0, booked = 0, skipped = 0
  for (let r = 1; r < rawRows.length; r++) {
    const row = rawRows[r]
    if (!row || row.length === 0 || row.every((c) => !c?.trim())) continue
    const projName = row[iName] ?? ''
    if (!projName.trim()) { skipped++; continue }

    const bookedRaw = (row[iBookedYN] ?? '').trim().toLowerCase()
    const isBooked = bookedRaw === 'yes'

    const clientInfo = row[iClientInfo] ?? ''
    // First "Name email" pair is partner1.
    // Split on commas first; pairs look like "First Last em@ail.com"
    const pairs = clientInfo.split(',').map((s) => s.trim()).filter(Boolean)
    let clientName = ''
    let clientEmail = ''
    if (pairs.length > 0) {
      const first = pairs[0]
      // Email is the last token containing '@'
      const tokens = first.split(/\s+/)
      const emailTok = tokens.find((t) => t.includes('@'))
      clientEmail = emailTok ?? ''
      clientName = tokens.filter((t) => !t.includes('@')).join(' ')
    }
    if (!clientEmail) {
      // Fall back to a placeholder so adapter accepts row; mark in notes.
      clientEmail = `unknown-honeybook-${r}@import.local`
    }

    const eventDateStr = (row[iEventDate] ?? '').trim()
    const eventDate = eventDateStr ? new Date(eventDateStr) : null
    const isPastEvent = eventDate && eventDate < today

    let status = 'inquiry'
    if (isBooked) {
      booked++
      // If event date is past → completed; otherwise booked
      status = isPastEvent ? 'completed' : 'booked'
    } else if (isPastEvent) {
      // Past event date but not booked → lost
      status = 'lost'
      pastUnbooked++
    } else {
      futureUnbooked++
    }

    const valueRaw = (row[iValue] ?? '0').replace(/[$,]/g, '').trim()
    const value = Number(valueRaw) || 0

    const notesParts: string[] = []
    if (pairs.length > 1) notesParts.push(`Other contacts: ${pairs.slice(1).join('; ')}`)

    newRows.push([
      projName,
      status,
      clientName,
      clientEmail,
      (row[iCreate] ?? '').trim(),
      isBooked ? (row[iBookedDate] ?? '').trim() : '',
      eventDateStr,
      (row[iLeadSource] ?? '').trim() || '',
      String(value),
      notesParts.join(' | '),
    ])
  }

  console.log(`Transformed: booked=${booked} pastUnbooked=${pastUnbooked} futureUnbooked=${futureUnbooked} skipped=${skipped}`)

  // Serialize to CSV (basic — quote every cell to be safe)
  const csvOut = newRows.map((row) =>
    row.map((c) => `"${(c ?? '').replace(/"/g, '""')}"`).join(',')
  ).join('\n')

  // ---- Run adapter ----
  const adapter = findAdapter('honeybook')
  if (!adapter) throw new Error('honeybookAdapter missing')

  const parsed = await adapter.parse({ csvText: csvOut })
  console.log()
  console.log(`Parse: ok=${parsed.ok} rows=${parsed.rows.length} errors=${parsed.errors.length} warnings=${parsed.warnings.length}`)
  for (const e of parsed.errors.slice(0, 5)) console.log('  ERR:', e)
  for (const w of parsed.warnings.slice(0, 5)) console.log('  WARN:', w)
  if (!parsed.ok || parsed.rows.length === 0) return

  console.log()
  console.log('Sample row:')
  console.log(JSON.stringify(parsed.rows[0], null, 2).slice(0, 800))

  // ---- Commit ----
  console.log()
  console.log('Committing...')
  const result = await adapter.commit({ supabase: sb, venueId: RIXEY_ID, rows: parsed.rows })
  console.log(`Commit: ok=${result.ok}`)
  console.log(`  weddings=${result.weddingsInserted}`)
  console.log(`  interactions=${result.interactionsInserted}`)
  console.log(`  tours=${result.toursInserted}`)
  console.log(`  lost_deals=${result.lostDealsInserted}`)
  console.log(`  errors=${result.errors.length}`)
  for (const e of result.errors.slice(0, 5)) console.log('  ERR:', e)

  // After commit, write a synthetic "imported from HoneyBook" interaction
  // per wedding so the timeline isn't completely blank for couples that
  // had no prior pipeline activity.
  const { data: imported } = await sb
    .from('weddings')
    .select('id, inquiry_date')
    .eq('venue_id', RIXEY_ID)
    .eq('crm_source', 'honeybook')
  console.log(`Adding synthetic import-marker interactions for ${imported?.length ?? 0} weddings...`)
  const synthetic = (imported ?? []).map((w) => ({
    venue_id: RIXEY_ID,
    wedding_id: w.id,
    type: 'email',
    direction: 'inbound',
    subject: 'Imported from HoneyBook (May 2024 export)',
    body_preview: 'Lead record imported from HoneyBook CRM export. Earlier history may be incomplete.',
    full_body: 'Lead record imported from HoneyBook CRM export at onboarding. Earlier per-message history is not present in the export and will not be retroactively reconstructed.',
    timestamp: w.inquiry_date,
    confidence_flag: 'imported_medium',
    crm_source: 'honeybook',
  }))
  if (synthetic.length > 0) {
    for (let i = 0; i < synthetic.length; i += 50) {
      const batch = synthetic.slice(i, i + 50)
      const { error } = await sb.from('interactions').insert(batch)
      if (error) console.error(`synth batch ${i}:`, error.message)
    }
  }

  console.log()
  console.log('Done.')
}

main().catch((e) => { console.error(e); process.exit(1) })
