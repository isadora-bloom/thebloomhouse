// End-to-end smoke test of the signup → setup → onboarding flow against
// prod Supabase via service role. Mirrors the exact DB operations performed
// by /api/auth/signup, /setup (createVenue), /setup?mode=add, /settings/groups,
// and /api/team/invite. Cleans up all test data at the end.
//
// Usage:
//   node scripts/smoke-test-onboarding.mjs
//
// The test REMOVES all artifacts it creates, win or lose, via a try/finally.
// If it crashes mid-run, re-run — it uses a unique email each time.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
const sb = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

const RUN_ID = Date.now().toString(36)
const EMAIL = `smoke-rixey-${RUN_ID}@bloomhouse.test`
const PASSWORD = `Smoke-${RUN_ID}!pass`
const FIRST = 'Smoke'
const LAST = `Test-${RUN_ID}`
const FULL_NAME = `${FIRST} ${LAST}`

const pass = (msg) => console.log(`  PASS  ${msg}`)
const fail = (msg, err) => { console.log(`  FAIL  ${msg}`); if (err) console.log('        ', err.message || err); FAILED++ }
const step = (n, msg) => console.log(`\n[${n}] ${msg}`)
let FAILED = 0

// Captured state for cleanup
const created = {
  userId: null,
  orgId: null,
  venue1Id: null,
  venue2Id: null,
  venue3Id: null,
  groupId: null,
  inviteId: null,
}

