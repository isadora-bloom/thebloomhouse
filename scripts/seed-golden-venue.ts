#!/usr/bin/env tsx
/**
 * D-12 helper — seed the dedicated golden-test venue on the TEST branch.
 *
 * Reads `.env.test`, HARD-REFUSES the prod ref, and upserts a `venues` row
 * for GOLDEN_TEST_VENUE so the golden harness writes into an empty, isolated
 * venue (not Rixey's real couples). Run AFTER creating .env.test:
 *   npx tsx scripts/seed-golden-venue.ts
 */
import { readFileSync, existsSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const PROD = 'jsxxgwprxuqgcauzlxcb'

async function main(): Promise<number> {
  if (!existsSync('.env.test')) {
    console.error('No .env.test — copy .env.test.example to .env.test and fill it (D-12).')
    return 1
  }
  const env: Record<string, string> = {}
  for (const l of readFileSync('.env.test', 'utf8').split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  if (!url || url.includes('<')) { console.error('.env.test NEXT_PUBLIC_SUPABASE_URL not filled in.'); return 1 }
  if (url.includes(PROD)) { console.error(`REFUSING to seed prod (${url}). Point .env.test at a TEST branch.`); return 2 }
  const venueId = env.GOLDEN_TEST_VENUE || '0a17e57e-0000-4000-8000-000000000001'

  const sb = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  // Real venues schema: `name`/`status` (not display_name/active), and `org_id`
  // is required → reuse an existing org to satisfy the constraint.
  const { data: ex } = await sb.from('venues').select('org_id,status').not('org_id', 'is', null).limit(1)
  const orgId = (ex?.[0] as { org_id?: string } | undefined)?.org_id ?? null
  const row: Record<string, unknown> = {
    id: venueId, slug: 'golden-test', name: 'Golden Test Venue',
    status: (ex?.[0] as { status?: string } | undefined)?.status ?? 'active',
  }
  if (orgId) row.org_id = orgId
  const { error } = await sb.from('venues').upsert(row, { onConflict: 'id' })
  if (error) {
    console.error(`seed failed: ${error.message}`)
    console.error('(if the error is about a missing/extra column, tell me the real `venues` columns and I will adjust.)')
    return 1
  }
  console.log(`✓ seeded golden-test venue ${venueId} on ${url}`)
  console.log('Next: npm run test:golden')
  return 0
}

main().then((c) => process.exit(c))
