import { createServiceClient } from '../src/lib/supabase/service'
import { deriveLeadSourceForVenue } from '../src/lib/services/attribution/lead-source-derivation'

const VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

async function main() {
  const supabase = createServiceClient()
  console.log(`Running lead source derivation for Rixey Manor...`)
  const r = await deriveLeadSourceForVenue(supabase, VENUE_ID)
  console.log(`  Scanned: ${r.weddingsScanned}`)
  console.log(`  Derived: ${r.derived}`)
  console.log(`  No signal: ${r.noSignal}`)
  console.log(`  By priority: ${JSON.stringify(r.perPriority)}`)
  if (r.errors.length) console.log(`  Errors (${r.errors.length}): ${r.errors.slice(0, 5).join('; ')}`)
}

main().catch(e => { console.error(e); process.exit(1) })
