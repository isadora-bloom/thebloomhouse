#!/usr/bin/env tsx
/**
 * One-shot orphan promote sweep for Rixey. Calls the Step 6 service
 * functions directly so the operator doesn't wait for tomorrow's
 * prune_maintenance cron tick.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

async function main(): Promise<void> {
  const env: Record<string, string> = {}
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!m) continue
    let v = m[2]
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    env[m[1]] = v
  }
  for (const [k, v] of Object.entries(env)) {
    if (!process.env[k]) process.env[k] = v
  }

  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!)

  const { promoteSocialOrphans, promoteReviewOrphans } = await import(
    '../src/lib/services/identity/orphan-promote'
  )

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
  console.log(`Venue: ${venue.name}`)

  console.log('\n--- social ---')
  const social = await promoteSocialOrphans(venue.id as string, { supabase: sb, limit: 2000 })
  console.log(`  scanned=${social.scanned}  promoted=${social.promoted}  errors=${social.errors.length}`)
  for (const e of social.errors.slice(0, 5)) console.log(`    err: ${e}`)

  console.log('\n--- reviews ---')
  const reviews = await promoteReviewOrphans(venue.id as string, { supabase: sb, limit: 2000 })
  console.log(`  scanned=${reviews.scanned}  promoted=${reviews.promoted}  errors=${reviews.errors.length}`)
  for (const e of reviews.errors.slice(0, 5)) console.log(`    err: ${e}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
