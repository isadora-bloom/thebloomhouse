#!/usr/bin/env node
/**
 * Cross-check: which paths are minting weddings? Compares
 *   - mint_wedding_telemetry row count (counts callers of mintWedding)
 *   - weddings.created_at row count in same window (counts ALL mints)
 *   - weddings.source_provenance distribution (which write path)
 *
 * If telemetry is empty but weddings.created_at has rows, then
 * mintWedding is being bypassed by SOME caller. That's actionable.
 */

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const envContent = readFileSync('.env.local', 'utf8')
const env = {}
for (const line of envContent.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (!m) continue
  let value = m[2]
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
  env[m[1]] = value
}

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

async function windowReport(label, since) {
  // 1. Telemetry rows
  const { count: telemetryCount, error: terr } = await sb
    .from('mint_wedding_telemetry')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', since)
  if (terr) console.error(`  telemetry table read err:`, terr.message)

  // 2. Weddings created in window
  const { data: weddings, error: werr } = await sb
    .from('weddings')
    .select('id, venue_id, source_provenance, source, created_at, inquiry_date')
    .gte('created_at', since)
    .limit(2000)
  if (werr) {
    console.error(`  weddings read err:`, werr.message)
    return
  }
  const total = weddings?.length ?? 0
  const byProvenance = {}
  const bySource = {}
  for (const w of weddings ?? []) {
    const p = w.source_provenance ?? '(null)'
    byProvenance[p] = (byProvenance[p] ?? 0) + 1
    const s = w.source ?? '(null)'
    bySource[s] = (bySource[s] ?? 0) + 1
  }

  console.log(`\n=== ${label} (since ${since}) ===`)
  console.log(`  mint_wedding_telemetry rows: ${telemetryCount ?? 'err'}`)
  console.log(`  weddings.created_at rows: ${total}`)
  if (total > 0) {
    const gap = total - (telemetryCount ?? 0)
    console.log(`  BYPASSING mintWedding: ${gap > 0 ? `~${gap} (gap)` : 'none'}`)
    console.log(`  by source_provenance:`)
    for (const [k, v] of Object.entries(byProvenance).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k.padEnd(28)} ${v}`)
    }
    console.log(`  by source:`)
    for (const [k, v] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k.padEnd(28)} ${v}`)
    }
  }
}

const now = new Date()
await windowReport('24h', new Date(now.getTime() - 24 * 3600 * 1000).toISOString())
await windowReport('7d', new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString())
await windowReport('30d', new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString())
