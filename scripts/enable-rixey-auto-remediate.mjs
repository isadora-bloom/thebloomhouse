#!/usr/bin/env node
/**
 * Enable integrity_auto_remediate on Rixey so the daily
 * data_integrity_sweep moves from dry-run to apply mode and the
 * wedding-has-people remediation revives partner1 rows from
 * couple_identity_profile.
 *
 * Step 5d operator action. Affects ONLY Rixey — new venues opt in
 * via the same feature_flags path.
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

const { data: venue } = await sb
  .from('venues')
  .select('id, name')
  .ilike('name', '%rixey%')
  .limit(1)
  .maybeSingle()
if (!venue) {
  console.error('Rixey not found')
  process.exit(1)
}

const { data: existing } = await sb
  .from('venue_config')
  .select('feature_flags')
  .eq('venue_id', venue.id)
  .maybeSingle()

const currentFlags = (existing?.feature_flags ?? {})
const nextFlags = { ...currentFlags, integrity_auto_remediate: true }
console.log(`Current feature_flags: ${JSON.stringify(currentFlags)}`)
console.log(`Next    feature_flags: ${JSON.stringify(nextFlags)}`)

const { error } = await sb
  .from('venue_config')
  .update({ feature_flags: nextFlags, updated_at: new Date().toISOString() })
  .eq('venue_id', venue.id)
if (error) {
  console.error('Update failed:', error.message)
  process.exit(1)
}
console.log('OK — integrity_auto_remediate set on Rixey. Daily data_integrity_sweep will switch from dry-run to apply mode on next run.')
