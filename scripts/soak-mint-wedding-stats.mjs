#!/usr/bin/env node
/**
 * Ad-hoc soak check for mint_wedding_telemetry (mig 320).
 *
 * Mirrors GET /api/admin/mint-wedding-stats but runs against the
 * service-role key directly so it can be invoked from CI / local
 * without an authenticated session.
 *
 * Outputs: total / error rate / p50,p95 latency / source distribution /
 * resolved_via distribution / new-vs-attached / sample errors per window.
 *
 * Used to decide whether email/pipeline.ts is safe to migrate from
 * direct .from('weddings').insert(...) to mintWedding. Healthy signal:
 *   - 50+ successful mints in the last 7d across the already-migrated
 *     sites (brain-dump, crm-import, data-import, reprocess-orphans /
 *     reprocess-form-relays / portal-mint, twilio).
 *   - Error rate < 1%.
 *   - p95 latency stable.
 *   - resolved_via distribution shows the match chain firing
 *     (email_exact / email_canonical / phone / name_plus_date present).
 */

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

// Load .env.local manually — Node doesn't parse dotenv by itself.
const envContent = readFileSync('.env.local', 'utf8')
const env = {}
for (const line of envContent.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (!m) continue
  let value = m[2]
  if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1)
  }
  env[m[1]] = value
}

const url = env.NEXT_PUBLIC_SUPABASE_URL
const key = env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(2)
}

const sb = createClient(url, key)

function percentile(sorted, p) {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return sorted[idx]
}

async function loadWindow(label, sinceIso) {
  const { data, error } = await sb
    .from('mint_wedding_telemetry')
    .select('source, resolved_via, errored, is_new_wedding, latency_ms, error_message, reason, created_at, venue_id')
    .gte('created_at', sinceIso)
    .limit(50000)
  if (error) {
    console.error(`[${label}] read error:`, error.message)
    return
  }
  const rows = data ?? []
  const total = rows.length
  const errors = rows.filter((r) => r.errored).length
  const bySource = {}
  const byResolvedVia = {}
  let newW = 0
  let attached = 0
  const latencies = []
  for (const r of rows) {
    bySource[r.source] = (bySource[r.source] ?? 0) + 1
    if (r.resolved_via) byResolvedVia[r.resolved_via] = (byResolvedVia[r.resolved_via] ?? 0) + 1
    if (r.is_new_wedding === true) newW++
    else if (r.is_new_wedding === false) attached++
    if (typeof r.latency_ms === 'number' && r.latency_ms >= 0) latencies.push(r.latency_ms)
  }
  latencies.sort((a, b) => a - b)
  console.log(`\n=== ${label} (since ${sinceIso}) ===`)
  console.log(`  total: ${total}`)
  console.log(`  errors: ${errors} (${total ? ((errors / total) * 100).toFixed(2) : 0}%)`)
  console.log(`  new_weddings: ${newW}   attached: ${attached}`)
  console.log(`  latency p50: ${percentile(latencies, 0.5)}ms   p95: ${percentile(latencies, 0.95)}ms`)
  console.log(`  by_source:`)
  for (const [k, v] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(28)} ${v}`)
  }
  console.log(`  by_resolved_via:`)
  for (const [k, v] of Object.entries(byResolvedVia).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(28)} ${v}`)
  }
  const errs = rows.filter((r) => r.errored).slice(0, 5)
  if (errs.length > 0) {
    console.log(`  recent errors (first 5):`)
    for (const e of errs) {
      console.log(`    ${e.created_at} source=${e.source} reason=${e.reason} venue=${e.venue_id}`)
      console.log(`      ${e.error_message}`)
    }
  }
}

const now = new Date()
const _24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
const _7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
const _30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()

await loadWindow('24h', _24h)
await loadWindow('7d', _7d)
await loadWindow('30d', _30d)

console.log('\nDone.')
