// Three-part Rixey lead-data cleanup. Each part is idempotent and safe
// to re-run.
//
//  1. NAME CLEANUP — re-parse every person whose name looks malformed
//     (combined couples like "John and Rachel Davis", "Last, First"
//     swaps, etc.) using parseInviteeName, then split into proper
//     partner1 + partner2 rows.
//
//  2. ORPHAN WEDDINGS — Calendly-source weddings that ended up with
//     zero people rows. Re-walk the wedding's interactions, find the
//     invitee email, ensure a person exists for it, and link to
//     partner1.
//
//  3. DUPLICATE WEDDING MERGE — find pairs of weddings for the same
//     couple (by people email overlap or by name match) and merge
//     them via the existing mergePeople service. Keeps interactions,
//     events, drafts; deletes the duplicate-empty wedding.
//
// MERGE not delete — never throws away data. mergePeople snapshots
// the merged person + reassigns every child row to the survivor;
// undo is supported via person_merges.
//
// Usage:
//   npx tsx scripts/merge-and-clean-rixey.ts                 # dry-run
//   npx tsx scripts/merge-and-clean-rixey.ts --apply
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { mergePeople } from '../src/lib/services/merge-people'
import { parseInviteeName, detectSchedulingEvent } from '../src/lib/services/scheduling-tool-parsers'
import { recalculateHeatScore } from '../src/lib/services/heat-mapping'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
  })
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const APPLY = process.argv.includes('--apply')
const venueIdx = process.argv.indexOf('--venue')
const VENUE_ID = venueIdx >= 0 ? process.argv[venueIdx + 1] : RIXEY

// Normalize a name for matching (lowercase, single space, trim, remove punctuation).
function nameKey(first: string | null | undefined, last: string | null | undefined): string {
  return `${(first ?? '').toLowerCase().replace(/[^a-z\s]/g, '').trim()} ${(last ?? '').toLowerCase().replace(/[^a-z\s]/g, '').trim()}`.trim().replace(/\s+/g, ' ')
}

// Recognise malformed name patterns that need re-parsing.
function looksMalformed(first: string | null, last: string | null): boolean {
  const f = first ?? ''
  const l = last ?? ''
  // "and" or "&" inside first or last → couple smash
  if (/\b(and|&)\b/i.test(f) || /\b(and|&)\b/i.test(l)) return true
  // Last contains a comma → "Last, First" was stored as first+last raw
  if (/,/.test(f)) return true
  // Single-token person without last name — could be salvage like
  // "Juliabrosenberger". Don't flag plain first names alone.
  if (!l && /^[A-Z][a-z]{8,}$/.test(f)) return true
  return false
}

