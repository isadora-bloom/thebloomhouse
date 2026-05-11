/**
 * End-to-end clusterer test against Rixey.
 *
 * Usage:
 *   npx tsx scripts/test-wave10-clusterer.ts
 *
 * Runs crossPlatformHandleMerge + clusterProposalsByPerson against Rixey
 * and prints the top clusters with handle breakdown so we can confirm
 * the Jamie B-style multi-handle cases get collapsed.
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { crossPlatformHandleMerge } from '../src/lib/services/identity/handle-convergence'
import { clusterProposalsByPerson } from '../src/lib/services/identity/decision-clustering/cluster-proposals'

function loadEnv() {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  try {
    const raw = readFileSync('.env.local', 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {}
  return env
}

async function main() {
  const env = loadEnv()
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

  const { data: venues } = await sb.from('venues').select('id, name').ilike('name', '%rixey%').limit(1)
  const rixey = venues?.[0]
  if (!rixey) {
    console.log('No Rixey venue found')
    process.exit(0)
  }
  console.log('Running against:', rixey.id, rixey.name)

  const t0 = Date.now()
  const proposals = await crossPlatformHandleMerge(sb as any, rixey.id)
  const t1 = Date.now()
  console.log(`crossPlatformHandleMerge: ${proposals.proposals.length} proposals in ${t1 - t0}ms (${proposals.handlesInspected} handles inspected)`)

  if (proposals.proposals.length === 0) {
    console.log('\nNo proposals to cluster. Done.')
    return
  }

  // Print top 5 raw proposals
  console.log('\n--- Top 5 raw proposals ---')
  for (const p of proposals.proposals.slice(0, 5)) {
    console.log(`  @${p.handle} score=${p.score} platforms=[${p.platforms.join(', ')}] mixed=${p.mixed} records=${p.records.length}`)
  }

  // No LLM judge — the deterministic path
  const t2 = Date.now()
  const cluster = await clusterProposalsByPerson({
    proposals: proposals.proposals,
    supabase: sb as any,
    venueId: rixey.id,
    enableLLMJudge: false,
  })
  const t3 = Date.now()
  console.log(`\nclusterProposalsByPerson: ${cluster.clusters.length} clusters in ${t3 - t2}ms (LLM judge: ${cluster.llmJudgeInvocations})`)

  console.log('\n--- Top 10 clusters ---')
  for (const c of cluster.clusters.slice(0, 10)) {
    console.log(`\n[${c.aggregateScore}] ${c.displayName} (key=${c.clusterKey.slice(0, 30)}${c.clusterKey.length > 30 ? '…' : ''})`)
    console.log(`  total_records=${c.totalRecords} handles=${c.handles.length} canonical=${c.canonicalPersonId?.slice(0, 8) ?? '(none)'}`)
    for (const h of c.handles.slice(0, 4)) {
      console.log(`    - @${h.handle} (${h.platforms.join('/')}) score=${h.score} records=${h.recordCount}`)
    }
    if (c.handles.length > 4) console.log(`    ... +${c.handles.length - 4} more`)
  }

  // Histogram: clusters with N handles
  const histo = new Map<number, number>()
  for (const c of cluster.clusters) {
    histo.set(c.handles.length, (histo.get(c.handles.length) ?? 0) + 1)
  }
  console.log('\n--- Cluster size distribution ---')
  for (const [size, count] of [...histo.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${size} handle${size === 1 ? '' : 's'}: ${count} cluster${count === 1 ? '' : 's'}`)
  }

  // Multi-handle clusters = the Jamie B case Wave 10 closes
  const multi = cluster.clusters.filter((c) => c.handles.length >= 2)
  console.log(`\nMulti-handle clusters (>=2 handles): ${multi.length} — these are the Jamie B-style cases that collapse from N decisions to 1`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
