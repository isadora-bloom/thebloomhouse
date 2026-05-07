// Phase 10b: Pulse aggregator test.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { aggregatePulseFull } from '../../src/lib/services/intel/pulse-aggregator'

async function main() {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
  )
  for (const [k, v] of Object.entries(env)) if (!process.env[k]) process.env[k] = v as string

  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

  console.log('Running aggregatePulseFull for Rixey...')
  const result = await aggregatePulseFull(sb, RIXEY_ID, { limit: 30 })
  console.log()
  console.log(`Items: ${result.items.length}`)
  console.log(`Paused banner: ${result.pausedBanner ? JSON.stringify(result.pausedBanner) : 'null'}`)
  console.log()
  for (const item of result.items.slice(0, 20)) {
    console.log(`[${item.priority}/${item.source}] ${item.title}`)
    if (item.body) console.log(`  ${item.body.slice(0, 150)}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
