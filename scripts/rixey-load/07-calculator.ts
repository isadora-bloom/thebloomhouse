// Phase 6: Web-form (Rixey pricing calculator) load via web-form adapter.
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
  const PATH = 'C:/Users/Ismar/Downloads/Rixey Manor Pricing Entries (3).csv'

  const { count: prior } = await sb
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID)
    .eq('crm_source', 'web_form')
  console.log(`Existing web_form-tagged weddings: ${prior}`)
  if ((prior ?? 0) > 0) {
    console.log('Skipping calculator load — already imported.')
    return
  }

  const csvText = readFileSync(PATH, 'utf8')
  console.log(`Read ${csvText.length} chars`)

  const adapter = findAdapter('web_form')
  if (!adapter) throw new Error('web_form adapter missing')

  // The web-form adapter accepts a `formProvider` field on the config.
  const parsed = await adapter.parse({ csvText, /* @ts-ignore */ formProvider: 'rixey_calculator' } as any)
  console.log()
  console.log(`Parse: ok=${parsed.ok} rows=${parsed.rows.length}`)
  console.log(`  errors=${parsed.errors.length} warnings=${parsed.warnings.length}`)
  for (const e of parsed.errors.slice(0, 5)) console.log('  ERR:', e)
  for (const w of parsed.warnings.slice(0, 8)) console.log('  WARN:', w)

  if (!parsed.ok || parsed.rows.length === 0) return

  console.log()
  console.log('Sample row:')
  console.log(JSON.stringify(parsed.rows[0], null, 2).slice(0, 1500))

  console.log()
  console.log('Committing...')
  const result = await adapter.commit({ supabase: sb, venueId: RIXEY_ID, rows: parsed.rows })
  console.log(`Commit: ok=${result.ok}`)
  console.log(`  weddings=${result.weddingsInserted}`)
  console.log(`  interactions=${result.interactionsInserted}`)
  console.log(`  tours=${result.toursInserted}`)
  console.log(`  errors=${result.errors.length}`)
  for (const e of result.errors.slice(0, 5)) console.log('  ERR:', e)
}

main().catch((e) => { console.error(e); process.exit(1) })
