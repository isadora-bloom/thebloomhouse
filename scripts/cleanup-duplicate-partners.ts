/**
 * cleanup-duplicate-partners.ts
 *
 * One-off + reusable cleanup for weddings that ended up with more than
 * two live (non-tombstoned) `people` rows. A wedding is a couple and may
 * carry at most two people: role partner1 + role partner2.
 *
 * Root cause (fixed in profile-to-people-sync.ts on 2026-05-15): the
 * profile->people sync's partner1_created / partner2_created branches
 * fired a blind INSERT whenever loadPartners() saw no row for the role.
 * Because loadPartners filters role IN ('partner1','partner2'), and
 * because reconstruction can run mid-merge, that blind insert produced
 * duplicate partner rows. The code fix makes those branches
 * match-and-update; this script repairs the rows that already drifted.
 *
 * For each affected wedding it:
 *   1. Groups live people, picks one keeper per role (most identifiers
 *      win: email > phone > last_name > earliest created_at).
 *   2. mergePeople()s every extra row into the keeper of the same role
 *      (or into partner1 when the extra has no role / no identifiers).
 *   3. Re-roles the survivors so the wedding has exactly partner1 +
 *      partner2 (earliest-created survivor -> partner1).
 *
 * Usage:
 *   node node_modules/tsx/dist/cli.mjs scripts/cleanup-duplicate-partners.ts            (dry run)
 *   node node_modules/tsx/dist/cli.mjs scripts/cleanup-duplicate-partners.ts --apply    (apply)
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { mergePeople } from '../src/lib/services/identity/merge-people'

const env: Record<string, string> = {}
for (const line of readFileSync('.env.production', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (!m) continue
  let v = m[2].trim()
  if (v.startsWith('"')) v = v.slice(1)
  if (v.endsWith('"')) v = v.slice(0, -1)
  env[m[1]] = v.split('\\')[0].trim()
}

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const VENUE = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const APPLY = process.argv.includes('--apply')

interface Person {
  id: string
  role: string | null
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  created_at: string
  name_confidence: number | null
}

/** A populated-ness score so the keeper is the richest row. */
function richness(p: Person): number {
  let s = 0
  if (p.email) s += 1000
  if (p.phone) s += 100
  if (p.last_name) s += 10
  if (p.first_name) s += 1
  return s
}

async function main() {
  console.log(APPLY ? '=== APPLY MODE ===' : '=== DRY RUN (pass --apply to execute) ===')

  const { data: weddings } = await supabase
    .from('weddings')
    .select('id, status')
    .eq('venue_id', VENUE)
    .is('merged_into_id', null)
    .in('status', ['booked', 'completed'])

  let fixedWeddings = 0
  let mergeCount = 0

  for (const w of weddings ?? []) {
    const { data: rows } = await supabase
      .from('people')
      .select('id, role, first_name, last_name, email, phone, created_at, name_confidence')
      .eq('wedding_id', w.id)
      .is('merged_into_id', null)
      .order('created_at', { ascending: true })
    const people = (rows ?? []) as Person[]
    if (people.length <= 2) continue

    fixedWeddings += 1
    console.log(`\nWEDDING ${w.id} (status=${w.status}) has ${people.length} live people:`)
    for (const p of people) {
      console.log(
        `  ${p.id} role=${p.role} name=${JSON.stringify(p.first_name)} ${JSON.stringify(p.last_name)} ` +
          `email=${p.email ?? '-'} phone=${p.phone ?? '-'} created=${p.created_at}`,
      )
    }

    // Pick the single best keeper for the whole wedding's "partner1" and
    // "partner2" slots. Strategy: the two richest rows survive; everything
    // else merges into the nearer survivor. The richest survivor by
    // created_at order becomes partner1.
    const sorted = [...people].sort((a, b) => {
      const r = richness(b) - richness(a)
      if (r !== 0) return r
      return a.created_at.localeCompare(b.created_at)
    })
    const survivors = sorted.slice(0, 2)
    const losers = sorted.slice(2)

    // partner1 = earliest-created survivor, partner2 = the other.
    const survByCreated = [...survivors].sort((a, b) => a.created_at.localeCompare(b.created_at))
    const partner1 = survByCreated[0]
    const partner2 = survByCreated[1]

    console.log(
      `  PLAN keep partner1=${partner1.id} (${partner1.first_name} ${partner1.last_name}), ` +
        `partner2=${partner2.id} (${partner2.first_name} ${partner2.last_name})`,
    )

    // Merge each loser into the survivor it best resembles: same role if
    // possible, else same first name, else partner1.
    for (const loser of losers) {
      let keeper = partner1
      if (loser.role === 'partner2') keeper = partner2
      else if (
        loser.first_name &&
        partner2.first_name &&
        loser.first_name.trim().toLowerCase() === partner2.first_name.trim().toLowerCase()
      ) {
        keeper = partner2
      } else if (
        loser.first_name &&
        partner1.first_name &&
        loser.first_name.trim().toLowerCase() === partner1.first_name.trim().toLowerCase()
      ) {
        keeper = partner1
      }
      console.log(
        `  MERGE loser=${loser.id} (${loser.first_name} ${loser.last_name}) -> keeper=${keeper.id}`,
      )
      if (APPLY) {
        const res = await mergePeople({
          supabase,
          venueId: VENUE,
          keepPersonId: keeper.id,
          mergePersonId: loser.id,
          tier: 'high',
          signals: [
            {
              type: 'duplicate_partner_cleanup',
              detail:
                'wedding had >2 live people; duplicate partner row created by pre-2026-05-15 ' +
                'profile-to-people-sync blind insert',
              weight: 1,
            },
          ],
          mergedBy: 'system:cleanup-duplicate-partners',
        })
        console.log(`    merged (mergeId=${res.mergeId}, reassigned=${JSON.stringify(res.reassignedCounts)})`)
      }
      mergeCount += 1
    }

    // Ensure final roles are exactly partner1 + partner2.
    if (APPLY) {
      await supabase.from('people').update({ role: 'partner1' }).eq('id', partner1.id)
      await supabase.from('people').update({ role: 'partner2' }).eq('id', partner2.id)
      console.log('  roles normalised: partner1 + partner2')
    } else {
      console.log(`  WOULD set ${partner1.id}->partner1, ${partner2.id}->partner2`)
    }
  }

  console.log(
    `\n=== ${APPLY ? 'DONE' : 'DRY RUN COMPLETE'}: ${fixedWeddings} weddings, ${mergeCount} merges ===`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
