/**
 * One-shot name-upgrade backfill — sweep every active wedding for the
 * caller's venue and promote partial names ("Jen B") to full names
 * ("Jennifer Biaksangi") when a more-complete signal exists in
 * interactions / contracts / wedding text.
 *
 * Why this exists
 * ---------------
 * The live pipeline now wires `upgradePeopleNameFromTouchpoints` after
 * each inbound email. New leads upgrade themselves over time. But every
 * existing wedding — historical Knot inquiries that already have a
 * calculator email + contract sitting on file — needs a one-shot pass
 * to fix the legacy partial-name rows.
 *
 * Auth
 * ----
 * Venue-scoped via `getPlatformAuth`. The caller can only sweep their
 * own venue. Demo mode is rejected. Same shape as
 * `/api/admin/reclass-folders-ai`.
 *
 * Method: POST
 *   Body: { dryRun?: boolean, limit?: number }
 *
 * Returns:
 *   {
 *     ok: true,
 *     dryRun: boolean,
 *     weddings_scanned: number,
 *     people_upgraded: number,
 *     sample_upgrades: Array<NameUpgrade & { weddingId: string }>,
 *   }
 *
 * Each upgraded people row also receives a low-priority
 * `admin_notifications` row with type='name_upgraded' so the coordinator
 * dashboard can audit which rows changed and why. The notifications are
 * batched (one per wedding, body lists the upgrades) so a 500-wedding
 * sweep doesn't bomb the bell with hundreds of entries.
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
  upgradePeopleNameFromTouchpoints,
  type NameUpgrade,
} from '@/lib/services/identity/name-upgrade'

// Vercel Pro functions cap at 300s. A 500-wedding sweep at ~200ms each
// (4 reads + 1 write per wedding) lands around 100s, comfortably under
// the wall. We still expose `limit` so a coordinator can run a smaller
// sweep first to spot-check the upgrades.
export const maxDuration = 300

const DEFAULT_LIMIT = 1000
const HARD_MAX_LIMIT = 5000
const SAMPLE_CAP = 50

interface PostBody {
  dryRun?: boolean
  limit?: number
}

export async function POST(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot run name-upgrade backfill')
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

  // ---- Pull every active (non-tombstoned) wedding for this venue. -------
  // Active = merged_into_id IS NULL. Status filter intentionally absent;
  // even a 'lost' wedding deserves a clean name on the people row so
  // historic exports / re-engagement campaigns address them properly.
  const { data: weddingRows, error: weddingErr } = await supabase
    .from('weddings')
    .select('id')
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (weddingErr) {
    return NextResponse.json(
      { ok: false, error: weddingErr.message },
      { status: 500 },
    )
  }

  const weddings = (weddingRows ?? []) as Array<{ id: string }>

  let peopleUpgraded = 0
  const sampleUpgrades: Array<NameUpgrade & { weddingId: string }> = []

  // Per-wedding sweep. We catch per-wedding errors so one bad row can't
  // abort the entire backfill. The service itself is best-effort and
  // returns an empty result on any internal error.
  for (const w of weddings) {
    try {
      const result = await upgradePeopleNameFromTouchpoints(w.id, {
        dryRun,
        supabase,
      })
      if (result.upgrades.length === 0) continue

      peopleUpgraded += result.upgrades.length
      for (const u of result.upgrades) {
        if (sampleUpgrades.length < SAMPLE_CAP) {
          sampleUpgrades.push({ ...u, weddingId: w.id })
        }
      }

      // Log to admin_notifications for coordinator audit. One row per
      // wedding rather than per-person — keeps the bell from drowning
      // in a 500-row sweep. Skipped on dryRun.
      if (!dryRun) {
        const lines = result.upgrades
          .map(
            (u) =>
              `${u.from.first ?? ''} ${u.from.last ?? ''}`.trim() +
              ' → ' +
              `${u.to.first ?? ''} ${u.to.last ?? ''}`.trim() +
              ` (${u.source}, score=${u.confidence})`,
          )
          .join('\n')
        try {
          await supabase.from('admin_notifications').insert({
            venue_id: venueId,
            wedding_id: w.id,
            type: 'name_upgraded',
            title:
              result.upgrades.length === 1
                ? 'Name upgraded'
                : `${result.upgrades.length} names upgraded`,
            body:
              `Coordinator audit — name-upgrade backfill changed the ` +
              `following people rows on this wedding:\n\n${lines}`,
            priority: 'low',
          })
        } catch (notifErr) {
          // Notification is informational. Never let it abort the sweep.
          console.warn(
            '[upgrade-names] admin_notifications insert failed for',
            w.id,
            ':',
            notifErr instanceof Error ? notifErr.message : notifErr,
          )
        }
      }
    } catch (err) {
      console.warn(
        '[upgrade-names] wedding sweep failed for',
        w.id,
        ':',
        err instanceof Error ? err.message : err,
      )
    }
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    weddings_scanned: weddings.length,
    people_upgraded: peopleUpgraded,
    sample_upgrades: sampleUpgrades,
  })
}
