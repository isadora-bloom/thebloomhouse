/**
 * Parse-only check of the HoneyBook booked-client CSVs. No database, no writes.
 * Runs the real adapter parser over each file and reports row counts, warnings,
 * status distribution, missing emails/dates, and cross-file duplicates by email,
 * so the operator knows what the UI import will do before uploading anything.
 *
 * Usage: npx tsx scripts/phase2-honeybook-parse-check.ts
 */
import { readFileSync, existsSync } from 'node:fs'

const DOWNLOADS = 'C:/Users/Ismar/Downloads'
const CSV_FILES = [
  `${DOWNLOADS}/January-2022-June-2024-Booked Client-report-(HoneyBook).csv`,
  `${DOWNLOADS}/June-2023-Booked Client-report-(HoneyBook).csv`,
  `${DOWNLOADS}/May-2024-Booked Client-report-(HoneyBook).csv`,
  `${DOWNLOADS}/January-2024-Booked Client-report-(HoneyBook).csv`,
  `${DOWNLOADS}/January-2025-March-2026-Booked Client-report-(HoneyBook).csv`,
]

async function main() {
  const { honeybookAdapter } = await import('../src/lib/services/crm-import/honeybook')
  const seen = new Map<string, string[]>()
  let total = 0
  for (const file of CSV_FILES) {
    const name = file.split('/').pop()!
    if (!existsSync(file)) { console.log(`MISSING ${name}`); continue }
    const res = await honeybookAdapter.parse({ csvText: readFileSync(file, 'utf8') })
    const rows = res.rows
    total += rows.length
    const status: Record<string, number> = {}
    let noEmail = 0, noDate = 0, noName = 0, noValue = 0
    for (const r of rows as Array<Record<string, unknown>>) {
      status[String(r.status ?? 'null')] = (status[String(r.status ?? 'null')] ?? 0) + 1
      const email = String(r.partner1_email ?? r.partner2_email ?? '').toLowerCase().trim()
      if (!email) noEmail++
      else seen.set(email, [...(seen.get(email) ?? []), name])
      if (!r.wedding_date) noDate++
      if (!r.partner1_first_name) noName++
      if (r.booking_value == null) noValue++
    }
    console.log(`\n=== ${name} ===`)
    console.log(`  ok=${res.ok} rows=${rows.length} errors=${res.errors.length} warnings=${res.warnings.length}`)
    console.log(`  status: ${JSON.stringify(status)}`)
    console.log(`  missing: email=${noEmail} date=${noDate} name=${noName} value=${noValue}`)
    for (const e of res.errors.slice(0, 5)) console.log('  ERR ', e)
    for (const w of res.warnings.slice(0, 5)) console.log('  WARN', w)
  }
  const dupes = [...seen.entries()].filter(([, files]) => files.length > 1)
  console.log(`\nTotal rows across files: ${total}; distinct emails: ${seen.size}; emails appearing in >1 file: ${dupes.length}`)
  console.log('The dedup gate should skip those repeats on the second and later files.')
}
main().catch((e) => { console.error('FATAL', e); process.exit(1) })
