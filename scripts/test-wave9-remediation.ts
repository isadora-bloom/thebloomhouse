/**
 * Wave 9 — local verification harness.
 *
 * Runs each remediation against Rixey in dry_run mode, then prints the
 * counts. After this confirms the structure works, the apply pass can
 * be run via the same script with --apply.
 *
 * Usage:
 *   npx tsx scripts/test-wave9-remediation.ts
 *   npx tsx scripts/test-wave9-remediation.ts --apply
 */

import {
  remediateGhostWeddings,
  remediateMisclassifiedInbound,
  remediateInquiryDateDrift,
  remediateTouchpointSourceMismatch,
} from '../src/lib/services/data-integrity/remediation'

const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const apply = process.argv.includes('--apply')
const mode = apply ? 'apply' : 'dry_run'

async function main() {
  console.log(`\nWave 9 remediation test — Rixey (${RIXEY_ID}) — mode=${mode}\n`)

  console.log('1/4 wedding_has_people…')
  const r1 = await remediateGhostWeddings({ venueId: RIXEY_ID, mode })
  console.log(JSON.stringify({
    detected: r1.violationsDetected,
    fixed: r1.violationsFixed,
    skipped: r1.violationsSkipped,
    skipReasons: r1.skipReasons,
    strategy: r1.fixStrategy,
    errors: r1.errors,
    sampleBefore: r1.sampleBefore.slice(0, 3),
    sampleAfter: r1.sampleAfter.slice(0, 3),
  }, null, 2))

  console.log('\n2/4 direction_from_venue_own…')
  const r2 = await remediateMisclassifiedInbound({ venueId: RIXEY_ID, mode })
  console.log(JSON.stringify({
    detected: r2.violationsDetected,
    fixed: r2.violationsFixed,
    skipped: r2.violationsSkipped,
    skipReasons: r2.skipReasons,
    strategy: r2.fixStrategy,
    errors: r2.errors,
    sampleBefore: r2.sampleBefore.slice(0, 3),
  }, null, 2))

  console.log('\n3/4 inquiry_date_drift…')
  const r3 = await remediateInquiryDateDrift({ venueId: RIXEY_ID, mode })
  console.log(JSON.stringify({
    detected: r3.violationsDetected,
    fixed: r3.violationsFixed,
    skipped: r3.violationsSkipped,
    skipReasons: r3.skipReasons,
    strategy: r3.fixStrategy,
    errors: r3.errors,
    sampleBefore: r3.sampleBefore.slice(0, 3),
  }, null, 2))

  console.log('\n4/4 touchpoint_source_consistency…')
  const r4 = await remediateTouchpointSourceMismatch({ venueId: RIXEY_ID, mode })
  console.log(JSON.stringify({
    detected: r4.violationsDetected,
    fixed: r4.violationsFixed,
    skipped: r4.violationsSkipped,
    skipReasons: r4.skipReasons,
    strategy: r4.fixStrategy,
    errors: r4.errors,
    sampleBefore: r4.sampleBefore.slice(0, 3),
  }, null, 2))

  console.log('\nDone.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
