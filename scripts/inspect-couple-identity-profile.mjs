#!/usr/bin/env node
/**
 * Inspect couple_identity_profile schema + a few sample rows. Used to
 * design the C1 read-surface flip (UI / leads list / folder writer /
 * brain prompts read names from this table with people as fallback).
 */

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = {}
for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (!m) continue
  let v = m[2]
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
  env[m[1]] = v
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

// 1) Schema via information_schema. PostgREST exposes information_schema
// only via rpc in newer projects; falling back to selecting a row and
// inspecting keys gives the same info without needing rpc.
const { data: oneRow, error: e1 } = await sb
  .from('couple_identity_profile')
  .select('*')
  .limit(1)
  .maybeSingle()
if (e1) {
  console.error('couple_identity_profile read err:', e1.message)
  process.exit(1)
}
if (!oneRow) {
  console.log('Table exists but has zero rows. Probing column shape via empty select...')
  // Force a constraint failure on a known-bad insert to surface columns.
  const { error: e2 } = await sb
    .from('couple_identity_profile')
    .insert({ __not_a_real_column__: 1 })
    .select()
  console.log('  bogus insert error (reveals shape):', e2?.message)
} else {
  console.log('Columns:')
  for (const k of Object.keys(oneRow).sort()) {
    const v = oneRow[k]
    const t = v === null ? 'null' : typeof v === 'object' ? Array.isArray(v) ? 'array' : 'object' : typeof v
    console.log(`  ${k.padEnd(40)} ${t}`)
  }
}

// 2) Row count + a couple rows with non-null names for sanity.
const { count } = await sb
  .from('couple_identity_profile')
  .select('id', { count: 'exact', head: true })
console.log(`\nTotal rows: ${count}`)

const { data: samples } = await sb
  .from('couple_identity_profile')
  .select('*')
  .limit(3)
console.log('\nSample rows (first 3):')
for (const r of samples ?? []) {
  console.log('---')
  for (const [k, v] of Object.entries(r)) {
    if (v === null || v === '' || (Array.isArray(v) && v.length === 0)) continue
    const repr = typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : String(v).slice(0, 120)
    console.log(`  ${k.padEnd(40)} ${repr}`)
  }
}
