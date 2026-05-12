/**
 * Cron: agency-document-orphans (Wave 6E follow-up)
 *
 * Sweeps Supabase Storage objects whose agency_documents row was soft-
 * deleted more than 30 days ago, removing the underlying file. Soft-
 * delete preserves the row (for audit). Hard storage removal only
 * happens after the retention window so an accidental delete is
 * recoverable in the meantime.
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyCronAuth } from '@/lib/cron-auth'
import { runAgencyDocumentOrphans } from '@/lib/services/intel/marketing-agency-cron'

export const maxDuration = 120

async function handle(request: NextRequest): Promise<NextResponse> {
  const authResult = verifyCronAuth(request, { alwaysDestructive: true })
  if (!authResult.ok) {
    return NextResponse.json(
      { ok: false, error: authResult.error },
      { status: authResult.status },
    )
  }
  try {
    const result = await runAgencyDocumentOrphans()
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    )
  }
}

export async function GET(request: NextRequest) {
  return handle(request)
}

export async function POST(request: NextRequest) {
  return handle(request)
}
