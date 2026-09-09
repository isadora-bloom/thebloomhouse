// ============================================================================
// demo-repair.mjs — operator alternative to supabase/migrations/392_demo_
// anon_read_policies.sql STEP 3 (the data fixes only; RLS policies are DDL
// and stay in the migration — a JS/PostgREST client can't reliably issue
// `CREATE POLICY` without an exec_sql RPC, which is a bigger footgun than
// this script wants to carry). Run this if pasting SQL into the Supabase
// editor isn't your preference.
//
// NOVEMBER-PLAN.md W4 (2026-09-08), findings 1, 4 and 5:
//   1. Hawthorne's venue_config.business_name reads "Rixey Manor" (data,
//      not code — a copy/paste against the real Rixey Manor row).
//   4. The couples/people tables carry diagnostic test rows named like
//      "SarahH[DIAG-GAP3]" / "Couple[DIAG-GAP3]" from a prior gap-audit run.
//   5. venue_ai_config.escalation_email for the demo venue is
//      sarah@rixeymanor.com — a REAL, live inbox at Isadora's actual venue,
//      not a fictional address. A demo visitor following Sage's footer
//      would reach Rixey's real ops inbox.
//
// This script REPORTS on all three every run, and FIXES all three under
// --apply. It also reports (never fixes — no data patch is the right
// answer here) two related findings that need the demo reseeded through
// linkSignal instead, per DEMO-RESEED-DESIGN.md written alongside it:
//   - spine `touchpoints` row count for the demo venues vs the legacy
//     `interactions` row count (finding 4, second half — identity-first
//     surfaces are empty while legacy surfaces show numbers)
//   - heat/lifecycle distribution for the demo venues (finding 5 — 61 demo
//     leads Frozen at heat 0-1 because the seed dates are March-May and
//     decay ran against today's clock)
//   - whether a `weddings` row exists at BOTH the old runtime demo wedding
//     id (ab000000-0000-0000-0000-000000000001, now fixed in code — see
//     src/lib/api/auth-helpers.ts DEMO_WEDDING_ID) and the current one
//     (44444444-4444-4444-4444-444444000109), so the operator can see
//     whether the old id is a genuinely stray row worth a separate look.
//
// SAFETY: dry-run by default (report only, no writes). --apply performs the
// three fixes. The prod ref is refused without --allow-prod
// (scripts/_safety.mjs) — this demo data lives in production, so --apply
// almost always also needs --allow-prod; the double flag is intentional
// friction, not a bug.
//
// Usage:
//   node scripts/demo-repair.mjs                       # report only
//   node scripts/demo-repair.mjs --apply --allow-prod   # report + fix, on prod
//
// This workstream (W4) does not run this script — NOVEMBER-PLAN.md's "no
// database writes" rule. Written for the operator to run.
// ============================================================================

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { parseSafetyFlags, assertNotProd, requireApply } from './_safety.mjs'

// The Crestwood Collection demo venues. Same four ids as
// src/lib/api/auth-helpers.ts DEMO_VENUE_ALLOWLIST (hardcoded here too —
// that file is a Next.js server module and isn't importable from a plain
// node script without dragging in `next/headers` and friends).
const DEMO_VENUE_IDS = [
  '22222222-2222-2222-2222-222222222201', // Hawthorne Manor
  '22222222-2222-2222-2222-222222222202', // Crestwood Farm
  '22222222-2222-2222-2222-222222222203', // The Glass House
  '22222222-2222-2222-2222-222222222204', // Rose Hill Gardens
]
const HAWTHORNE_VENUE_ID = DEMO_VENUE_IDS[0]
const EXPECTED_BUSINESS_NAME = 'Hawthorne Manor'
const FICTIONAL_ESCALATION_EMAIL = 'sarah@hawthornemanor.com' // matches venue_config.coordinator_email in supabase/seed.sql
const LEAKED_ESCALATION_DOMAIN = '@rixeymanor.com'
const OLD_STRAY_WEDDING_ID = 'ab000000-0000-0000-0000-000000000001'
const CURRENT_DEMO_WEDDING_ID = '44444444-4444-4444-4444-444444000109'

function loadEnv() {
  const raw = readFileSync('.env.local', 'utf8')
  return Object.fromEntries(
    raw
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
      }),
  )
}

// --- report sections (read-only, run every time) ---------------------------

