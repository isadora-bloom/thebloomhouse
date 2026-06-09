/**
 * scripts/rollback-knot-orphan-reprocess.ts
 * ==========================================
 * Revert the writes made by reprocess-knot-orphan-inquiries.ts --apply.
 *
 * WHY: the first --apply run (stopped at 62/419) used the legacy
 * `interactions.from_email` (the Knot relay address) as primary_email. ~6.5%
 * of orphans carry a MISMATCHED relay address (e.g. a "Kyle Duffy" message
 * whose from_email is `john.dubbelde.772357@member.theknot.com`), so the exact-
 * email matcher fused distinct prospects. This reverts the run so it can be
 * re-applied with name-based identity.
 *
 * WHAT IT DELETES (precise, anchored on this run's deterministic external_ids):
 *   1. This run's touchpoints: channel='knot', venue, external_id ∈ the orphan
 *      set (gmail_message_id ?? interaction.id). linkSignal is idempotent, so
 *      these external_ids did not pre-exist — every match is a this-run write.
 *   2. couple_progression_events + candidate_matches that reference those tps.
 *   3. Couples MINTED this run: any couple a deleted tp pointed to that, after
 *      the tp deletion, has ZERO remaining touchpoints AND channel_scope='knot'
 *      AND was created in the run window. Pre-existing couples (attach targets)
 *      keep all their other touchpoints and are NOT deleted.
 *   4. tracer_run_events with run_id LIKE 'reprocess:knot_orphan_inquiry%'.
 *
 * NOT reverted: last_progression_at bumps (forward-only guard meant old-dated
 * orphans rarely moved any clock; benign metadata). Re-applying corrects them.
 *
 * SAFETY: dry-run by default; --apply writes; --allow-prod required on prod.
 * USAGE: npx tsx scripts/rollback-knot-orphan-reprocess.ts [--apply --allow-prod]
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { readFileSync, existsSync } from 'node:fs'

if (existsSync('.env.local')) {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
      }),
  ) as Record<string, string>
  for (const [k, v] of Object.entries(env)) if (!process.env[k]) process.env[k] = v
}

const URL = process.env.BRANCH_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const KEY = process.env.BRANCH_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const PROD_REF = 'jsxxgwprxuqgcauzlxcb'
const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const APPLY = process.argv.includes('--apply')
const ALLOW_PROD = process.argv.includes('--allow-prod')
const VENUE_ID = process.env.BACKFILL_VENUE_ID ?? RIXEY

async function main() {
  const isProd = URL.includes(PROD_REF)
  if (APPLY && isProd && !ALLOW_PROD) {
    console.error('[rollback-knot] REFUSING --apply against prod without --allow-prod.')
    process.exit(1)
  }
  const sb: SupabaseClient = createClient(URL, KEY, { auth: { persistSession: false } })
  console.log(`[rollback-knot] mode=${APPLY ? 'APPLY' : 'DRY-RUN'} env=${isProd ? 'PROD' : 'branch'} venue=${VENUE_ID}`)

  // 1. The orphan external_id set (same derivation as the reprocess).
  const { data: orphanData } = await sb
    .from('interactions')
    .select('id, gmail_message_id')
    .eq('venue_id', VENUE_ID)
    .is('wedding_id', null)
    .eq('type', 'email')
    .eq('direction', 'inbound')
    .ilike('from_email', '%member.theknot.com%')
    .limit(5000)
  const extIds = new Set(
    ((orphanData ?? []) as Array<{ id: string; gmail_message_id: string | null }>).map(
      (o) => o.gmail_message_id ?? o.id,
    ),
  )
  console.log(`[rollback-knot] ${extIds.size} candidate external_ids from orphans.`)

  // 2. This run's touchpoints (knot + in the external_id set). NOTE:
  //    touchpoints has occurred_at, NOT created_at — selecting a missing
  //    column makes PostgREST error + return null (the v1 bug that made the
  //    rollback see 0). We anchor purely on external_id, so no timestamp needed.
  const { data: tpData, error: tpErr } = await sb
    .from('touchpoints')
    .select('id, couple_id, external_id')
    .eq('venue_id', VENUE_ID)
    .eq('channel', 'knot')
    .limit(20000)
  if (tpErr) {
    console.error('[rollback-knot] touchpoints query error:', tpErr.message)
    process.exit(1)
  }
  const runTps = ((tpData ?? []) as Array<{ id: string; couple_id: string | null; external_id: string }>).filter(
    (t) => extIds.has(t.external_id),
  )
  const tpIds = runTps.map((t) => t.id)
  const touchedCoupleIds = [...new Set(runTps.map((t) => t.couple_id).filter(Boolean) as string[])]
  console.log(`[rollback-knot] ${tpIds.length} this-run touchpoints across ${touchedCoupleIds.length} couples.`)

  // 3. Which touched couples were MINTED this run? (channel_scope='knot' AND,
  //    after removing this run's tps, zero remaining touchpoints.)
  const mintedToDelete: string[] = []
  for (const cid of touchedCoupleIds) {
    const { data: c } = await sb.from('couples').select('id, channel_scope, created_at, merged_into_id').eq('id', cid).maybeSingle()
    if (!c || (c as { channel_scope?: string }).channel_scope !== 'knot') continue
    const { count } = await sb
      .from('touchpoints')
      .select('id', { count: 'exact', head: true })
      .eq('couple_id', cid)
    const remaining = (count ?? 0) - runTps.filter((t) => t.couple_id === cid).length
    if (remaining <= 0) mintedToDelete.push(cid)
  }
  console.log(`[rollback-knot] ${mintedToDelete.length} minted couples to delete (zero non-run touchpoints).`)
  console.log(`[rollback-knot] ${touchedCoupleIds.length - mintedToDelete.length} pre-existing couples keep (only the run tp removed).`)

  if (!APPLY) {
    console.log('\n[rollback-knot] DRY-RUN — would delete:')
    console.log(`    touchpoints: ${tpIds.length}`)
    console.log(`    minted couples: ${mintedToDelete.length}`)
    console.log(`    + their couple_progression_events / candidate_matches / tracer_run_events(reprocess:knot%)`)
    console.log('  Re-run with --apply --allow-prod to delete.')
    return
  }

  // 4. Delete children first, then tps, then minted couples, then telemetry.
  const chunk = <T,>(a: T[], n = 100) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n))
  for (const ids of chunk(tpIds)) {
    await sb.from('couple_progression_events').delete().in('source_touchpoint_id', ids)
    await sb.from('candidate_matches').delete().in('secondary_record_id', ids).eq('secondary_record_type', 'touchpoint')
  }
  for (const ids of chunk(tpIds)) {
    await sb.from('touchpoints').delete().in('id', ids)
  }
  for (const ids of chunk(mintedToDelete)) {
    // candidate_matches that referenced a minted couple as primary/secondary.
    await sb.from('candidate_matches').delete().in('primary_record_id', ids).eq('primary_record_type', 'couple')
    await sb.from('couple_progression_events').delete().in('couple_id', ids)
    await sb.from('couples').delete().in('id', ids)
  }
  // telemetry for this source.
  await sb.from('tracer_run_events').delete().eq('venue_id', VENUE_ID).like('run_id', 'reprocess:knot_orphan_inquiry%')

  console.log(`\n[rollback-knot] APPLIED — deleted ${tpIds.length} touchpoints + ${mintedToDelete.length} minted couples + their children + telemetry.`)
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('[rollback-knot] fatal:', e)
    process.exit(1)
  },
)
