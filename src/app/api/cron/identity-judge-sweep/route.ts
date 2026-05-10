/**
 * Wave 4 Identity Reconstruction — cron sweep route (Phase 2).
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic identity reconstruction)
 *   - bloom-wave4-identity-reconstruction.md (Phase 2 — bulk + cron +
 *     signal-driven enqueue)
 *
 * Auth: Bearer ${CRON_SECRET} ONLY. No coordinator path. Hardened via
 * verifyCronAuth({ alwaysDestructive: true }) — when CRON_SECRET_
 * DESTRUCTIVE is set, ad-hoc curl invocations are blocked unless the
 * caller carries the secondary header. Vercel-cron-fired hits pass
 * through automatically.
 *
 * Why a standalone route exists alongside the dispatcher
 * ------------------------------------------------------
 * The dispatcher at /api/cron?job=identity_judge_sweep is what Vercel
 * actually fires (vercel.json sits at the 40-cron Pro-plan ceiling).
 * This standalone route exists for the verification curl in Phase 2's
 * test plan (POST http://localhost:3000/api/cron/identity-judge-sweep)
 * and for ad-hoc ops use. Both paths call into the shared
 * runIdentityJudgeSweep service so worker logic lives in one place.
 *
 * Time budget: maxDuration=300 (Vercel Pro). Service stops launching
 * new work at 280s — see judge-sweep.ts.
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyCronAuth } from '@/lib/cron-auth'
import { runIdentityJudgeSweep } from '@/lib/services/identity/judge-sweep'

export const maxDuration = 300

async function handle(request: NextRequest): Promise<NextResponse> {
  const authResult = verifyCronAuth(request, { alwaysDestructive: true })
  if (!authResult.ok) {
    return NextResponse.json(
      { ok: false, error: authResult.error },
      { status: authResult.status },
    )
  }

  const result = await runIdentityJudgeSweep()
  return NextResponse.json(result, { status: result.ok ? 200 : 500 })
}

export async function POST(request: NextRequest) {
  return handle(request)
}

// Vercel cron uses GET. Support both verbs so the same handler covers
// Vercel-fired schedules AND ad-hoc ops curls.
export async function GET(request: NextRequest) {
  return handle(request)
}