async function reportBusinessName(sb) {
  const { data, error } = await sb
    .from('venue_config')
    .select('venue_id, business_name')
    .eq('venue_id', HAWTHORNE_VENUE_ID)
    .maybeSingle()
  if (error) {
    console.log(`  [business_name] read failed: ${error.message}`)
    return { needsFix: false }
  }
  const current = data?.business_name ?? null
  const needsFix = current !== EXPECTED_BUSINESS_NAME
  console.log(
    needsFix
      ? `  [business_name] Hawthorne reads "${current}" — expected "${EXPECTED_BUSINESS_NAME}"`
      : `  [business_name] OK ("${current}")`,
  )
  return { needsFix }
}

async function reportEscalationEmail(sb) {
  const { data, error } = await sb
    .from('venue_ai_config')
    .select('venue_id, escalation_email')
    .in('venue_id', DEMO_VENUE_IDS)
  if (error) {
    console.log(`  [escalation_email] read failed: ${error.message}`)
    return { leaked: [] }
  }
  const leaked = (data ?? []).filter((r) =>
    (r.escalation_email ?? '').toLowerCase().includes(LEAKED_ESCALATION_DOMAIN),
  )
  if (leaked.length === 0) {
    console.log(`  [escalation_email] OK — no demo venue points at ${LEAKED_ESCALATION_DOMAIN}`)
  } else {
    for (const r of leaked) {
      console.log(`  [escalation_email] venue ${r.venue_id} reads "${r.escalation_email}" — a real Rixey inbox`)
    }
  }
  return { leaked }
}

async function reportDiagRows(sb) {
  const { data: couples, error: cErr } = await sb
    .from('couples')
    .select('id, primary_contact_name, partner_contact_name')
    .in('venue_id', DEMO_VENUE_IDS)
    .or('primary_contact_name.ilike.%[DIAG%,partner_contact_name.ilike.%[DIAG%')
  const { data: people, error: pErr } = await sb
    .from('people')
    .select('id, first_name, last_name')
    .in('venue_id', DEMO_VENUE_IDS)
    .or('first_name.ilike.%[DIAG%,last_name.ilike.%[DIAG%')
  if (cErr) console.log(`  [diag-rows] couples read failed: ${cErr.message}`)
  if (pErr) console.log(`  [diag-rows] people read failed: ${pErr.message}`)
  const coupleIds = (couples ?? []).map((r) => r.id)
  const peopleIds = (people ?? []).map((r) => r.id)
  console.log(`  [diag-rows] couples: ${coupleIds.length} · people: ${peopleIds.length}`)
  if (coupleIds.length) console.log(`    couples: ${(couples ?? []).slice(0, 5).map((r) => r.primary_contact_name || r.partner_contact_name).join(', ')}${coupleIds.length > 5 ? ' …' : ''}`)
  if (peopleIds.length) console.log(`    people: ${(people ?? []).slice(0, 5).map((r) => `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim()).join(', ')}${peopleIds.length > 5 ? ' …' : ''}`)
  return { coupleIds, peopleIds }
}

// Diagnostic only — never fixed by this script. See DEMO-RESEED-DESIGN.md.
async function reportSpineVsLegacy(sb) {
  const { count: touchCount, error: tErr } = await sb
    .from('touchpoints')
    .select('id', { count: 'exact', head: true })
    .in('venue_id', DEMO_VENUE_IDS)
  const { count: interCount, error: iErr } = await sb
    .from('interactions')
    .select('id', { count: 'exact', head: true })
    .in('venue_id', DEMO_VENUE_IDS)
  if (tErr) console.log(`  [spine-vs-legacy] touchpoints read failed: ${tErr.message}`)
  if (iErr) console.log(`  [spine-vs-legacy] interactions read failed: ${iErr.message}`)
  console.log(
    `  [spine-vs-legacy] touchpoints: ${touchCount ?? '?'} · interactions (legacy): ${interCount ?? '?'}` +
      ((touchCount ?? 0) === 0 && (interCount ?? 0) > 0
        ? '  <- identity-first surfaces will read empty; needs a reseed through linkSignal, not a data patch'
        : ''),
  )
}

// Diagnostic only — never fixed by this script. See DEMO-RESEED-DESIGN.md.
async function reportHeatDistribution(sb) {
  const { data, error } = await sb
    .from('weddings')
    .select('temperature_tier, heat_score')
    .in('venue_id', DEMO_VENUE_IDS)
  if (error) {
    console.log(`  [heat] read failed: ${error.message}`)
    return
  }
  const rows = data ?? []
  const byTier = {}
  let frozenLowHeat = 0
  for (const r of rows) {
    const tier = r.temperature_tier ?? 'null'
    byTier[tier] = (byTier[tier] ?? 0) + 1
    if (tier === 'frozen' && (r.heat_score ?? 0) <= 1) frozenLowHeat += 1
  }
  console.log(`  [heat] ${rows.length} weddings across demo venues, by tier: ${JSON.stringify(byTier)}`)
  if (frozenLowHeat > 0) {
    console.log(`    ${frozenLowHeat} frozen at heat 0-1 — seed dates are static (March-May); decay ran against today's clock. Needs a live-clock reseed, see DEMO-RESEED-DESIGN.md.`)
  }
}

