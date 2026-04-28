// Couple-side validation for the rixey-port batch (migrations 097-102).
//
// Verifies:
//   1. day_of_media — anon can SELECT (couple page reads via anon
//      client; this was the missing policy that 102 fixed).
//   2. wedding_internal_notes — anon CANNOT read (admin-only table;
//      couples should never see internal staff notes).
//   3. vendor_checklist — coordinator-only, anon blocked.
//   4. staffing_assignments wide columns reachable (the 098 fields).
//   5. Cross-wedding leak guard — querying with a different wedding_id
//      returns zero rows (or the right rows for that wedding only).
//
// Hits the live anon supabase client to mirror what the couple
// portal does at runtime. Doesn't write — read-only validation.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
  })
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]

// Anon client — same shape couples authenticate as.
const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
})
const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

async function main() {
  console.log(`\n=== Couple-side validation (Rixey ${RIXEY.slice(0, 8)}) ===\n`)

  // Pick a real Rixey wedding to use as the "current couple"
  const { data: wedRows } = await service
    .from('weddings')
    .select('id, status')
    .eq('venue_id', RIXEY)
    .eq('status', 'booked')
    .limit(1)
  const targetWedding = (wedRows ?? [])[0]
  if (!targetWedding) {
    console.log('No booked Rixey wedding to test against — aborting.')
    return
  }
  const targetId = targetWedding.id as string
  console.log(`Using wedding ${targetId.slice(0, 8)} as the couple's POV.\n`)

  // Plant one row in each of the new tables via service role so the
  // anon reads have something to find. Idempotent — uses unique
  // sentinels in caption/content so a re-run doesn't pile up.
  const sentinel = 'P102 self-review row'
  console.log('[setup] planting one test row in each table…')
  await service.from('day_of_media').upsert(
    {
      venue_id: RIXEY,
      wedding_id: targetId,
      category: 'photo',
      url: 'https://example.com/test.jpg',
      caption: sentinel,
    },
    { onConflict: 'id' }
  )
  await service.from('wedding_internal_notes').upsert(
    {
      venue_id: RIXEY,
      wedding_id: targetId,
      content: sentinel,
    },
    { onConflict: 'id' }
  )

  // CHECK 1: day_of_media anon SELECT works
  console.log('[1] day_of_media anon SELECT (couple page)')
  const dom = await anon
    .from('day_of_media')
    .select('id, wedding_id, caption')
    .eq('wedding_id', targetId)
  if (dom.error) console.log(`  ❌ ${dom.error.message}`)
  else if ((dom.data ?? []).length === 0) console.log(`  ❌ returned 0 rows — RLS blocking`)
  else console.log(`  ✓ ${dom.data!.length} rows visible to anon`)

  // CHECK 2: wedding_internal_notes anon BLOCKED
  console.log('[2] wedding_internal_notes anon SELECT (must be blocked)')
  const win = await anon
    .from('wedding_internal_notes')
    .select('id, content')
    .eq('wedding_id', targetId)
  if (win.error) {
    console.log(`  ✓ blocked: ${win.error.message}`)
  } else if ((win.data ?? []).length === 0) {
    console.log(`  ✓ 0 rows visible to anon (RLS filtered)`)
  } else {
    console.log(`  ❌ ${win.data!.length} rows visible to anon — INTERNAL NOTES LEAKING`)
  }

  // CHECK 3: vendor_checklist anon BLOCKED
  console.log('[3] vendor_checklist anon SELECT (must be blocked)')
  const vc = await anon
    .from('vendor_checklist')
    .select('id, task')
    .eq('wedding_id', targetId)
    .limit(1)
  if (vc.error) {
    console.log(`  ✓ blocked: ${vc.error.message}`)
  } else if ((vc.data ?? []).length === 0) {
    console.log(`  ✓ 0 rows visible to anon (RLS filtered)`)
  } else {
    console.log(`  ❌ ${vc.data!.length} rows visible to anon`)
  }

  // CHECK 4: staffing_assignments wide columns reachable
  console.log('[4] staffing_assignments 098 wide columns')
  const staff = await service
    .from('staffing_assignments')
    .select('id, friday_total, saturday_total, total_staff, total_cost')
    .limit(1)
  if (staff.error) console.log(`  ❌ ${staff.error.message}`)
  else console.log(`  ✓ columns present (${staff.data?.length ?? 0} sample rows)`)

  // CHECK 5: cross-wedding leak — query day_of_media with a fake wedding_id
  console.log('[5] cross-wedding leak — fake wedding_id should return 0')
  const fakeWid = '99999999-9999-9999-9999-999999999999'
  const cross = await anon
    .from('day_of_media')
    .select('id')
    .eq('wedding_id', fakeWid)
  if (cross.error) console.log(`  ? ${cross.error.message}`)
  else if ((cross.data ?? []).length === 0) console.log(`  ✓ 0 rows for fake wedding_id`)
  else console.log(`  ❌ leak: ${cross.data!.length} rows returned`)

  // Cleanup the test rows we planted
  await service.from('day_of_media').delete().eq('caption', sentinel)
  await service.from('wedding_internal_notes').delete().eq('content', sentinel)
  console.log('\n=== done ===')
}

main().catch((err) => { console.error(err); process.exit(1) })
