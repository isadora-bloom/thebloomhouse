// Phase 2 step D.3 — Calendly replay.
// Reads weddings.calendly_qa (restored by phase2-remerge-operator-columns.mjs)
// and re-fires every invitee payload through linkSignal.
// Run AFTER the re-merge, AFTER HoneyBook CSV import.
// Usage: npx tsx scripts/phase2-replay-calendly.ts
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { replayCalendlyFromQa } from '../src/lib/services/identity/replay/calendly-replay'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

async function main() {
  console.log('Running Calendly replay (D.3)…')
  const result = await replayCalendlyFromQa({ supabase, venueId: VENUE_ID })
  console.log(`processed: ${result.processed}  linked: ${result.linked}`)
  if (result.processed === 0) console.log('⚠  0 processed — confirm calendly_qa was re-merged (D.2) before running this.')
  else console.log('✓ Done. Next: Gmail backfill (already running via null watermark).')
}
main().catch((err) => { console.error('FATAL:', err); process.exit(1) })
