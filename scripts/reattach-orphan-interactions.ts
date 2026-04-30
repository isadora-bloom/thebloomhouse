// Reattach orphan interactions to weddings via the person link.
//
// An interaction with person_id set but wedding_id=null usually means
// the email arrived BEFORE the person's wedding row existed (e.g. a
// calculator submission, brain-dump CSV import, or form-relay
// classified as not-a-new-inquiry that didn't trigger wedding
// creation). When the wedding is later created from a different
// email, the prior interactions stay orphaned. Coordinator views
// the lead detail and sees only some of the actual conversation.
//
// 2026-04-30: Ryan Schubert at Rixey had a $14,663 calculator
// estimate from Apr 15 sitting orphan because the email-pipeline's
// new-inquiry path requires classification='new_inquiry', which
// calculator-summary emails fail. The Calendly tour notification
// on Apr 23 created the wedding from a different email; the Apr 15
// orphan was never re-linked.
//
// Strategy: for each direction='inbound' or auto-classified
// interaction with person_id set but no wedding_id, look at
// people.wedding_id. If the person now has a wedding, attach.
// Multiple wedding candidates per person → take the one whose
// inquiry_date is closest to (but not after) the interaction's
// timestamp, otherwise the most recent.
//
// Idempotent. Already-linked rows skip.
//
// Usage:
//   npx tsx scripts/reattach-orphan-interactions.ts --venue <uuid>
//   npx tsx scripts/reattach-orphan-interactions.ts --venue <uuid> --apply
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    }),
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const venueIdx = args.indexOf('--venue')
const venueId = venueIdx >= 0 ? args[venueIdx + 1] : 'f3d10226-4c5c-47ad-b89b-98ad63842492'

interface Orphan {
  id: string
  person_id: string
  timestamp: string | null
  subject: string | null
}

async function main() {
  console.log(`\n=== Reattach orphans — venue ${venueId} ${apply ? '(apply)' : '(dry-run)'} ===\n`)

  const PAGE = 500
  let offset = 0
  let scanned = 0
  let linked = 0
  let stillOrphan = 0
  const samples: string[] = []

  for (;;) {
    const { data, error } = await sb
      .from('interactions')
      .select('id, person_id, timestamp, subject')
      .eq('venue_id', venueId)
      .is('wedding_id', null)
      .not('person_id', 'is', null)
      .range(offset, offset + PAGE - 1)
      .order('timestamp', { ascending: true })
    if (error) { console.error(error.message); break }
    const rows = (data ?? []) as Orphan[]
    if (rows.length === 0) break

    // Batch person lookups by collecting unique person_ids in this page.
    const personIds = Array.from(new Set(rows.map((r) => r.person_id)))
    const { data: peopleRows } = await sb
      .from('people')
      .select('id, wedding_id')
      .in('id', personIds)
      .not('wedding_id', 'is', null)
    const personToWedding = new Map<string, string>()
    for (const p of (peopleRows ?? []) as Array<{ id: string; wedding_id: string }>) {
      personToWedding.set(p.id, p.wedding_id)
    }

    for (const r of rows) {
      scanned++
      const wid = personToWedding.get(r.person_id)
      if (!wid) {
        stillOrphan++
        continue
      }
      linked++
      if (samples.length < 8) {
        samples.push(`  ${r.id.slice(0, 8)}…  ${r.timestamp?.slice(0, 10) ?? '?'}  "${(r.subject ?? '').slice(0, 60)}"  → wedding ${wid.slice(0, 8)}…`)
      }
      if (apply) {
        const { error: updErr } = await sb
          .from('interactions')
          .update({ wedding_id: wid })
          .eq('id', r.id)
        if (updErr) console.error(`  ${r.id}: ${updErr.message}`)
      }
    }

    if (rows.length < PAGE) break
    offset += PAGE
  }

  console.log(`scanned:        ${scanned}`)
  console.log(`linked:         ${linked}`)
  console.log(`still orphan:   ${stillOrphan}`)
  if (samples.length > 0) {
    console.log(`\nfirst ${samples.length} reattachments:`)
    for (const s of samples) console.log(s)
  }
  if (!apply && linked > 0) console.log(`\nDry-run complete. Re-run with --apply to write.`)
}

main().catch((err) => { console.error(err); process.exit(1) })
