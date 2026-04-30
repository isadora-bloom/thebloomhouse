// Split WeddingWire-conflated weddings — where 2+ different prospects
// were collapsed into one wedding row because they all share the same
// shared relay address (messages@weddingwire.com).
//
// 2026-04-30: Rixey had 10 distinct WW prospects (Aidan Henry,
// Addison Montgomery, Emily mayle, Stefanie Short, Natalie Terlitsky,
// Nicole, Rachael Fine, Kellie Phillis, Gloria Valeri, etc.) all on
// one wedding. Coordinator's lead detail showed "30 events" for what
// should have been 10 separate ~3-event leads.
//
// Strategy:
//   1. For each WW interaction, re-parse to extract authsolic token
//      + prospect name
//   2. Group interactions by (venue_id, authsolic)
//   3. For groups whose interactions sit on a wedding shared with
//      OTHER groups (the conflated case), create a fresh wedding +
//      person row for the group and move its interactions.
//      The original wedding stays for whichever group inquired first
//      (preserves heat/attribution for that prospect).
//
// Idempotent. Already-split prospects (their own wedding, no
// shared) are no-ops.
//
// Usage:
//   npx tsx scripts/split-ww-conflated-weddings.ts --venue <uuid>
//   npx tsx scripts/split-ww-conflated-weddings.ts --venue <uuid> --apply
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

function extractAuthsolic(body: string): string | null {
  const m = body.match(/authsolic(?:%3D|=)([a-zA-Z0-9]{12,})/i)
  return m ? m[1].toLowerCase() : null
}

function extractName(subject: string, body: string): string | null {
  const sent = subject.match(/(?:📩\s*)?([A-Z][\w'.-]+(?:\s+[\w'.-]+){0,3}?)\s+(?:sent you|is waiting|wants to)/i)
  if (sent) return sent[1].trim()
  const hanging = subject.match(/Don['']?t\s+leave\s+([A-Z][\w'.-]+(?:\s+[\w'.-]+){0,3}?)\s+hanging/i)
  if (hanging) return hanging[1].trim()
  const says = body.match(/^([A-Z][\w'.-]+(?:\s+[\w'.-]+){0,3}?)\s+says:/m)
  if (says) return says[1].trim()
  return null
}

interface WWRow {
  id: string
  wedding_id: string | null
  subject: string | null
  full_body: string | null
  body_preview: string | null
  timestamp: string | null
}

interface ProspectGroup {
  authsolic: string
  name: string | null
  interactions: WWRow[]
  /** First-occurring interaction's wedding_id, if any. */
  current_wedding_id: string | null
  /** Earliest interaction timestamp in the group. */
  earliest_ts: string | null
}

