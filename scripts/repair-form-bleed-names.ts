// scripts/repair-form-bleed-names.ts
//
// Backfill: NULL out people.first_name / people.last_name on rows
// where the legacy name-upgrade regex pipeline wrote a Calendly
// form-bleed token (e.g. "Whole Weekend", "Final Walkthrough") to
// the displayed name fields.
//
// Why this exists
// ---------------
// name-upgrade.ts:317 historically ran a capitalized-pair regex over
// weddings.notes, which tour-scheduler composed as `key:value` lines
// (`package_interest:Whole Weekend`). The regex harvested those
// Capitalized values and updated people.first_name='Whole',
// last_name='Weekend' via a direct .from('people').update() call
// that bypassed the name_evidence chokepoint. So name_evidence is
// empty for these rows; the only mark of the bug is the corrupted
// first/last columns.
//
// The full fix shipped in the same change:
//   - name-upgrade.ts now skips `key:value` lines before running
//     the regex (load-bearing class fix).
//   - FORM_BLEED_FIRST / FORM_BLEED_LAST blacklists at the regex
//     output mirror the Sonnet reconstruct judge's refusals.
//   - Migration 322 adds weddings.calendly_qa so future Q&A lands
//     in structured jsonb instead of free-text notes.
//
// This script repairs existing damage. NULLing first/last gives the
// reconstruct judge a clean canvas to refuse correctly on the next
// pass (the judge already knows the pattern, see
// config/prompts/identity-reconstruction.ts §5 form-value detection).
//
// Selection rules
// ---------------
//   1. name_evidence IS NULL OR name_evidence = '[]'::jsonb
//      (rows that bypassed the chokepoint — the chokepoint pre-dates
//      the legacy writer, so any row missing evidence is suspect)
//   2. first_name OR last_name is a member of FORM_BLEED_TOKENS
//      (firstHeads for first_name, lastTails for last_name)
//
// What we change
// --------------
// NULL first_name and last_name. Don't touch email/phone/role/
// display_handle — those are still real signals. The reconstruct
// cron / live name-upgrade pipeline will repopulate the columns on
// the next signal that arrives, this time correctly.
//
// Logging
// -------
// Each repaired row prints `{ id, wedding_id, original_first,
// original_last }` so the audit trail survives the destructive
// NULLing.
//
// Usage
// -----
//   npx tsx scripts/repair-form-bleed-names.ts                # dry-run
//   npx tsx scripts/repair-form-bleed-names.ts --apply
//   npx tsx scripts/repair-form-bleed-names.ts --apply --venue <uuid>

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { FORM_BLEED_TOKENS } from '../src/lib/services/identity/name-upgrade'

// ---- env loader (same shape as the other backfill scripts) ----
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

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
})

// ---- CLI ----
const args = process.argv.slice(2)
const apply = args.includes('--apply')
const venueIdx = args.indexOf('--venue')
const venueId = venueIdx >= 0 ? args[venueIdx + 1] : null

const firstHeads = new Set<string>(FORM_BLEED_TOKENS.firstHeads as readonly string[])
const lastTails = new Set<string>(FORM_BLEED_TOKENS.lastTails as readonly string[])

interface PeopleRow {
  id: string
  wedding_id: string | null
  venue_id: string
  first_name: string | null
  last_name: string | null
  name_evidence: unknown
}

async function main() {
  console.log(`[repair-form-bleed-names] mode=${apply ? 'APPLY' : 'DRY-RUN'}`)
  if (venueId) console.log(`[repair-form-bleed-names] scoped to venue=${venueId}`)
  console.log(`[repair-form-bleed-names] firstHeads=${[...firstHeads].join(',')}`)
  console.log(`[repair-form-bleed-names] lastTails=${[...lastTails].join(',')}`)

  // Pull the candidate population. We can't push the IN-array filter
  // through the OR clause cleanly from the JS client without RPC, so
  // we fetch all rows missing name_evidence and filter in-memory.
  // Volume: bounded by people.count which is O(weddings); fine for
  // O(10k) rows.
  let query = sb
    .from('people')
    .select('id, wedding_id, venue_id, first_name, last_name, name_evidence')
    .or('name_evidence.is.null,name_evidence.eq.[]')
    .is('merged_into_id', null)
  if (venueId) query = query.eq('venue_id', venueId)
  const { data: rows, error } = await query
  if (error) {
    console.error('[repair-form-bleed-names] fetch failed:', error.message)
    process.exit(1)
  }
  const candidates = (rows ?? []) as PeopleRow[]
  console.log(`[repair-form-bleed-names] scanned ${candidates.length} people rows with empty name_evidence`)

  // Filter to form-bleed only.
  const targets = candidates.filter((p) => {
    const f = (p.first_name ?? '').trim()
    const l = (p.last_name ?? '').trim()
    if (!f && !l) return false
    if (f && firstHeads.has(f)) return true
    if (l && lastTails.has(l)) return true
    return false
  })
  console.log(`[repair-form-bleed-names] matched ${targets.length} form-bleed people rows`)

  if (targets.length === 0) {
    console.log('[repair-form-bleed-names] nothing to repair, exiting.')
    return
  }

  let repaired = 0
  for (const p of targets) {
    console.log(JSON.stringify({
      action: apply ? 'null-out' : 'would-null-out',
      id: p.id,
      wedding_id: p.wedding_id,
      venue_id: p.venue_id,
      original_first: p.first_name,
      original_last: p.last_name,
    }))
    if (!apply) continue
    const { error: updErr } = await sb
      .from('people')
      .update({ first_name: null, last_name: null })
      .eq('id', p.id)
      .is('merged_into_id', null)
    if (updErr) {
      console.warn(`[repair-form-bleed-names] update failed for ${p.id}:`, updErr.message)
      continue
    }
    repaired += 1
  }

  console.log(`[repair-form-bleed-names] done. ${apply ? 'repaired' : 'would-repair'}=${repaired}/${targets.length}`)
}

main().catch((err) => {
  console.error('[repair-form-bleed-names] fatal:', err)
  process.exit(1)
})