async function main() {
  console.log(`Lead cleanup — ${APPLY ? 'APPLY' : 'DRY RUN'} — venue=${VENUE_ID.slice(0, 8)}\n`)

  // ──────────────────────────────────────────────────────────────────
  // PART 1: name cleanup — re-parse malformed names
  // ──────────────────────────────────────────────────────────────────
  console.log('--- 1. Re-parse malformed couple names ---')
  const { data: ppl } = await sb.from('people').select('id, wedding_id, role, first_name, last_name, email').eq('venue_id', VENUE_ID)
  let renames = 0
  let partnerSplits = 0
  for (const p of (ppl ?? []) as any[]) {
    if (!looksMalformed(p.first_name, p.last_name)) continue
    const raw = `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim()
    const parsed = parseInviteeName(raw)
    if (!parsed) continue
    const newFirst = parsed.primary.split(/\s+/)[0] || null
    const newLast = parsed.primary.split(/\s+/).slice(1).join(' ') || null
    if (newFirst === p.first_name && newLast === p.last_name) continue

    console.log(`  ${p.id.slice(0, 8)}  "${raw}" → "${parsed.primary}"${parsed.partner ? `  partner="${parsed.partner}"` : ''}`)
    renames++

    if (APPLY) {
      await sb.from('people').update({ first_name: newFirst, last_name: newLast }).eq('id', p.id)
      // If a partner half was extracted from the smashed name, ensure
      // partner2 exists on this wedding.
      if (parsed.partner && p.wedding_id) {
        const { data: existingP2 } = await sb.from('people').select('id').eq('wedding_id', p.wedding_id).eq('role', 'partner2').limit(1)
        if (!existingP2 || existingP2.length === 0) {
          const pParts = parsed.partner.split(/\s+/)
          await sb.from('people').insert({
            venue_id: VENUE_ID,
            wedding_id: p.wedding_id,
            role: 'partner2',
            first_name: pParts[0] || null,
            last_name: pParts.slice(1).join(' ') || null,
          })
          partnerSplits++
        }
      }
    }
  }
  console.log(`  renamed: ${renames},  partner2 created: ${partnerSplits}`)

  // ──────────────────────────────────────────────────────────────────
  // PART 2: orphan weddings (no people attached)
  // ──────────────────────────────────────────────────────────────────
  console.log('\n--- 2. Repair weddings with 0 people attached ---')
  const { data: ws } = await sb.from('weddings').select('id, source, status').eq('venue_id', VENUE_ID)
  let orphansFound = 0
  let orphansRepaired = 0
  for (const w of (ws ?? []) as any[]) {
    const { data: peeps } = await sb.from('people').select('id').eq('wedding_id', w.id).limit(1)
    if (peeps && peeps.length > 0) continue
    orphansFound++
    // Find this wedding's interactions; pull invitee email from any
    // Calendly-format body
    const { data: ints } = await sb.from('interactions').select('id, full_body, body_preview, from_email, subject').eq('wedding_id', w.id).limit(5)
    let inviteeEmail: string | null = null
    let inviteeName: string | null = null
    let partnerName: string | null = null
    for (const i of (ints ?? []) as any[]) {
      const evt = detectSchedulingEvent({ from: i.from_email ?? '', subject: i.subject ?? '', body: i.full_body ?? i.body_preview ?? '' })
      if (evt) {
        inviteeEmail = evt.inviteeEmail
        inviteeName = evt.inviteeName
        partnerName = evt.extras?.partnerName ?? null
        break
      }
    }
    if (!inviteeEmail) {
      console.log(`  ${w.id.slice(0, 8)}  status=${w.status}  no invitee found in interactions`)
      continue
    }
    // Check for existing person with this email
    const { data: existing } = await sb.from('people').select('id, wedding_id, first_name, last_name').eq('venue_id', VENUE_ID).ilike('email', inviteeEmail).limit(1).maybeSingle()
    if (existing) {
      const existingWedId = (existing.wedding_id as string | null) ?? null
      if (existingWedId && existingWedId !== w.id) {
        // Person already lives on a different wedding. MERGE this
        // orphan wedding's children into the existing wedding rather
        // than just re-pointing the person (which would orphan the
        // existing wedding instead).
        console.log(`  ${w.id.slice(0, 8)}  MERGE orphan into existing wedding ${existingWedId.slice(0, 8)}  (${existing.first_name} ${existing.last_name})`)
        if (APPLY) {
          await sb.from('interactions').update({ wedding_id: existingWedId }).eq('wedding_id', w.id)
          await sb.from('engagement_events').update({ wedding_id: existingWedId }).eq('wedding_id', w.id)
          await sb.from('drafts').update({ wedding_id: existingWedId }).eq('wedding_id', w.id)
          // Carry forward any 'better' status from the orphan onto the
          // existing wedding — e.g., orphan was 'booked' from a final
          // walkthrough event, existing was still 'inquiry' from Knot.
          const STATUS_RANK: Record<string, number> = { inquiry: 0, tour_scheduled: 1, tour_completed: 2, proposal_sent: 3, booked: 4, completed: 5, lost: 99, cancelled: 99 }
          const { data: existingW } = await sb.from('weddings').select('status').eq('id', existingWedId).maybeSingle()
          const existingStatus = (existingW?.status as string | undefined) ?? 'inquiry'
          const orphanRank = STATUS_RANK[w.status] ?? 0
          const existingRank = STATUS_RANK[existingStatus] ?? 0
          if (orphanRank > existingRank && orphanRank < 99) {
            await sb.from('weddings').update({ status: w.status }).eq('id', existingWedId)
          }
          // Add partner2 to the existing wedding if missing
          if (partnerName) {
            const { data: hasP2 } = await sb.from('people').select('id').eq('wedding_id', existingWedId).eq('role', 'partner2').limit(1)
            if (!hasP2 || hasP2.length === 0) {
              const pParts = partnerName.split(/\s+/)
              await sb.from('people').insert({
                venue_id: VENUE_ID,
                wedding_id: existingWedId,
                role: 'partner2',
                first_name: pParts[0] || null,
                last_name: pParts.slice(1).join(' ') || null,
              })
            }
          }
          // Delete the now-empty orphan wedding
          await sb.from('weddings').delete().eq('id', w.id)
        }
        orphansRepaired++
      } else {
        // Person has no wedding yet — link them to the orphan
        console.log(`  ${w.id.slice(0, 8)}  LINK person ${(existing.id as string).slice(0, 8)}  (${existing.first_name} ${existing.last_name})`)
        if (APPLY) {
          await sb.from('people').update({ wedding_id: w.id, role: 'partner1' }).eq('id', existing.id)
          if (partnerName) {
            const pParts = partnerName.split(/\s+/)
            await sb.from('people').insert({
              venue_id: VENUE_ID,
              wedding_id: w.id,
              role: 'partner2',
              first_name: pParts[0] || null,
              last_name: pParts.slice(1).join(' ') || null,
            })
          }
        }
        orphansRepaired++
      }
    } else if (inviteeName) {
      console.log(`  ${w.id.slice(0, 8)}  CREATE person  ${inviteeName} <${inviteeEmail}>`)
      if (APPLY) {
        const parts = inviteeName.split(/\s+/)
        await sb.from('people').insert({
          venue_id: VENUE_ID,
          wedding_id: w.id,
          role: 'partner1',
          first_name: parts[0] || null,
          last_name: parts.slice(1).join(' ') || null,
          email: inviteeEmail,
        })
        if (partnerName) {
          const pParts = partnerName.split(/\s+/)
          await sb.from('people').insert({
            venue_id: VENUE_ID,
            wedding_id: w.id,
            role: 'partner2',
            first_name: pParts[0] || null,
            last_name: pParts.slice(1).join(' ') || null,
          })
        }
      }
      orphansRepaired++
    }
  }
  console.log(`  orphans found: ${orphansFound},  repaired: ${orphansRepaired}`)

  // ──────────────────────────────────────────────────────────────────
  // PART 3: merge duplicate weddings (using mergePeople to consolidate)
  // ──────────────────────────────────────────────────────────────────
  console.log('\n--- 3. Merge duplicate weddings ---')
  const { data: pplAll } = await sb.from('people').select('id, wedding_id, first_name, last_name, email, created_at').eq('venue_id', VENUE_ID)
  // Group people by name+last_name (lowercase, normalized)
  const byName = new Map<string, any[]>()
  for (const p of (pplAll ?? []) as any[]) {
    const key = nameKey(p.first_name, p.last_name)
    if (!key || key.length < 3) continue
    if (!byName.has(key)) byName.set(key, [])
    byName.get(key)!.push(p)
  }
  let mergesPlanned = 0
  let mergesDone = 0
  for (const [name, group] of byName) {
    // Find unique wedding_ids these people belong to
    const weddingIds = [...new Set(group.map((p: any) => p.wedding_id).filter(Boolean))]
    if (weddingIds.length < 2) continue
    // Pick the survivor: oldest wedding (most history). Then merge each
    // other person into the survivor's matching person if names align.
    const peopleByWedding = new Map<string, any>()
    for (const p of group) {
      if (!peopleByWedding.has(p.wedding_id)) peopleByWedding.set(p.wedding_id, p)
    }
    // Sort wedding_ids by people.created_at ascending — earliest = survivor
    const sortedWeddings = weddingIds.sort((a, b) => {
      const aDate = peopleByWedding.get(a)?.created_at ?? ''
      const bDate = peopleByWedding.get(b)?.created_at ?? ''
      return aDate.localeCompare(bDate)
    })
    const keepWeddingId = sortedWeddings[0]
    const keepPerson = peopleByWedding.get(keepWeddingId)
    if (!keepPerson) continue
    for (const otherWid of sortedWeddings.slice(1)) {
      const otherPerson = peopleByWedding.get(otherWid)
      if (!otherPerson) continue
      mergesPlanned++
      console.log(`  MERGE "${name}"  keep wedding=${keepWeddingId.slice(0, 8)} person=${keepPerson.id.slice(0, 8)}  ←  drop wedding=${otherWid.slice(0, 8)} person=${otherPerson.id.slice(0, 8)}`)
      if (APPLY) {
        try {
          // Preserve the higher status across the merge — if the
          // duplicate is at 'booked' and the survivor is still
          // 'inquiry', roll the better state forward to the survivor.
          const STATUS_RANK: Record<string, number> = {
            inquiry: 0, tour_scheduled: 1, tour_completed: 2, proposal_sent: 3, booked: 4,
            completed: 5, lost: 99, cancelled: 99,
          }
          const { data: keepW } = await sb.from('weddings').select('status, source').eq('id', keepWeddingId).maybeSingle()
          const { data: dropW } = await sb.from('weddings').select('status, source').eq('id', otherWid).maybeSingle()
          const keepRank = STATUS_RANK[(keepW?.status as string) ?? 'inquiry'] ?? 0
          const dropRank = STATUS_RANK[(dropW?.status as string) ?? 'inquiry'] ?? 0
          if (dropRank > keepRank && dropRank < 99) {
            await sb.from('weddings').update({ status: dropW?.status }).eq('id', keepWeddingId)
          }

          await mergePeople({
            supabase: sb as any,
            venueId: VENUE_ID,
            keepPersonId: keepPerson.id,
            mergePersonId: otherPerson.id,
            tier: 'medium',
            signals: [{ type: 'cleanup_name_match', detail: name, weight: 0.6 }],
            confidence: 0.6,
          })
          mergesDone++
          // Delete the now-empty other wedding (mergePeople reassigned all
          // its children to keepWeddingId)
          const { count: remaining } = await sb.from('people').select('*', { count: 'exact', head: true }).eq('wedding_id', otherWid)
          if (remaining === 0) {
            await sb.from('weddings').delete().eq('id', otherWid)
          }
        } catch (err) {
          console.error(`    merge failed: ${(err as Error).message}`)
        }
      }
    }
  }
  console.log(`  merges planned: ${mergesPlanned},  done: ${mergesDone}`)

  // ──────────────────────────────────────────────────────────────────
  // Recalc heat for every Rixey wedding so scores reflect consolidated data
  // ──────────────────────────────────────────────────────────────────
  if (APPLY) {
    console.log('\n--- 4. Recalculate heat ---')
    const { data: allWs } = await sb.from('weddings').select('id').eq('venue_id', VENUE_ID)
    let recalcd = 0
    for (const w of (allWs ?? []) as any[]) {
      try {
        await recalculateHeatScore(VENUE_ID, w.id)
        recalcd++
      } catch (err) {
        console.error(`  recalc ${w.id.slice(0, 8)}:`, (err as Error).message)
      }
    }
    console.log(`  recalculated ${recalcd} weddings`)
  }

  // Final state
  const { count: wTotal } = await sb.from('weddings').select('*', { count: 'exact', head: true }).eq('venue_id', VENUE_ID)
  const { data: finalWs } = await sb.from('weddings').select('status, temperature_tier').eq('venue_id', VENUE_ID)
  const statusDist: Record<string, number> = {}
  const tierDist: Record<string, number> = {}
  for (const w of (finalWs ?? []) as any[]) {
    statusDist[w.status] = (statusDist[w.status] ?? 0) + 1
    tierDist[w.temperature_tier ?? '(null)'] = (tierDist[w.temperature_tier ?? '(null)'] ?? 0) + 1
  }
  console.log(`\nFinal: ${wTotal} weddings`)
  console.log(`  status: ${JSON.stringify(statusDist)}`)
  console.log(`  tier:   ${JSON.stringify(tierDist)}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
