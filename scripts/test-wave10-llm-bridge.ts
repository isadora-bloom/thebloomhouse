/**
 * Verify the LLM bridge judge in the cluster service fires correctly.
 *
 * Uses synthetic HandleMergeProposal data (no DB reads) to drive
 * clusterProposalsByPerson with the bridge case:
 *   - Cluster A: handle "madison" on Pinterest, person Madison Bryant
 *   - Cluster B: handle "madisonb" on Knot, person (unknown) Madison Bryant
 *   - No shared person id → only the LLM bridge can link them.
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
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
  const { data: venues } = await sb.from('venues').select('id').ilike('name', '%rixey%').limit(1)
  const rixey = venues?.[0]
  if (!rixey) {
    console.log('No Rixey venue')
    process.exit(0)
  }

  // Build synthetic proposals where there is NO shared people id but
  // strong name overlap.
  const fakeProposals = [
    {
      handle: 'madisonb',
      records: [
        {
          kind: 'candidate_identities' as const,
          recordId: 'orphan-signal:fake-a',
          rawHandle: 'madisonb',
          normalizedHandle: 'madisonb',
          platform: 'pinterest',
          firstName: 'Madison',
          lastName: 'Bryant',
          email: null,
        },
      ],
      platforms: ['pinterest'],
      score: 60,
      reasoning: ['synthetic A'],
      mixed: false,
    },
    {
      handle: 'madison_b',
      records: [
        {
          kind: 'candidate_identities' as const,
          recordId: 'orphan-signal:fake-b',
          rawHandle: 'madison_b',
          normalizedHandle: 'madison_b',
          platform: 'theknot',
          firstName: 'Madison',
          lastName: 'B',
          email: null,
        },
      ],
      platforms: ['theknot'],
      score: 55,
      reasoning: ['synthetic B'],
      mixed: false,
    },
  ]

  console.log('Running clusterProposalsByPerson with LLM judge enabled...')
  const t0 = Date.now()
  const result = await clusterProposalsByPerson({
    proposals: fakeProposals as any,
    supabase: sb as any,
    venueId: rixey.id,
    enableLLMJudge: true,
  })
  const t1 = Date.now()
  console.log(`elapsed: ${t1 - t0}ms`)
  console.log(`LLM judge invocations: ${result.llmJudgeInvocations}`)
  console.log(`Clusters: ${result.clusters.length}`)
  for (const c of result.clusters) {
    console.log(`\n  [${c.aggregateScore}] ${c.displayName} (key=${c.clusterKey})`)
    console.log(`    llmBridged: ${c.llmBridged}, confidence: ${c.llmConfidence}`)
    for (const h of c.handles) {
      console.log(`    - @${h.handle} (${h.platforms.join(', ')}) score=${h.score}`)
    }
  }

  // Check api_costs row exists for this call (cost audit)
  console.log('\nMost-recent cluster_bridge_judge api_costs row:')
  const { data: cost } = await sb
    .from('api_costs')
    .select('created_at, model_used, total_cost_usd, prompt_version, task_type')
    .eq('task_type', 'cluster_bridge_judge')
    .order('created_at', { ascending: false })
    .limit(1)
  console.log(JSON.stringify(cost, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
