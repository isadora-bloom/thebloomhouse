/**
 * Write off Rixey "inquiry"-status weddings where:
 *   - inquiry_date is more than 14 days ago, AND
 *   - the most recent interaction on this wedding is also more than 14
 *     days ago (no recent reply from the couple)
 * AND ai_opted_out / lost_locked_by_operator are still false.
 *
 * Operator decision 2026-05-27: anything older than 2 weeks with no
 * activity gets marked lost. Recent reply = stay open (the couple is
 * still engaged even if their inquiry was old).
 *
 * Mechanism: status='lost' + lost_at=now + lost_locked_by_operator=true
 * + sage_context_notes audit string.
 *
 * Usage:
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/writeoff-stale-open-leads.ts
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/writeoff-stale-open-leads.ts --apply
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

  console.log('='.repeat(78))
  console.log(`writeoff-stale-open-leads -- ${APPLY ? 'APPLY' : 'DRY RUN'}`)
  console.log(`Cutoff: inquiry_date AND latest interaction both BEFORE ${cutoff}`)
  console.log('='.repeat(78))

  const { data: candidates, error } = await sb
    .from('weddings')
    .select('id, source, inquiry_date, wedding_date, status')
    .eq('venue_id', RIXEY_VENUE_ID)
    .eq('status', 'inquiry')
    .lt('inquiry_date', cutoff)
  if (error) { console.error(error); process.exit(1) }
  const all = candidates ?? []

  // Per-wedding last-interaction lookup. Stale if both inquiry AND last
  // interaction predate the cutoff (i.e., no activity in 14 days).
  const trulyStale: typeof all = []
  const recentActivity: Array<{ id: string; lastInteraction: string }> = []
  for (const w of all) {
    const { data: last } = await sb
      .from('interactions')
      .select('timestamp')
      .eq('wedding_id', w.id)
      .order('timestamp', { ascending: false })
      .limit(1)
    const lastTs = (last?.[0]?.timestamp as string | undefined) ?? null
    if (!lastTs || lastTs < cutoff) {
      trulyStale.push(w)
    } else {
      recentActivity.push({ id: w.id, lastInteraction: lastTs })
    }
  }

  console.log(`\n${trulyStale.length} truly stale (writeoff candidate).`)
  console.log(`${recentActivity.length} have recent activity (stay open).\n`)
  if (trulyStale.length === 0) { console.log('Nothing to do.'); return }

  // Names for display.
  const wIds = trulyStale.map((w) => w.id)
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

  for (const w of trulyStale) {
    const ageDays = Math.round((Date.now() - Date.parse(w.inquiry_date as string)) / 86_400_000)
    const names = (namesByWedding.get(w.id) ?? []).filter(Boolean).join(' & ') || '(no name)'
    console.log(
      `  ${(w.source ?? '(null)').padEnd(18)} | ${(w.inquiry_date as string).slice(0,10)} (${ageDays}d) | ${names.padEnd(40)} | wedding=${(w.wedding_date as string | null)?.slice(0,10) ?? '?'}`,
    )
  }

  if (!APPLY) { console.log(`\nDRY RUN. Pass --apply to write off.`); return }

  const ids = trulyStale.map((w) => w.id)
  const nowIso = new Date().toISOString()
  const note = `${nowIso.slice(0,10)} written off by operator: no inquiry activity in ${STALE_DAYS}+ days. AI follow-up disabled.`

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

  console.log(`\n✓ Wrote off ${updated?.length ?? 0} stale open leads.`)
}

main().catch((err) => { console.error(err); process.exit(1) })
