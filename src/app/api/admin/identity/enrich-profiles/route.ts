/**
 * One-shot profile-enrichment backfill — sweep every active wedding for
 * the caller's venue and run the continuous-enrichment pipeline against
 * each. Picks up structured-field upgrades (phone, employer, hometown,
 * dietary_summary, family_context, guest_count_estimate refinements)
 * AND soft-context observations the body extractor missed (life
 * mentions, mood, vendor preferences).
 *
 * Why this exists
 * ---------------
 * The live pipeline now wires `enrichProfileFromTouchpoints` after each
 * inbound email. New leads enrich themselves over time. But every
 * existing wedding — historical Knot inquiries, post-tour notes,
 * calculator emails sitting on file — needs a one-shot pass to fill the
 * legacy gaps and seed wedding_auto_context with what the AI sees in
 * the existing thread.
 *
 * Cost ceiling — per-call gating + caller estimate
 * ------------------------------------------------
 * Each per-wedding enrichment runs a Sonnet call (tier-1 PII). At
 * roughly $0.01-0.03 per wedding, a 1000-wedding venue is a $10-30 run.
 * The route surfaces an estimate in dryRun=true mode so the coordinator
 * can size up before greenlighting. The enrichment service itself
 * gates each call against `gateForBrainCall` — a paused venue's
 * autonomous flag will short-circuit per-row without burning the run.
 *
 * Auth
 * ----
 * Venue-scoped via `getPlatformAuth`. Caller can only sweep their own
 * venue. Demo mode is rejected (would burn real LLM cost on demo data).
 *
 * Method: POST
 *   Body: { dryRun?: boolean, limit?: number }
 *
 * Returns:
 *   {
 *     ok: true,
 *     dryRun: boolean,
 *     weddings_scanned: number,
 *     fields_updated: number,
 *     notes_added: number,
 *     skipped: number,
 *     sample: Array<{ weddingId, fieldsUpdated, notesAdded, skipReason? }>,
 *     est_cost_usd: number  // dryRun-only — Sonnet baseline estimate
 *   }
 *
 * Design parity with /api/admin/identity/upgrade-names — same auth +
 * shape so a coordinator surface can show both backfills side by side.
 *
 * Migration 253. 2026-05-09.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import {
  enrichProfileFromTouchpoints,
  type ProfileEnrichmentResult,
} from '@/lib/services/identity/profile-enrichment'

// Vercel Pro caps Functions at 300s. A 1000-wedding sweep at ~1.5s/each
// (one Sonnet call + context loads) lands around 25 minutes — too long
// for a Function. The hard limit caps the sweep to 200 weddings per
// call so the coordinator can chunk a larger backfill across multiple
// invocations. Most venues are well under 1000 active weddings; this
// is the runaway guard.
export const maxDuration = 300

const DEFAULT_LIMIT = 200
const HARD_MAX_LIMIT = 500
const SAMPLE_CAP = 50

// Per-wedding enrichment cost estimate for the dryRun reply. Sonnet
// tier-1 with ~10k input tokens + ~600 output tokens = ~$0.045 per
// call worst-case, ~$0.015 average. Use the average for the surfaced
// estimate so we don't sticker-shock coordinators who run small sweeps.
const EST_COST_PER_WEDDING_USD = 0.018

interface PostBody {
  dryRun?: boolean
  limit?: number
}

interface SampleEntry {
  weddingId: string
  fieldsUpdated: number
  notesAdded: number
  skipReason?: string
}

export async function POST(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot run profile-enrichment backfill')
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  const venueId: string = auth.venueId

  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }
  const dryRun = body.dryRun === true
  const limitRaw = typeof body.limit === 'number' ? body.limit : DEFAULT_LIMIT
  const limit = Math.max(1, Math.min(HARD_MAX_LIMIT, Math.floor(limitRaw)))

  const supabase = createServiceClient()

  // Pull every active (non-tombstoned) wedding for this venue. Same
  // active-set definition as the name-upgrade backfill.
  const { data: weddingRows, error: weddingErr } = await supabase
    .from('weddings')
    .select('id')
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (weddingErr) {
    return NextResponse.json({ ok: false, error: weddingErr.message }, { status: 500 })
  }

  const weddings = (weddingRows ?? []) as Array<{ id: string }>

  // dryRun shortcut — no LLM calls, just an estimate. The coordinator
  // sees "1000 weddings, ~$18, run?" before committing.
  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      weddings_scanned: weddings.length,
      fields_updated: 0,
      notes_added: 0,
      skipped: 0,
      sample: [],
      est_cost_usd: Number((weddings.length * EST_COST_PER_WEDDING_USD).toFixed(2)),
    })
  }

  let fieldsUpdated = 0
  let notesAdded = 0
  let skipped = 0
  const sample: SampleEntry[] = []

  for (const w of weddings) {
    let result: ProfileEnrichmentResult | null = null
    try {
      result = await enrichProfileFromTouchpoints(w.id, {
        trigger: 'admin_backfill',
        supabase,
      })
    } catch (err) {
      console.warn(
        '[enrich-profiles] sweep failed for',
        w.id,
        ':',
        err instanceof Error ? err.message : err,
      )
      continue
    }
    if (!result) continue

    if (result.skipped) {
      skipped++
      if (sample.length < SAMPLE_CAP) {
        sample.push({
          weddingId: w.id,
          fieldsUpdated: 0,
          notesAdded: 0,
          skipReason: result.skipReason ?? 'skipped',
        })
      }
      continue
    }

    fieldsUpdated += result.fieldsUpdated.length
    notesAdded += result.notesAdded.length

    if (
      sample.length < SAMPLE_CAP &&
      (result.fieldsUpdated.length > 0 || result.notesAdded.length > 0)
    ) {
      sample.push({
        weddingId: w.id,
        fieldsUpdated: result.fieldsUpdated.length,
        notesAdded: result.notesAdded.length,
      })
    }
  }

  // Coordinator-audit notification — one summary row per backfill so the
  // bell shows the rollup without per-wedding spam.
  try {
    await supabase.from('admin_notifications').insert({
      venue_id: venueId,
      type: 'profile_enrichment_backfill',
      title:
        fieldsUpdated + notesAdded === 0
          ? 'Profile-enrichment backfill — no changes'
          : `Profile-enrichment backfill — ${fieldsUpdated} fields + ${notesAdded} notes`,
      body: JSON.stringify({
        weddings_scanned: weddings.length,
        fields_updated: fieldsUpdated,
        notes_added: notesAdded,
        skipped,
      }),
      priority: 'low',
    })
  } catch (notifErr) {
    console.warn(
      '[enrich-profiles] summary notification insert failed:',
      notifErr instanceof Error ? notifErr.message : notifErr,
    )
  }

  return NextResponse.json({
    ok: true,
    dryRun: false,
    weddings_scanned: weddings.length,
    fields_updated: fieldsUpdated,
    notes_added: notesAdded,
    skipped,
    sample,
  })
}
