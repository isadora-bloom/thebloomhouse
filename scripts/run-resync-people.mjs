#!/usr/bin/env node
/**
 * Run profile-to-people-sync against every couple_identity_profile row
 * for Rixey. Pure projection: no LLM cost. Pass G is in place, so this
 * walks the historical profiles and flips people-row first/last/email
 * where the judge already has a confident claim that was never synced.
 *
 * Reads .env.local for SUPABASE creds. Calls the same code path the
 * /api/admin/identity/resync-people endpoint uses.
 */
import { readFileSync } from 'node:fs'

const env = {}
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (!m) continue
  let v = m[2]
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
  env[m[1]] = v
}
for (const [k, v] of Object.entries(env)) {
  if (process.env[k] === undefined) process.env[k] = v
}

const { createClient } = await import('@supabase/supabase-js')
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// Run with: node --import tsx scripts/run-resync-people.mjs
const { syncProfileToPeople } = await import('../src/lib/services/identity/profile-to-people-sync.ts')

const { data: profiles, error: pErr } = await sb
  .from('couple_identity_profile')
  .select('wedding_id, profile, last_reconstructed_at')
  .eq('venue_id', RIXEY)
  .order('last_reconstructed_at', { ascending: false, nullsFirst: false })
  .limit(2000)
if (pErr) { console.error(pErr); process.exit(1) }

console.log(`Profiles to scan: ${profiles?.length ?? 0}`)
let synced = 0
let skipped = 0
let nameUpdated = 0
let evidenceOnly = 0
const errors = []

for (const p of profiles ?? []) {
  try {
    const result = await syncProfileToPeople(p.wedding_id, { supabase: sb })
    if (result.ok) {
      if (result.updated.length > 0) {
        synced += 1
        for (const u of result.updated) {
          if (u.kind === 'name_updated') nameUpdated += 1
          if (u.kind === 'name_evidence_appended') evidenceOnly += 1
        }
      } else {
        skipped += 1
      }
    } else {
      skipped += 1
      if (!/no-profile|partners-load-failed/.test(result.reason)) {
        errors.push({ wid: p.wedding_id, reason: result.reason })
      }
    }
  } catch (err) {
    errors.push({ wid: p.wedding_id, reason: err instanceof Error ? err.message : String(err) })
  }
}

console.log(`scanned: ${profiles.length}`)
console.log(`synced (had updates): ${synced}`)
console.log(`  name_updated: ${nameUpdated}`)
console.log(`  evidence_only: ${evidenceOnly}`)
console.log(`skipped: ${skipped}`)
console.log(`errors: ${errors.length}`)
if (errors.length > 0) {
  console.log('  first 10:')
  for (const e of errors.slice(0, 10)) console.log(`    ${e.wid}: ${e.reason}`)
}
