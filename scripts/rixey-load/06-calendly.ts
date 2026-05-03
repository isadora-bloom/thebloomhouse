// Phase 5: Calendly load via tour-scheduler adapter.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { findAdapter } from '../../src/lib/services/crm-import'

async function main() {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
  )

  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
  const PATH = 'C:/Users/Ismar/Downloads/event-data-from-20250504-to-20260503/event-data-from-20250504-to-20260503.csv'

  // Idempotency
  const { count: priorTours } = await sb
    .from('tours')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID)
    .eq('crm_source', 'generic_csv')
  console.log(`Existing tour-scheduler tours: ${priorTours}`)
  if ((priorTours ?? 0) > 0) {
    console.log('Skipping Calendly load — already imported.')
    return
  }

  const csvText = readFileSync(PATH, 'utf8')
  console.log(`Read ${csvText.length} chars`)

  const adapter = findAdapter('tour_scheduler')
  if (!adapter) throw new Error('tour_scheduler adapter missing')

  const parsed = await adapter.parse({ csvText, provider: 'calendly' })
  console.log()
  console.log(`Parse: ok=${parsed.ok} rows=${parsed.rows.length}`)
  console.log(`  errors=${parsed.errors.length} warnings=${parsed.warnings.length}`)
  for (const e of parsed.errors.slice(0, 3)) console.log('  ERR:', e)
  // Print event-type-tally summary (last warning is the tally)
  const tallyWarning = parsed.warnings.find((w) => w.startsWith('Event type tally:'))
  if (tallyWarning) console.log('  ', tallyWarning.slice(0, 1500))
  if (!parsed.ok || parsed.rows.length === 0) return

  // Sample
  console.log()
  console.log('Sample parsed row:')
  console.log(JSON.stringify(parsed.rows[0], null, 2).slice(0, 1500))

  console.log()
  console.log('Committing...')
  const result = await adapter.commit({ supabase: sb, venueId: RIXEY_ID, rows: parsed.rows })
  console.log(`Commit ok=${result.ok}`)
  console.log(`  weddings=${result.weddingsInserted}`)
  console.log(`  interactions=${result.interactionsInserted}`)
  console.log(`  tours=${result.toursInserted}`)
  console.log(`  lost_deals=${result.lostDealsInserted}`)
  console.log(`  errors=${result.errors.length}`)
  for (const e of result.errors.slice(0, 5)) console.log('  ERR:', e)

  console.log()
  console.log('Done.')
}

main().catch((e) => { console.error(e); process.exit(1) })