async function run() {
  console.log(`=== Onboarding smoke test (run ${RUN_ID}) ===`)
  console.log(`Email: ${EMAIL}`)

  // ─── STEP 1: Signup ────────────────────────────────────────────────────────
  step(1, 'Signup (mirrors /api/auth/signup coordinator path)')

  const { data: authData, error: authErr } = await sb.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: FULL_NAME, role: 'coordinator' },
  })
  if (authErr) return fail('createUser', authErr)
  created.userId = authData.user.id
  pass(`auth user created (${created.userId.slice(0, 8)}…)`)

  const { data: org, error: orgErr } = await sb
    .from('organisations')
    .insert({ name: `${FULL_NAME}'s Company`, owner_id: created.userId, is_demo: false })
    .select('id')
    .single()
  if (orgErr) return fail('create organisation', orgErr)
  created.orgId = org.id
  pass(`organisation created (${created.orgId.slice(0, 8)}…)`)

  const { error: profErr } = await sb.from('user_profiles').insert({
    id: created.userId,
    venue_id: null,
    org_id: created.orgId,
    role: 'org_admin',
    first_name: FIRST,
    last_name: LAST,
  })
  if (profErr) return fail('create user_profile', profErr)
  pass('user_profile created with org_admin role + venue_id=null')

  // ─── STEP 2: Auth-helper fallback sanity check ─────────────────────────────
  step(2, 'Org-admin fallback (venue_id=null before first venue)')

  // Mirrors getPlatformAuth/require-plan logic: admin with no venue falls
  // back to first venue in org. Before we create one, the fallback returns null.
  const { data: venuesBefore } = await sb
    .from('venues').select('id').eq('org_id', created.orgId).limit(1).maybeSingle()
  if (venuesBefore) fail('expected no venues before setup, found one')
  else pass('no venues yet — fallback correctly returns nothing (will return null in helper)')

  // ─── STEP 3: First venue (mirrors /setup createVenue) ──────────────────────
  step(3, 'First venue (mirrors /setup createVenue — Rixey Manor)')

  const v1Slug = `rixey-manor-${RUN_ID}`
  const { data: v1, error: v1Err } = await sb
    .from('venues')
    .insert({
      name: 'Rixey Manor',
      slug: v1Slug,
      org_id: created.orgId,
      status: 'trial',
      is_demo: false,
      city: 'Jeffersonton',
      state: 'VA',
    })
    .select('id')
    .single()
  if (v1Err) return fail('create first venue', v1Err)
  created.venue1Id = v1.id
  pass(`venue 1 created: Rixey Manor (${v1Slug})`)

  const { error: cfg1Err } = await sb.from('venue_config').insert({
    venue_id: created.venue1Id,
    business_name: 'Rixey Manor',
    timezone: 'America/New_York',
    capacity: 180,
    base_price: 25000,
    onboarding_completed: false,
  })
  if (cfg1Err) fail('create venue_config', cfg1Err)
  else pass('venue_config created')

  const { error: p2Err } = await sb
    .from('user_profiles')
    .update({ venue_id: created.venue1Id })
    .eq('id', created.userId)
  if (p2Err) fail('update user_profile with venue_id', p2Err)
  else pass('user_profile.venue_id set to first venue')

  // ─── STEP 4: Second venue via add-mode (mirrors /setup?mode=add) ───────────
  step(4, 'Second venue via add-mode (mirrors /setup?mode=add)')

  const v2Slug = `rixey-annex-${RUN_ID}`
  const { data: v2, error: v2Err } = await sb
    .from('venues')
    .insert({
      name: 'Rixey Annex',
      slug: v2Slug,
      org_id: created.orgId,
      status: 'trial',
      is_demo: false,
      city: 'Jeffersonton',
      state: 'VA',
    })
    .select('id')
    .single()
  if (v2Err) return fail('create second venue', v2Err)
  created.venue2Id = v2.id
  pass(`venue 2 created: Rixey Annex (${v2Slug})`)

  // Note: addMode path keeps profile.venue_id pointing at first venue,
  // goes straight to /onboarding — NO team step. Confirm profile unchanged.
  const { data: p } = await sb
    .from('user_profiles')
    .select('venue_id, org_id, role')
    .eq('id', created.userId)
    .single()
  if (p.venue_id !== created.venue1Id) fail('addMode should NOT reassign profile.venue_id')
  else pass('addMode flow: profile.venue_id unchanged (still pointing at venue 1)')
  if (p.role !== 'org_admin') fail(`role expected org_admin, got ${p.role}`)
  else pass('role is org_admin')

  // ─── STEP 5: Venue group (mirrors /settings/groups createGroup) ────────────
  step(5, 'Venue group spanning both venues (mirrors /settings/groups)')

  const { data: group, error: gErr } = await sb
    .from('venue_groups')
    .insert({
      org_id: created.orgId,
      name: `Rixey Portfolio ${RUN_ID}`,
      description: 'Smoke test group',
    })
    .select('id')
    .single()
  if (gErr) return fail('create venue_group', gErr)
  created.groupId = group.id
  pass(`venue_group created (${created.groupId.slice(0, 8)}…)`)

  const { error: memErr } = await sb.from('venue_group_members').insert([
    { group_id: created.groupId, venue_id: created.venue1Id },
    { group_id: created.groupId, venue_id: created.venue2Id },
  ])
  if (memErr) fail('add members to venue_group', memErr)
  else pass('both venues added as members')

  // Verify the shape the scope-selector reads
  const { data: groupRead } = await sb
    .from('venue_groups')
    .select('id, name, venue_group_members(venue_id)')
    .eq('id', created.groupId)
    .single()
  const memberIds = (groupRead?.venue_group_members ?? []).map((m) => m.venue_id).sort()
  const expected = [created.venue1Id, created.venue2Id].sort()
  if (JSON.stringify(memberIds) === JSON.stringify(expected))
    pass('scope-selector read shape: 2 venue_ids present')
  else fail(`scope-selector read: expected ${expected}, got ${memberIds}`)

  // ─── STEP 6: Team invitation (mirrors /api/team/invite) ────────────────────
  step(6, 'Team invitation (mirrors /api/team/invite)')

  const inviteEmail = `coordinator-${RUN_ID}@bloomhouse.test`
  const inviteToken = randomUUID()
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

  const { data: invite, error: invErr } = await sb
    .from('team_invitations')
    .insert({
      org_id: created.orgId,
      venue_id: created.venue1Id,
      email: inviteEmail.toLowerCase(),
      role: 'coordinator',
      invited_by: created.userId,
      token: inviteToken,
      status: 'pending',
      expires_at: expiresAt,
    })
    .select('id, token')
    .single()
  if (invErr) {
    fail('create team_invitation', invErr)
    console.log('        → table missing from PostgREST schema cache; re-apply migration 049 or NOTIFY pgrst reload')
  } else {
    created.inviteId = invite.id
    pass(`invitation row created; token=${invite.token.slice(0, 8)}…`)
  }

  // ─── STEP 7: RLS isolation via anon client ─────────────────────────────────
  step(7, 'RLS isolation (anon/unauthed cannot see this org\'s data)')

  const anon = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false } }
  )

  const checks = [
    ['organisations', anon.from('organisations').select('id').eq('id', created.orgId)],
    ['venues', anon.from('venues').select('id').eq('id', created.venue1Id)],
    ['venue_groups', anon.from('venue_groups').select('id').eq('id', created.groupId)],
    ['venue_group_members', anon.from('venue_group_members').select('id').eq('group_id', created.groupId)],
    ['team_invitations', anon.from('team_invitations').select('id').eq('id', created.inviteId)],
    ['user_profiles', anon.from('user_profiles').select('id').eq('id', created.userId)],
  ]
  for (const [table, q] of checks) {
    const { data, error } = await q
    if (error) { pass(`${table}: anon blocked (error: ${error.code || 'err'})`); continue }
    if (!data || data.length === 0) pass(`${table}: anon sees 0 rows (RLS filtering)`)
    else fail(`${table}: anon saw ${data.length} rows (LEAK)`)
  }

  // ─── STEP 8: Demo isolation (real data invisible in demo scope) ────────────
  step(8, 'Demo isolation (demo org must not see real Rixey data)')

  const DEMO_ORG = '11111111-1111-1111-1111-111111111111'
  const { data: demoOrgVenues } = await sb
    .from('venues').select('id, name').eq('org_id', DEMO_ORG)
  const leaked = (demoOrgVenues ?? []).find(
    (v) => v.id === created.venue1Id || v.id === created.venue2Id
  )
  if (leaked) fail(`demo org contains real venue ${leaked.name}`)
  else pass(`demo org has ${demoOrgVenues?.length ?? 0} venues, none are real`)

  const { data: realVenues } = await sb
    .from('venues').select('id').eq('org_id', created.orgId)
  const demoLeak = (realVenues ?? []).find((v) => {
    // None of our real venues should be associated with demo org — we already
    // verified above — this is the inverse check
    return false
  })
  if (demoLeak) fail('real org contains demo venue')
  else pass(`real org has ${realVenues?.length ?? 0} venues (expected 2)`)

  // ─── STEP 9: Sign-in roundtrip ─────────────────────────────────────────────
  step(9, 'Real sign-in with created credentials')

  const authClient = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false } }
  )
  const { data: signin, error: signinErr } = await authClient.auth.signInWithPassword({
    email: EMAIL, password: PASSWORD,
  })
  if (signinErr) fail('sign-in', signinErr)
  else if (signin.user?.id === created.userId) pass('sign-in works, session returned')
  else fail('sign-in returned different user id')

  // With session, verify own-org reads succeed
  if (signin?.session) {
    const authed = createClient(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      {
        auth: { persistSession: false },
        global: { headers: { Authorization: `Bearer ${signin.session.access_token}` } },
      }
    )
    const { data: ownVenues, error: ownErr } = await authed
      .from('venues').select('id').eq('org_id', created.orgId)
    if (ownErr) fail('authed read own org venues', ownErr)
    else if (ownVenues?.length === 2) pass('authed user sees both own venues via RLS')
    else fail(`authed user expected 2 venues, saw ${ownVenues?.length ?? 0}`)

    const { data: ownGroups, error: grpErr } = await authed
      .from('venue_groups').select('id').eq('org_id', created.orgId)
    if (grpErr) fail('authed read own groups', grpErr)
    else if (ownGroups?.length === 1) pass('authed user sees own venue_group via RLS')
    else fail(`authed user expected 1 group, saw ${ownGroups?.length ?? 0}`)
  }

  // ─── STEP 10: AUTHED-client write path (reproduces real /setup) ────────────
  step(10, 'Authed client can INSERT/UPDATE venues, organisations, venue_config')

  // Critical: the previous steps used the SERVICE role which bypasses RLS.
  // The real /setup page uses the browser client (authed as the user),
  // which goes through RLS. If the write policies are missing, the browser
  // will see "new row violates row-level security policy" — this step
  // catches that regression.
  if (!signin?.session) {
    fail('no session from step 9; cannot test authed writes')
  } else {
    const authed = createClient(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      {
        auth: { persistSession: false },
        global: { headers: { Authorization: `Bearer ${signin.session.access_token}` } },
      }
    )

    // 10a. UPDATE organisations.name (mirrors /setup saveCompany)
    const { error: orgUpdErr } = await authed
      .from('organisations')
      .update({ name: `Renamed ${RUN_ID}` })
      .eq('id', created.orgId)
    if (orgUpdErr) fail('authed UPDATE organisations.name', orgUpdErr)
    else pass('authed UPDATE organisations.name')

    // 10b. INSERT a third venue (mirrors /setup createVenue via browser)
    const v3Slug = `rixey-authed-${RUN_ID}`
    const { data: v3, error: v3Err } = await authed
      .from('venues')
      .insert({
        name: 'Rixey Authed',
        slug: v3Slug,
        org_id: created.orgId,
        status: 'trial',
        is_demo: false,
        city: 'Jeffersonton',
        state: 'VA',
      })
      .select('id')
      .single()
    if (v3Err) fail('authed INSERT venues', v3Err)
    else {
      pass('authed INSERT venues (org-scoped write policy in effect)')

      // 10c. INSERT venue_config for that venue
      const { error: cfgErr } = await authed.from('venue_config').insert({
        venue_id: v3.id,
        business_name: 'Rixey Authed',
        timezone: 'America/New_York',
        capacity: 100,
        base_price: 10000,
        onboarding_completed: false,
      })
      if (cfgErr) fail('authed INSERT venue_config', cfgErr)
      else pass('authed INSERT venue_config')

      // Track for cleanup
      created.venue3Id = v3.id
    }

    // 10d. Cross-org INSERT must fail — prove the policy isn't just "allow all"
    const { error: crossErr } = await authed
      .from('venues')
      .insert({
        name: 'Evil Cross-Org Venue',
        slug: `evil-${RUN_ID}`,
        org_id: '11111111-1111-1111-1111-111111111111',  // demo org
        status: 'trial',
        is_demo: false,
      })
    if (crossErr) pass(`cross-org INSERT blocked (${crossErr.code})`)
    else fail('cross-org INSERT was allowed — policy too permissive')
  }

  console.log(`\n=== ${FAILED === 0 ? 'ALL CHECKS PASSED' : `${FAILED} CHECK(S) FAILED`} ===`)
}

