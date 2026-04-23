// Import Rixey's "Key Policies" CSV (FAQ-style Q/A pairs) into knowledge_base.
//
// Why a script and not the brain-dump route:
//   The brain-dump classifier only reads the typed prompt, not the attached
//   file's contents (per the TODO in floating-brain-dump.tsx). When the user
//   types "key policies" with a CSV, Claude has nothing to classify against
//   the file body and bails into needs_clarification. This script imports
//   the rows directly with source='csv' and marks the pending brain-dump
//   entry resolved.
//
// Idempotent: re-running upserts on (venue_id, question) so no duplicates.
//
// Usage: node scripts/import-rixey-policies.mjs
// Optional flags: --dry-run to preview without writing.

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { parse } from 'node:path'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const CSV_PATH = 'C:\\Users\\Ismar\\Downloads\\LINDY INQUIRY BRAIN - Key Policies.csv'
const DRY_RUN = process.argv.includes('--dry-run')

// Simple CSV parser that handles quoted fields with embedded commas.
function parseCsv(text) {
  const rows = []
  let i = 0
  let field = ''
  let row = []
  let inQuotes = false
  while (i < text.length) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue }
      if (c === '"') { inQuotes = false; i++; continue }
      field += c; i++; continue
    }
    if (c === '"') { inQuotes = true; i++; continue }
    if (c === ',') { row.push(field); field = ''; i++; continue }
    if (c === '\r') { i++; continue }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue }
    field += c; i++
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((f) => f.trim().length))
}

function categoryFor(q) {
  const t = q.toLowerCase()
  if (/guest|accommodate|capacity/.test(t)) return 'capacity'
  if (/deposit|payment|book|advance|discount|fee|hidden/.test(t)) return 'pricing'
  if (/pet|wheelchair|accessible|lgbtq|cultural|religious/.test(t)) return 'inclusive'
  if (/accommodation|sleep|hotel|overnight/.test(t)) return 'lodging'
  if (/vendor|caterer|bartender|alcohol|coordinator|planner|amenit|chair|table/.test(t)) return 'vendors_amenities'
  if (/rain|weather|tent/.test(t)) return 'weather_tent'
  if (/time|hour|end|music/.test(t)) return 'timing'
  if (/decor|petal|sparkler|furniture/.test(t)) return 'decor'
  if (/shuttle|uber|parking|transport/.test(t)) return 'transport'
  if (/cleanup|insurance|elopement|micro-wedding|food truck|staff/.test(t)) return 'logistics'
  return 'general'
}

// --- Load + parse -----------------------------------------------------------
const raw = readFileSync(CSV_PATH, 'utf8')
const rows = parseCsv(raw)
const header = rows.shift() // Question, Answer
if (!header || header[0].trim().toLowerCase() !== 'question') {
  console.error('CSV header mismatch. Expected first column "Question".')
  process.exit(1)
}

const records = rows
  .filter((r) => (r[0] ?? '').trim() && (r[1] ?? '').trim())
  .map((r) => ({
    venue_id: RIXEY_VENUE_ID,
    question: r[0].trim(),
    answer: r[1].trim(),
    category: categoryFor(r[0]),
    priority: 50,
    is_active: true,
    source: 'csv',
  }))

console.log(`Parsed ${records.length} Q/A pairs from ${parse(CSV_PATH).base}`)
console.log(`First: "${records[0].question.slice(0, 60)}" -> category=${records[0].category}`)
console.log(`Last:  "${records[records.length - 1].question.slice(0, 60)}" -> category=${records[records.length - 1].category}`)

if (DRY_RUN) {
  console.log('\n--dry-run — no writes.')
  const byCat = {}
  for (const r of records) byCat[r.category] = (byCat[r.category] ?? 0) + 1
  console.log('Categories:', byCat)
  process.exit(0)
}

// --- Upsert (idempotent on venue_id + question) -----------------------------
// knowledge_base has no unique constraint, so we dedupe by querying first.
const questions = records.map((r) => r.question)
const { data: existing } = await sb
  .from('knowledge_base')
  .select('question')
  .eq('venue_id', RIXEY_VENUE_ID)
  .in('question', questions)
const existingSet = new Set((existing ?? []).map((r) => r.question))
const toInsert = records.filter((r) => !existingSet.has(r.question))
console.log(`Existing: ${existingSet.size}. Will insert: ${toInsert.length}.`)

if (toInsert.length > 0) {
  const { error, count } = await sb.from('knowledge_base').insert(toInsert, { count: 'exact' })
  if (error) { console.error('Insert failed:', error.message); process.exit(1) }
  console.log(`Inserted ${count}.`)
}

// --- Mark the stuck brain-dump entry resolved ------------------------------
const { data: stuck } = await sb
  .from('brain_dump_entries')
  .select('id')
  .eq('venue_id', RIXEY_VENUE_ID)
  .eq('parse_status', 'needs_clarification')
  .ilike('raw_input', '%Key_Policies.csv%')
  .order('created_at', { ascending: false })
  .limit(1)
if (stuck && stuck.length > 0) {
  await sb.from('brain_dump_entries').update({
    parse_status: 'confirmed',
    clarification_answer: 'Imported into knowledge_base via scripts/import-rixey-policies.mjs',
    routed_to: [{ table: 'knowledge_base', count: toInsert.length }],
    resolved_at: new Date().toISOString(),
    parsed_at: new Date().toISOString(),
  }).eq('id', stuck[0].id)
  console.log(`Marked brain-dump entry ${stuck[0].id} as confirmed.`)
}

console.log('\nDone. Sage will now pull these FAQs into inquiry and client drafts.')
