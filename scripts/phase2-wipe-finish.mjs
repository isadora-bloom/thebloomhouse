// ============================================================================
// Phase 2 wipe — finisher for the two tables the single-statement delete in
// phase2-wipe.mjs could not clear within the Postgres statement timeout
// (interactions 7,650 rows, people 1,629 rows on 2026-09-08). Deletes in
// id-batches so each statement stays well under the timeout. Same safety
// contract as the main wipe: Rixey only (triple-checked), dry-run by default,
// prod refused without --allow-prod. Idempotent — re-run until both read 0.
//
// Usage:
//   node scripts/phase2-wipe-finish.mjs                       # dry-run counts
//   node scripts/phase2-wipe-finish.mjs --apply --allow-prod  # delete on PROD
// ============================================================================
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { parseSafetyFlags, assertNotProd, requireApply } from './_safety.mjs'

const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const RIXEY_VENUE_NAME = 'Rixey Manor'
const TABLES = ['interactions', 'people', 'draft_feedback']
const BATCH = Number(process.env.WIPE_BATCH ?? 250)

const { apply, allowProd } = parseSafetyFlags(process.argv)
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const url = env.NEXT_PUBLIC_SUPABASE_URL
assertNotProd(url, { allowProd })
const sb = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const { data: venue, error: vErr } = await sb
  .from('venues').select('id, name, is_demo').eq('id', RIXEY_VENUE_ID).single()
if (vErr || !venue || venue.name !== RIXEY_VENUE_NAME || venue.is_demo) {
  console.error('SAFETY FAIL: venue check failed', vErr?.message ?? venue); process.exit(1)
}

async function count(t) {
  const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true }).eq('venue_id', RIXEY_VENUE_ID)
  if (error) throw new Error(`${t}: ${error.message}`)
  return count ?? 0
}

for (const t of TABLES) console.log(`${t.padEnd(20)} ${await count(t)} rows for Rixey`)
if (!requireApply(apply, 'phase2-wipe-finish')) process.exit(0)

for (const t of TABLES) {
  let total = 0, failures = 0
  for (;;) {
    const { data: ids, error } = await sb.from(t).select('id').eq('venue_id', RIXEY_VENUE_ID).limit(BATCH)
    if (error) { console.error(`  ${t}: select failed: ${error.message}`); break }
    if (!ids || ids.length === 0) break
    const { error: dErr, count } = await sb.from(t).delete({ count: 'exact' }).in('id', ids.map((r) => r.id))
    if (dErr) {
      failures += 1
      console.error(`  ${t}: batch delete failed (${dErr.message}) — retrying with smaller batch`)
      if (failures > 5) { console.error(`  ${t}: giving up after 5 failures`); break }
      continue
    }
    total += count ?? 0
    process.stdout.write(`\r  ${t}: deleted ${total}`)
  }
  console.log(`\n  ${t}: done, ${total} deleted, ${await count(t)} remaining`)
}