async function main() {
  console.log(`\n=== Split WW-conflated weddings — venue ${venueId} ${apply ? '(apply)' : '(dry-run)'} ===\n`)

  // Pull every WW-relay interaction at the venue.
  const { data: ints } = await sb
    .from('interactions')
    .select('id, wedding_id, subject, full_body, body_preview, timestamp')
    .eq('venue_id', venueId)
    .eq('from_email', 'messages@weddingwire.com')
    .order('timestamp', { ascending: true })
  const rows = (ints ?? []) as WWRow[]
  console.log(`WW interactions scanned: ${rows.length}`)

  // Group by authsolic.
  const groups = new Map<string, ProspectGroup>()
  let noTokenCount = 0
  for (const r of rows) {
    const body = r.full_body ?? r.body_preview ?? ''
    const token = extractAuthsolic(body)
    if (!token) {
      noTokenCount++
      continue
    }
    const name = extractName(r.subject ?? '', body)
    const g = groups.get(token) ?? {
      authsolic: token,
      name,
      interactions: [],
      current_wedding_id: r.wedding_id,
      earliest_ts: r.timestamp,
    }
    if (!g.name && name) g.name = name
    g.interactions.push(r)
    if (r.timestamp && (!g.earliest_ts || r.timestamp < g.earliest_ts)) {
      g.earliest_ts = r.timestamp
    }
    groups.set(token, g)
  }
  console.log(`distinct prospects (by authsolic): ${groups.size}`)
  console.log(`interactions with no extractable token: ${noTokenCount}`)

  // Find weddings that host MULTIPLE distinct prospects — those are
  // the conflated ones we need to split.
  const weddingProspects = new Map<string, Set<string>>() // wedding_id → token set
  for (const g of groups.values()) {
    for (const i of g.interactions) {
      if (!i.wedding_id) continue
      const set = weddingProspects.get(i.wedding_id) ?? new Set<string>()
      set.add(g.authsolic)
      weddingProspects.set(i.wedding_id, set)
    }
  }
  const conflatedWeddings = new Set<string>()
  for (const [wid, set] of weddingProspects) {
    if (set.size >= 2) conflatedWeddings.add(wid)
  }
  console.log(`conflated weddings: ${conflatedWeddings.size}`)
  if (conflatedWeddings.size === 0) {
    console.log('Nothing to split.')
    return
  }

  // For each conflated wedding, decide which prospect KEEPS the
  // original wedding (the earliest one) and which get new weddings.
  let newWeddingsCreated = 0
  let interactionsMoved = 0
  let peopleCreated = 0

  for (const conflictedWid of conflatedWeddings) {
    const groupsOnThisWedding = Array.from(groups.values())
      .filter((g) => g.interactions.some((i) => i.wedding_id === conflictedWid))
      .sort((a, b) => (a.earliest_ts ?? '').localeCompare(b.earliest_ts ?? ''))

    const keeperGroup = groupsOnThisWedding[0]
    const splitGroups = groupsOnThisWedding.slice(1)
    console.log(`\nwedding ${conflictedWid.slice(0, 8)}…: keeping "${keeperGroup.name ?? '?'}" (${keeperGroup.authsolic.slice(0, 12)}…); splitting ${splitGroups.length} others`)

    for (const g of splitGroups) {
      const splitName = g.name ?? 'Unknown WW prospect'
      const earliestIso = g.earliest_ts ?? new Date().toISOString()
      console.log(`  → "${splitName}" (${g.interactions.length} interactions, earliest ${earliestIso.slice(0, 10)})`)

      if (apply) {
        // 1. Create new wedding row.
        const { data: newWed, error: wedErr } = await sb
          .from('weddings')
          .insert({
            venue_id: venueId,
            status: 'inquiry',
            source: 'wedding_wire',
            inquiry_date: earliestIso,
            heat_score: 0,
            temperature_tier: 'cool',
          })
          .select('id')
          .single()
        if (wedErr || !newWed) {
          console.error(`    failed to create wedding: ${wedErr?.message}`)
          continue
        }
        const newWedId = (newWed as { id: string }).id
        newWeddingsCreated++

        // 2. Create person row with the prospect's name +
        //    synthetic authsolic email.
        const [first, ...rest] = splitName.trim().split(/\s+/)
        const last = rest.join(' ') || null
        const syntheticEmail = `authsolic-${g.authsolic}@weddingwire.bloom-relay.invalid`
        const { data: newPerson, error: pErr } = await sb
          .from('people')
          .insert({
            venue_id: venueId,
            wedding_id: newWedId,
            role: 'partner1',
            first_name: first || null,
            last_name: last,
            email: syntheticEmail,
          })
          .select('id')
          .single()
        if (pErr || !newPerson) {
          console.error(`    failed to create person: ${pErr?.message}`)
          continue
        }
        const newPersonId = (newPerson as { id: string }).id
        peopleCreated++

        // 3. Move this prospect's interactions to the new wedding.
        for (const i of g.interactions) {
          if (i.wedding_id !== conflictedWid) continue
          const { error: updErr } = await sb
            .from('interactions')
            .update({ wedding_id: newWedId, person_id: newPersonId })
            .eq('id', i.id)
          if (!updErr) interactionsMoved++
        }
      } else {
        // dry-run: just count what we would do
        newWeddingsCreated++
        peopleCreated++
        interactionsMoved += g.interactions.filter((i) => i.wedding_id === conflictedWid).length
      }
    }
  }

  console.log()
  console.log(`new weddings created:     ${newWeddingsCreated}`)
  console.log(`new people rows created:  ${peopleCreated}`)
  console.log(`interactions moved:       ${interactionsMoved}`)
  if (!apply) console.log(`\nDry-run complete. Re-run with --apply to write.`)
}

main().catch((err) => { console.error(err); process.exit(1) })
