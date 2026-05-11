/**
 * Wave 9 sweep verification — runs the integrity-remediation sweep (dry_run
 * by default; venue_config.feature_flags.integrity_auto_remediate=true would
 * flip to apply per-venue). Confirms audit rows are written.
 */

import { runIntegrityRemediationSweep } from '../src/lib/services/data-integrity/remediation/sweep'

async function main() {
  console.log('\nWave 9 sweep — runIntegrityRemediationSweep()\n')
  const summary = await runIntegrityRemediationSweep()
  console.log(JSON.stringify(summary, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
