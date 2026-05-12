/**
 * POST /api/admin/weddings/[weddingId]/stamp-evidence
 *
 * Scaffolded by an upstream auto-commit (0c62b2f, identity-resolution
 * deep-fix bundle) but landed empty (0 bytes), which broke production
 * builds with TS error: "File ... is not a module."
 *
 * Stubbed with a 501 Not Implemented so the file is a valid module and
 * the build passes. Replace with the real handler when the corresponding
 * admin feature lands.
 */

import { NextResponse } from 'next/server'

export async function POST() {
  return NextResponse.json(
    { error: 'stamp_evidence_not_implemented' },
    { status: 501 },
  )
}
