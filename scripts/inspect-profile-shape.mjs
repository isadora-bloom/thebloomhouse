#!/usr/bin/env node
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

const { data, count } = await sb
  .from('couple_identity_profile')
  .select('wedding_id, profile', { count: 'exact' })
  .limit(5)

console.log('row count:', count)
for (const r of data ?? []) {
  console.log(`\n=== wedding ${r.wedding_id} ===`)
  console.log(JSON.stringify(r.profile, null, 2).slice(0, 1500))
}
