/**
 * Read-only migration state check.
 *
 * Probes the live Supabase via REST to confirm whether migrations
 * 114–119 have been applied. Each migration adds columns or
 * constraints; we test by attempting a SELECT on the new column
 * and checking the response shape.
 *
 * Run with: npx tsx scripts/check-migration-state.ts
 *
 * Idempotent / read-only. Does NOT modify any data.
 */

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

// Load .env.local manually — dotenv isn't a dep. Same pattern other
// scripts in this repo use (e.g., scripts/e2e-data-flow-test.mjs).
function loadEnv(): Record<string, string> {
  try {
    const text = readFileSync('.env.local', 'utf-8')
    const out: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq < 0) continue
      const key = trimmed.slice(0, eq).trim()
      let val = trimmed.slice(eq + 1).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      out[key] = val
    }
    return out
  } catch {
    return {}
  }
}

const env = loadEnv()
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

interface CheckResult {
  migration: string
  description: string
  applied: boolean
  detail: string
}

async function checkColumnExists(table: string, column: string): Promise<{ exists: boolean; detail: string }> {
  // Probe by selecting only that column with limit 1.
  const { error } = await supabase.from(table).select(column).limit(1)
  if (error) {
    // PostgREST returns code 42703 (undefined column) when the column
    // doesn't exist. Other errors mean the table itself is missing
    // or RLS is blocking the read — which is still a clear "not in
    // applied state."
    return {
      exists: false,
      detail: `${error.code ?? 'err'}: ${error.message}`.slice(0, 120),
    }
  }
  return { exists: true, detail: 'column present' }
}

async function main(): Promise<void> {
  const checks: CheckResult[] = []

  // Migration 114: drafts.follow_up_step
  const m114 = await checkColumnExists('drafts', 'follow_up_step')
  checks.push({
    migration: '114',
    description: 'drafts.follow_up_step',
    applied: m114.exists,
    detail: m114.detail,
  })

  // Migration 115: venue_config.daily_cost_ceiling_cents + autonomous_paused
  const m115a = await checkColumnExists('venue_config', 'daily_cost_ceiling_cents')
  const m115b = await checkColumnExists('venue_config', 'autonomous_paused')
  checks.push({
    migration: '115',
    description: 'venue_config.daily_cost_ceiling_cents + autonomous_paused',
    applied: m115a.exists && m115b.exists,
    detail: `ceiling=${m115a.detail}; paused=${m115b.detail}`,
  })

  // Migration 116: engagement_events.direction
  const m116 = await checkColumnExists('engagement_events', 'direction')
  checks.push({
    migration: '116',
    description: 'engagement_events.direction (NOT NULL CHECK)',
    applied: m116.exists,
    detail: m116.detail,
  })

  // Migration 117: api_costs.content_tier
  const m117 = await checkColumnExists('api_costs', 'content_tier')
  checks.push({
    migration: '117',
    description: 'api_costs.content_tier',
    applied: m117.exists,
    detail: m117.detail,
  })

  console.log('\nMigration state check (read-only, against live Supabase):\n')
  console.log('Migration | Status      | Description')
  console.log('----------|-------------|---------------------------------------------')
  for (const c of checks) {
    const status = c.applied ? '✓ applied  ' : '✗ NOT applied'
    console.log(`${c.migration.padEnd(9)} | ${status} | ${c.description}`)
    if (!c.applied) {
      console.log(`          | detail: ${c.detail}`)
    }
  }

  console.log(`
Migration 118 + 119 (triggers): cannot verify via REST alone. To
verify manually after applying, run:

  SELECT trigger_name FROM information_schema.triggers
   WHERE event_object_table='weddings' AND trigger_name LIKE '%inquiry_date%';

Expected: weddings_inquiry_date_recompute_state (118 superseded by 119)
`)

  const allApplied = checks.every((c) => c.applied)
  console.log(`Overall: ${allApplied ? 'ALL applied' : 'SOME PENDING — see above'}\n`)
  process.exit(allApplied ? 0 : 1)
}

main().catch((err) => {
  console.error('check failed:', err)
  process.exit(1)
})
