import { NextResponse } from 'next/server'
import { getPlatformAuth, unauthorized, forbidden } from '@/lib/api/auth-helpers'
import { backfillGmailVoice } from '@/lib/services/voice/gmail-backfill'

/**
 * POST /api/intel/voice-dna/backfill
 *
 * Triggers the Gmail history backfill for the authenticated user's
 * venue. Pulls last 12 months of sent email, filters out
 * auto-replies / calendar invites / system notifications, runs the
 * remaining bodies through a phrase extractor, and upserts into
 * review_language with source_type='gmail_backfill'.
 *
 * Authority: org_admin or super_admin (this stamps voice phrases that
 * shape every future Sage draft; not a coordinator-self action).
 *
 * Returns the backfill summary so the page can show "scanned 47,
 * extracted 23 distinct phrases" feedback to the operator.
 *
 * Coordinator can re-click safely; phrases dedup on (venue_id, phrase).
 */
export const maxDuration = 300

export async function POST() {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('Voice backfill is unavailable in demo mode')
  if (auth.role !== 'super_admin' && auth.role !== 'org_admin') {
    return forbidden('admin only')
  }

  try {
    const result = await backfillGmailVoice(auth.venueId)
    return NextResponse.json(result)
  } catch (err) {
    console.error('[voice-dna/backfill] failed:', err)
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
