/**
 * Write off the freshly-backfilled Zola couples whose original inquiry
 * is more than 14 days old. The May 27 backfill (commit e33917d) minted
 * 72 lost-lead couples — most are stale (~2-12+ weeks old from the
 * pre-7d68f37 lost-leads window). Operator decision (2026-05-27):
 * anything older than 2 weeks gets marked lost / locked, so the AI
 * doesn't follow up and they drop out of active queues.
 *
 * Recently-inquired (last 14 days) stay open — they might still be
 * actively planning and worth a manual outreach decision.
 *
 * Mechanism: status='lost' + lost_at=now + lost_locked_by_operator=true
 * + a clear sage_context_notes audit string.
 *
 * Scope guard: only touches weddings that match ALL of:
 *   - venue_id = Rixey
 *   - first_touch_source / source = 'zola'
 *   - created_at within the last 6 hours (i.e. minted by today's
 *     backfill, not historical Zola couples that were already in the
 *     system)
 *   - status NOT IN ('lost', 'booked', 'completed', 'cancelled')
 *     (don't trample terminal states)
 *   - inquiry_date older than 14 days
 *
 * Usage:
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/writeoff-stale-zola-backfill.ts
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/writeoff-stale-zola-backfill.ts --apply
 */

import { createClient } from '@supabase/supabase-js'

const APPLY = process.argv.includes('--apply')
const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const STALE_DAYS = 14

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const mintedAfter = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()

  console.log('='.repeat(78))
  console.log(`writeoff-stale-zola-backfill -- ${APPLY ? 'APPLY' : 'DRY RUN'}`)
  console.log(`Window: weddings minted after ${mintedAfter} (last 6h)`)
  console.log(`Cutoff: inquiry_date BEFORE ${cutoff} (>${STALE_DAYS} days old)`)
  console.log('='.repeat(78))

  const { data: candidates, error } = await sb
    .from('weddings')
    .select('id, status, source, inquiry_date, wedding_date, created_at')
    .eq('venue_id', RIXEY_VENUE_ID)
    .eq('source', 'zola')
    .gte('created_at', mintedAfter)
    .not('status', 'in', '(lost,booked,completed,cancelled)')
    .lt('inquiry_date', cutoff)
    .order('inquiry_date', { ascending: true })
  if (error) { console.error(error); process.exit(1) }

  const list = candidates ?? []
  console.log(`\n${list.length} stale Zola backfill weddings to write off.\n`)
  if (list.length === 0) { console.log('Nothing to do.'); return }

  // Pull partner names from people table for the display roster.
  const wIds = list.map((w) => w.id)
  const { data: people } = await sb
    .from('people')
    .select('wedding_id, first_name, last_name')
    .in('wedding_id', wIds)
  const namesByWedding = new Map<string, string[]>()
  for (const p of people ?? []) {
    const arr = namesByWedding.get(p.wedding_id as string) ?? []
    arr.push(`${p.first_name ?? ''} ${p.last_name ?? ''}`.trim())
    namesByWedding.set(p.wedding_id as string, arr)
  }

  for (const w of list) {
    const ageDays = Math.round(
      (Date.now() - Date.parse(w.inquiry_date as string)) / 86_400_000,
    )
    const names = (namesByWedding.get(w.id) ?? []).filter(Boolean).join(' & ') || '(no name)'
    console.log(
      `  ${(w.inquiry_date as string).slice(0,10)} (${ageDays}d ago) | ${names.padEnd(40)} | wedding=${(w.wedding_date as string | null)?.slice(0,10) ?? '?'} | status=${w.status}`,
    )
  }

  if (!APPLY) { console.log(`\nDRY RUN. Pass --apply to write off.`); return }

  const ids = list.map((w) => w.id)
  const nowIso = new Date().toISOString()
  const noteTs = nowIso.slice(0, 10)
  const note = `${noteTs} written off by operator: stale Zola lead (>${STALE_DAYS}d since inquiry, recovered by May 27 backfill; no reply was ever sent during the pre-fix routing-bug window). AI follow-up disabled.`

  const { data: updated, error: updErr } = await sb
    .from('weddings')
    .update({
      status: 'lost',
      lost_at: nowIso,
      lost_locked_by_operator: true,
      sage_context_notes: note,
    })
    .in('id', ids)
    .eq('venue_id', RIXEY_VENUE_ID)
    .select('id')
  if (updErr) { console.error(updErr); process.exit(1) }

  console.log(`\n✓ Wrote off ${updated?.length ?? 0} stale Zola weddings.`)
  console.log(`  status=lost / lost_at=${nowIso} / lost_locked_by_operator=true`)
  console.log(`  sage_context_notes: "${note}"`)
}

main().catch((err) => { console.error(err); process.exit(1) })
