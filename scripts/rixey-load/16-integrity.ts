// Phase 11: Data integrity check (the 8 invariants).
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { runDataIntegrityChecks } from '../../src/lib/services/data-integrity'

async function main() {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
  )
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

  console.log('Running 8 data-integrity invariants for Rixey...')
  const results = await runDataIntegrityChecks(sb, RIXEY_ID)
  console.log()
  for (const r of results) {
    console.log(`[${r.count === 0 ? 'OK' : 'FAIL'}] ${r.id.padEnd(36)} violations=${r.count}  ${r.name}`)
    if (r.count > 0 && r.sample?.length) {
      for (const s of r.sample.slice(0, 2)) {
        console.log(`    ${JSON.stringify(s).slice(0, 200)}`)
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
