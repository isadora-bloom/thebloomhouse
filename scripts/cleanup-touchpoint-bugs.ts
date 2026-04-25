// One-shot cleanup for two data bugs surfaced by the Phase 1 self-review:
//
// Bug 1 — duplicate inquiry touchpoints. Three writers (migration 079
// backfill, live pipeline, backfill-touchpoints.ts) each used a different
// timestamp for the same inquiry, so dedup on (wedding,type,occurred_at)
// missed the dupes. Rixey ended up with 265 inquiry rows for 167
// weddings (98 dupes). Live code was patched (ONE_PER_WEDDING_TOUCH_TYPES
// dedups inquiry by type alone). This deletes the historical extras —
// keep the earliest occurred_at per wedding. Same pass runs for
// 'contract_signed' as a guard, even though no dupes exist there yet.
//
// Bug 2 — booked weddings with no contract_signed touchpoint. 21 Rixey
// weddings reached status='booked' via Calendly final_walkthrough /
// planning_meeting events that (correctly) don't map to a funnel
// touch_type. Live code was patched (recordStatusChangeTouchpoint fires
// on every status update). This backfills the historical gap — for
// every booked/completed wedding without a contract_signed touchpoint,
// insert one using booked_at (or updated_at fallback) as occurred_at
// and the wedding's first-touch source.
//
// Idempotent: re-running the script after a clean pass is a no-op.
//
// Usage:
//   npx tsx scripts/cleanup-touchpoint-bugs.ts                # dry-run
//   npx tsx scripts/cleanup-touchpoint-bugs.ts --apply
//   npx tsx scripts/cleanup-touchpoint-bugs.ts --apply --all  # every real venue
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
  })
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const APPLY = process.argv.includes('--apply')
const ALL = process.argv.includes('--all')
const venueIdx = process.argv.indexOf('--venue')
const CLI_VENUE = venueIdx >= 0 ? process.argv[venueIdx + 1] : null

const ONE_PER_WEDDING: Array<'inquiry' | 'contract_signed'> = ['inquiry', 'contract_signed']

async function dedupOnePerWedding(venueId: string) {
  const allDeleteIds: string[] = []
  const summary: Record<string, { weddings: number; deleted: number }> = {}

  for (const tt of ONE_PER_WEDDING) {
    const { data: rows } = await sb
      .from('wedding_touchpoints')
      .select('id, wedding_id, occurred_at, created_at')
      .eq('venue_id', venueId)
      .eq('touch_type', tt)
      .order('occurred_at', { ascending: true })

    const byWedding = new Map<string, Array<{ id: string; occurred_at: string; created_at: string }>>()
    for (const r of (rows ?? []) as Array<{ id: string; wedding_id: string; occurred_at: string; created_at: string }>) {
      const arr = byWedding.get(r.wedding_id) ?? []
      arr.push({ id: r.id, occurred_at: r.occurred_at, created_at: r.created_at })
      byWedding.set(r.wedding_id, arr)
    }

    let weddingsWithDupes = 0
    let toDelete = 0
    for (const [, arr] of byWedding) {
      if (arr.length <= 1) continue
      weddingsWithDupes++
      // arr is already ordered by occurred_at asc — keep [0], delete the rest
      for (let i = 1; i < arr.length; i++) {
        allDeleteIds.push(arr[i].id)
        toDelete++
      }
    }
    summary[tt] = { weddings: weddingsWithDupes, deleted: toDelete }
  }

  console.log(`  [dedup] inquiry:         ${summary.inquiry.weddings} weddings, delete ${summary.inquiry.deleted}`)
  console.log(`  [dedup] contract_signed: ${summary.contract_signed.weddings} weddings, delete ${summary.contract_signed.deleted}`)

  if (!APPLY || allDeleteIds.length === 0) return

  for (let i = 0; i < allDeleteIds.length; i += 200) {
    const chunk = allDeleteIds.slice(i, i + 200)
    const { error } = await sb.from('wedding_touchpoints').delete().in('id', chunk)
    if (error) {
      console.error(`  [dedup] delete failed at chunk ${i}: ${error.message}`)
      return
    }
  }
  console.log(`  [dedup] deleted ${allDeleteIds.length} duplicate rows.`)
}

async function backfillBookedContractSigned(venueId: string) {
  const { data: weddings } = await sb
    .from('weddings')
    .select('id, source, status, booked_at, updated_at, created_at')
    .eq('venue_id', venueId)
    .in('status', ['booked', 'completed'])

  const weddingList = (weddings ?? []) as Array<{
    id: string; source: string | null; status: string;
    booked_at: string | null; updated_at: string; created_at: string
  }>
  if (weddingList.length === 0) {
    console.log(`  [backfill] no booked/completed weddings.`)
    return
  }

  const { data: existing } = await sb
    .from('wedding_touchpoints')
    .select('wedding_id')
    .eq('venue_id', venueId)
    .eq('touch_type', 'contract_signed')
    .in('wedding_id', weddingList.map((w) => w.id))

  const haveContractSigned = new Set<string>(((existing ?? []) as Array<{ wedding_id: string }>).map((r) => r.wedding_id))

  type Plan = {
    venue_id: string; wedding_id: string; touch_type: 'contract_signed';
    source: string | null; medium: string; occurred_at: string;
    metadata: Record<string, unknown>
  }
  const toInsert: Plan[] = []
  for (const w of weddingList) {
    if (haveContractSigned.has(w.id)) continue
    const occurredAt = w.booked_at ?? w.updated_at ?? w.created_at
    if (!occurredAt) continue
    toInsert.push({
      venue_id: venueId,
      wedding_id: w.id,
      touch_type: 'contract_signed',
      source: w.source,
      medium: 'backfill',
      occurred_at: occurredAt,
      metadata: { backfill_reason: 'booked_status_no_touchpoint', from_status: w.status },
    })
  }

  console.log(`  [backfill] booked weddings: ${weddingList.length}`)
  console.log(`  [backfill] already have contract_signed: ${weddingList.length - toInsert.length}`)
  console.log(`  [backfill] to insert: ${toInsert.length}`)

  if (!APPLY || toInsert.length === 0) return

  for (let i = 0; i < toInsert.length; i += 200) {
    const chunk = toInsert.slice(i, i + 200)
    const { error } = await sb.from('wedding_touchpoints').insert(chunk)
    if (error) {
      console.error(`  [backfill] insert failed at chunk ${i}: ${error.message}`)
      return
    }
  }
  console.log(`  [backfill] inserted ${toInsert.length} contract_signed touchpoints.`)
}

async function runVenue(venueId: string) {
  console.log(`\n=== Venue ${venueId.slice(0, 8)} — ${APPLY ? 'APPLY' : 'DRY RUN'} ===`)
  await dedupOnePerWedding(venueId)
  await backfillBookedContractSigned(venueId)
}

async function main() {
  let venueIds: string[] = [CLI_VENUE ?? RIXEY]
  if (ALL) {
    const { data: vs } = await sb.from('venues').select('id, is_demo').eq('is_demo', false)
    venueIds = ((vs ?? []) as Array<{ id: string }>).map((v) => v.id)
  }
  for (const vid of venueIds) await runVenue(vid)
}

main().catch((err) => { console.error(err); process.exit(1) })
