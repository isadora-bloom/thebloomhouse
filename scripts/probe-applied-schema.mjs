#!/usr/bin/env node
/**
 * probe-applied-schema.mjs — read-only live-vs-migrations reconciliation.
 *
 * The repo has no migration-state tracking (R4's flatten is meant to add
 * it, post-wipe). So "which migrations were never applied" can only be
 * inferred by asking the live DB what objects actually exist and diffing
 * against what the migration FILES declare.
 *
 * REST-only (service key; no direct Postgres URL). Detection:
 *   - table exists?  select ...limit 0 → 42P01 / PGRST205 = missing.
 *   - has column?    select <col> limit 0 → 42703 = column missing.
 *   - function?      rpc(name) → 42883 = function missing (any other
 *                    error, incl. wrong-args, means it EXISTS).
 *
 * Read-only. Modifies nothing.
 *
 * Usage: node scripts/probe-applied-schema.mjs
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

function loadEnv() {
  const out = {}
  for (const line of readFileSync('.env.local', 'utf-8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    let v = t.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[t.slice(0, eq).trim()] = v
  }
  return out
}

const env = loadEnv()
const sb = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

const MIG_DIR = join('supabase', 'migrations')
const files = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort()

// table -> first migration file that CREATEs it
const declaredBy = new Map()
for (const f of files) {
  const sql = readFileSync(join(MIG_DIR, f), 'utf8')
  for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?"?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) {
    const t = m[1].toLowerCase()
    if (!declaredBy.has(t)) declaredBy.set(t, f)
  }
}

// Tables migration 383 touches (the ones whose absence would break it).
const sql383 = readFileSync(join(MIG_DIR, '383_rls_venue_isolation_batch.sql'), 'utf8')
const tables383 = [...sql383.matchAll(/alter\s+table\s+public\.([a-z_][a-z0-9_]*)\s+enable/gi)].map((m) => m[1])
const set383 = new Set(tables383)

async function tableExists(t) {
  const { error } = await sb.from(t).select('*', { head: true, count: 'planned' }).limit(0)
  if (!error) return { exists: true }
  const code = error.code || ''
  if (code === '42P01' || code === 'PGRST205' || /Could not find the table/i.test(error.message || '')) {
    return { exists: false }
  }
  // Some other error (permission etc.) — treat as exists-but-note.
  return { exists: true, note: `${code} ${error.message}`.trim() }
}

async function hasVenueId(t) {
  const { error } = await sb.from(t).select('venue_id', { head: true }).limit(0)
  if (!error) return true
  if ((error.code || '') === '42703') return false
  return null // couldn't determine
}

async function functionExists(name) {
  const { error } = await sb.rpc(name)
  if (!error) return true
  const code = error.code || ''
  if (code === '42883' || /Could not find the function/i.test(error.message || '') || (code === 'PGRST202')) return false
  return true // exists (errored for another reason, e.g. needs args / auth.uid null)
}

const allTables = [...declaredBy.keys()].sort()
console.log(`Probing ${allTables.length} distinct declared tables + ${tables383.length} in mig 383…\n`)

const missing = []
const missingVenueId = []
for (const t of allTables) {
  const { exists } = await tableExists(t)
  if (!exists) {
    missing.push(t)
    continue
  }
  if (set383.has(t)) {
    const hv = await hasVenueId(t)
    if (hv === false) missingVenueId.push(t)
  }
}

const superAdmin = await functionExists('is_super_admin')

console.log('════════════════════════════════════════════════════')
console.log(' MISSING TABLES (declared in a migration, absent live)')
console.log('════════════════════════════════════════════════════')
if (missing.length === 0) console.log('  none — every CREATE TABLE is present live.')
for (const t of missing) {
  const in383 = set383.has(t) ? '  ⟵ IN 383 (breaks it)' : ''
  console.log(`  ${t.padEnd(38)} declared by ${declaredBy.get(t)}${in383}`)
}

console.log('\n════════════════════════════════════════════════════')
console.log(' 383 TABLES PRESENT BUT MISSING venue_id COLUMN')
console.log('════════════════════════════════════════════════════')
if (missingVenueId.length === 0) console.log('  none.')
for (const t of missingVenueId) console.log(`  ${t}`)

console.log('\n════════════════════════════════════════════════════')
console.log(' FUNCTION DEPENDENCY')
console.log('════════════════════════════════════════════════════')
console.log(`  public.is_super_admin(): ${superAdmin ? 'EXISTS' : 'MISSING ⟵ breaks every 383 policy'}`)

console.log('\nSummary:')
console.log(`  ${missing.length} missing tables; ${missing.filter((t) => set383.has(t)).length} of them are in 383.`)
console.log(`  ${missingVenueId.length} of 383's present tables lack venue_id.`)
console.log(`  is_super_admin: ${superAdmin ? 'ok' : 'MISSING'}`)
