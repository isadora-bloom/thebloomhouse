import { findBacktraceCandidates } from '../../src/lib/services/source-backtrace'
import { readFileSync } from 'node:fs'

async function main() {
  // Load env into process.env so createServiceClient works.
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')] })
  )
  for (const [k, v] of Object.entries(env)) process.env[k] = v as string

  const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

  console.log('=== Backtrace queue probe (Stream-TT, post-migration-187) ===\n')
  console.log('useLiveGmail=false to avoid quota burn.\n')

  // Filtered queue (default — hides no_match)
  const visible = await findBacktraceCandidates(RIXEY_ID, { useLiveGmail: false })
  // Full set (includes no_match for accounting)
  const all = await findBacktraceCandidates(RIXEY_ID, { useLiveGmail: false, includeNoMatch: true })

  let confident = 0
  let weak = 0
  let no = 0
  for (const c of all) {
    if (c.status === 'confident_match') confident++
    else if (c.status === 'weak_match') weak++
    else no++
  }

  console.log(`Visible queue (weak + confident): ${visible.length}`)
  console.log(`All candidates (incl. no_match):  ${all.length}`)
  console.log(`  confident_match: ${confident}`)
  console.log(`  weak_match:      ${weak}`)
  console.log(`  no_match:        ${no}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