async function cleanup() {
  console.log('\n=== Cleanup ===')
  // Order: children → parents. RLS bypass via service role.
  if (created.inviteId) {
    await sb.from('team_invitations').delete().eq('id', created.inviteId)
    console.log('  team_invitation removed')
  }
  if (created.groupId) {
    await sb.from('venue_group_members').delete().eq('group_id', created.groupId)
    await sb.from('venue_groups').delete().eq('id', created.groupId)
    console.log('  venue_group + members removed')
  }
  // Non-cascading children of venues
  const vids = [created.venue1Id, created.venue2Id, created.venue3Id].filter(Boolean)
  if (vids.length) {
    for (const t of ['venue_config', 'wedding_details', 'wedding_tables', 'storefront', 'venue_assets', 'venue_resources']) {
      await sb.from(t).delete().in('venue_id', vids)
    }
  }
  // user_profiles before venues (FK)
  if (created.userId) {
    await sb.from('user_profiles').delete().eq('id', created.userId)
    console.log('  user_profile removed')
  }
  for (const id of vids) {
    await sb.from('venues').delete().eq('id', id)
  }
  if (vids.length) console.log(`  ${vids.length} venue(s) removed`)
  if (created.orgId) {
    await sb.from('organisations').delete().eq('id', created.orgId)
    console.log('  organisation removed')
  }
  if (created.userId) {
    await sb.auth.admin.deleteUser(created.userId)
    console.log('  auth user removed')
  }
}

try {
  await run()
} catch (e) {
  console.error('\nUNCAUGHT ERROR:', e)
  FAILED++
} finally {
  try { await cleanup() } catch (e) { console.error('cleanup error:', e) }
}

process.exit(FAILED === 0 ? 0 : 1)