async function reportStrayWeddingId(sb) {
  const { data, error } = await sb
    .from('weddings')
    .select('id')
    .in('id', [OLD_STRAY_WEDDING_ID, CURRENT_DEMO_WEDDING_ID])
  if (error) {
    console.log(`  [wedding-id] read failed: ${error.message}`)
    return
  }
  const found = new Set((data ?? []).map((r) => r.id))
  console.log(`  [wedding-id] old id (${OLD_STRAY_WEDDING_ID}) exists: ${found.has(OLD_STRAY_WEDDING_ID)}`)
  console.log(`  [wedding-id] current id (${CURRENT_DEMO_WEDDING_ID}) exists: ${found.has(CURRENT_DEMO_WEDDING_ID)}`)
  if (found.has(OLD_STRAY_WEDDING_ID)) {
    console.log(`    a row exists at the OLD id too — worth checking by hand whether it's dead data left behind, separate from this script's remit.`)
  }
}

// --- fixes (only under --apply) --------------------------------------------

async function fixBusinessName(sb) {
  const { error } = await sb
    .from('venue_config')
    .update({ business_name: EXPECTED_BUSINESS_NAME, updated_at: new Date().toISOString() })
    .eq('venue_id', HAWTHORNE_VENUE_ID)
  console.log(error ? `  [business_name] UPDATE failed: ${error.message}` : `  [business_name] fixed -> "${EXPECTED_BUSINESS_NAME}"`)
}

async function fixEscalationEmail(sb, leaked) {
  if (leaked.length === 0) return
  const { error } = await sb
    .from('venue_ai_config')
    .update({ escalation_email: FICTIONAL_ESCALATION_EMAIL, updated_at: new Date().toISOString() })
    .in('venue_id', leaked.map((r) => r.venue_id))
  console.log(error ? `  [escalation_email] UPDATE failed: ${error.message}` : `  [escalation_email] fixed ${leaked.length} venue(s) -> "${FICTIONAL_ESCALATION_EMAIL}"`)
}

async function fixDiagRows(sb, coupleIds, peopleIds) {
  if (coupleIds.length) {
    const { error } = await sb.from('couples').delete().in('id', coupleIds)
    console.log(error ? `  [diag-rows] couples DELETE failed: ${error.message}` : `  [diag-rows] deleted ${coupleIds.length} couples row(s)`)
  }
  if (peopleIds.length) {
    const { error } = await sb.from('people').delete().in('id', peopleIds)
    console.log(error ? `  [diag-rows] people DELETE failed: ${error.message}` : `  [diag-rows] deleted ${peopleIds.length} people row(s)`)
  }
  if (!coupleIds.length && !peopleIds.length) console.log('  [diag-rows] nothing to delete')
}

// --- main --------------------------------------------------------------

async function main() {
  const { apply, allowProd } = parseSafetyFlags(process.argv)
  const env = loadEnv()
  const url = env.NEXT_PUBLIC_SUPABASE_URL
  assertNotProd(url, { allowProd })

  const sb = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

  console.log(`\nTarget: ${url}`)
  console.log('\n=== REPORT ===')
  const { needsFix: businessNameNeedsFix } = await reportBusinessName(sb)
  const { leaked } = await reportEscalationEmail(sb)
  const { coupleIds, peopleIds } = await reportDiagRows(sb)
  await reportSpineVsLegacy(sb)
  await reportHeatDistribution(sb)
  await reportStrayWeddingId(sb)

  const anythingToFix = businessNameNeedsFix || leaked.length > 0 || coupleIds.length > 0 || peopleIds.length > 0
  console.log(`\n${anythingToFix ? 'Fixable items found.' : 'Nothing to fix — all three data items already clean.'}`)

  if (!requireApply(apply, 'demo-repair')) {
    console.log('Diagnostics-only items (spine vs legacy, heat distribution, stray wedding id) are never auto-fixed by this script regardless of --apply — see DEMO-RESEED-DESIGN.md.')
    process.exit(0)
  }

  console.log('\n=== APPLY ===')
  if (businessNameNeedsFix) await fixBusinessName(sb)
  if (leaked.length) await fixEscalationEmail(sb, leaked)
  await fixDiagRows(sb, coupleIds, peopleIds)
  console.log('\nDone. Diagnostics-only items above still need a reseed through linkSignal — see DEMO-RESEED-DESIGN.md.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
